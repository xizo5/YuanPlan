import pg from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { hostname, userInfo } from 'node:os';
import { z } from 'zod';

const fileSchema = z.object({ storageKey: z.uuid(), size: z.number().int().nonnegative().safe(), checksum: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const manifestSchema = z.object({
  format: z.literal(1), appVersion: z.literal('0.1.0'), createdAt: z.iso.datetime(),
  authSecretHash: z.string().regex(/^[a-f0-9]{64}$/), databaseChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  migrations: z.array(z.object({ name: z.string(), checksum: z.string() }).strict()),
  files: z.array(fileSchema),
}).strict();
type Connection = { databaseUrl: string };
type Storage = Connection & { uploadDir: string; authSecret: string };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const inside = (root: string, path: string) => { const rel = relative(root, path); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };

async function checksum(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function regular(path: string) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Backup objects must be regular files');
  return stat;
}
function pgEnvironment(databaseUrl: string) {
  const url = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('PostgreSQL URL required');
  const env: NodeJS.ProcessEnv = { ...process.env, PGHOST: url.hostname.replace(/^\[|\]$/g, ''), PGPORT: url.port || '5432', PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGCONNECT_TIMEOUT: '10' };
  const options: Record<string, string> = { sslmode: 'PGSSLMODE', sslrootcert: 'PGSSLROOTCERT', sslcert: 'PGSSLCERT', sslkey: 'PGSSLKEY', connect_timeout: 'PGCONNECT_TIMEOUT', application_name: 'PGAPPNAME' };
  // Do not accidentally inherit an unrelated connection or TLS policy.
  for (const key of ['PGSERVICE', 'PGSERVICEFILE', 'PGOPTIONS', ...Object.values(options)]) delete env[key];
  env.PGCONNECT_TIMEOUT = '10';
  for (const [key, value] of url.searchParams) {
    if (!options[key]) throw new Error('Unsupported PostgreSQL backup connection option');
    env[options[key]] = value;
  }
  return env;
}
async function pgTool(tool: 'pg_dump' | 'pg_restore', args: string[], databaseUrl: string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.env[tool === 'pg_dump' ? 'PG_DUMP_BIN' : 'PG_RESTORE_BIN'] || tool, args, {
      env: pgEnvironment(databaseUrl), windowsHide: true, stdio: 'ignore', shell: false,
    });
    child.once('error', () => reject(new Error(`${tool} could not start; check PostgreSQL client installation`)));
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`${tool} failed; check client version, database access and available disk space`)));
  });
}
async function connection(databaseUrl: string) {
  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10000 });
  await client.connect(); return client;
}

export async function maintenance({ databaseUrl, enabled }: Connection & { enabled: boolean }) {
  const client = await connection(databaseUrl);
  try {
    const result = await client.query('UPDATE instance_settings SET maintenance=$1 WHERE id=1 RETURNING maintenance', [enabled]);
    if (result.rowCount !== 1) throw new Error('Migrate the database before changing maintenance mode');
    return { maintenance: enabled, at: new Date().toISOString(), operator: userInfo().username, host: hostname() };
  } finally { await client.end(); }
}

export async function backup({ databaseUrl, uploadDir, authSecret, output }: Storage & { output: string }) {
  if (authSecret.length < 32) throw new Error('A valid AUTH_SECRET is required');
  await mkdir(uploadDir, { recursive: true });
  const root = await realpath(uploadDir);
  await mkdir(dirname(resolve(output)), { recursive: true });
  const destination = resolve(await realpath(dirname(resolve(output))), basename(resolve(output)));
  if (inside(root, destination)) throw new Error('Backup output must be outside UPLOAD_DIR');
  const client = await connection(databaseUrl);
  try {
    // Block migrations and cooperate with upload/cleanup. The exported snapshot
    // makes pg_dump and this manifest observe exactly the same committed rows.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await client.query('SELECT pg_advisory_xact_lock(591337)');
    if (!(await client.query('SELECT maintenance FROM instance_settings WHERE id=1')).rows[0]?.maintenance) throw new Error('Enable maintenance mode before backup');
    await client.query('SELECT pg_advisory_xact_lock(591339)');
    const snapshot = (await client.query('SELECT pg_export_snapshot() AS snapshot')).rows[0].snapshot;
    const migrations = (await client.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows;
    const files = (await client.query('SELECT storage_key AS "storageKey",size::float8 AS size,checksum FROM files ORDER BY storage_key')).rows.map(value => fileSchema.parse(value));
    await mkdir(destination, { mode: 0o700 }); // Never overwrite an existing backup, even an incomplete one.
    await mkdir(resolve(destination, 'uploads'), { mode: 0o700 });
    await pgTool('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', `--snapshot=${snapshot}`, '--file', resolve(destination, 'database.dump')], databaseUrl);
    for (const file of files) {
      const source = resolve(root, file.storageKey);
      const target = resolve(destination, 'uploads', file.storageKey);
      if ((await regular(source)).size !== file.size) throw new Error('Attachment size differs from database metadata');
      await copyFile(source, target, constants.COPYFILE_EXCL);
      if (await checksum(target) !== file.checksum) throw new Error('Attachment checksum differs from database metadata');
    }
    const manifest = { format: 1 as const, appVersion: '0.1.0' as const, createdAt: new Date().toISOString(), authSecretHash: digest(authSecret), databaseChecksum: await checksum(resolve(destination, 'database.dump')), migrations, files };
    // A missing manifest marks an interrupted/incomplete backup.
    await writeFile(resolve(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await client.query('COMMIT');
    return { output: destination, files: files.length, migrations: migrations.length, maintenance: true };
  } finally { await client.query('ROLLBACK').catch(() => {}); await client.end(); }
}

export async function restore({ databaseUrl, uploadDir, authSecret, input }: Storage & { input: string }) {
  const source = await realpath(input);
  await regular(resolve(source, 'manifest.json'));
  const manifest = manifestSchema.parse(JSON.parse(await readFile(resolve(source, 'manifest.json'), 'utf8')));
  if (manifest.authSecretHash !== digest(authSecret)) throw new Error('AUTH_SECRET must match the backed-up instance');
  await regular(resolve(source, 'database.dump'));
  if (await checksum(resolve(source, 'database.dump')) !== manifest.databaseChecksum) throw new Error('Database dump checksum mismatch');
  if (new Set(manifest.files.map(file => file.storageKey)).size !== manifest.files.length) throw new Error('Duplicate backup attachment');
  const backupUploads = await realpath(resolve(source, 'uploads'));
  if (!inside(source, backupUploads)) throw new Error('Backup attachment directory escapes the backup');
  for (const file of manifest.files) {
    const path = resolve(backupUploads, file.storageKey);
    if ((await regular(path)).size !== file.size || await checksum(path) !== file.checksum) throw new Error('Backup attachment checksum mismatch');
  }
  await mkdir(uploadDir, { recursive: true });
  const destination = await realpath(uploadDir);
  if (inside(source, destination) || inside(destination, source)) throw new Error('Restore destination overlaps backup input');
  const client = await connection(databaseUrl);
  try {
    await client.query('SELECT pg_advisory_lock(591340)');
    const existing = await client.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','S','f') LIMIT 1");
    if (existing.rowCount || (await readdir(destination)).length) throw new Error('Restore requires an empty database and empty UPLOAD_DIR');
    // Leave evidence if any file copy or restore fails; do not delete or overwrite
    // a partially restored target automatically.
    const marker = resolve(destination, 'RESTORE_INCOMPLETE');
    await writeFile(marker, randomUUID(), { flag: 'wx', mode: 0o600 });
    for (const file of manifest.files) {
      const target = resolve(destination, file.storageKey);
      await copyFile(resolve(backupUploads, file.storageKey), target, constants.COPYFILE_EXCL);
      if (await checksum(target) !== file.checksum) throw new Error('Restored attachment checksum mismatch');
    }
    await pgTool('pg_restore', ['--single-transaction', '--exit-on-error', '--no-owner', '--no-privileges', '--dbname', decodeURIComponent(new URL(databaseUrl).pathname.slice(1)), resolve(source, 'database.dump')], databaseUrl);
    const migrations = (await client.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows;
    const files = (await client.query('SELECT storage_key AS "storageKey",size::float8 AS size,checksum FROM files ORDER BY storage_key')).rows;
    if (JSON.stringify(migrations) !== JSON.stringify(manifest.migrations) || JSON.stringify(files) !== JSON.stringify(manifest.files)) throw new Error('Restored database differs from backup manifest');
    if (!(await client.query('SELECT maintenance FROM instance_settings WHERE id=1')).rows[0]?.maintenance) throw new Error('Restored instance must remain in maintenance mode');
    const { unlink } = await import('node:fs/promises');
    await unlink(marker);
    return { files: files.length, migrations: migrations.length, maintenance: true };
  } finally { await client.query('SELECT pg_advisory_unlock(591340)').catch(() => {}); await client.end(); }
}
