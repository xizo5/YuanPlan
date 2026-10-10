import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import pg from 'pg';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, cp } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { backup, restore, maintenance } from '../apps/server/src/modules/backup';
import { migrate } from '../apps/server/src/db/migrate';
import { app } from '../apps/server/src/app';
import { config } from '../apps/server/src/config';
import { pool } from '../apps/server/src/db';

const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
const names: string[] = [];
const secret = 'backup-test-secret-'.repeat(3);
const fileId = randomUUID();
const bytes = Buffer.from('历史版本仍引用的附件\n');
let folder: string, sourceUrl: string, source: pg.Client, uploadDir: string, archive: string;
async function database() {
  const name = `yp_restore_${randomUUID().replaceAll('-', '')}_test`;
  await admin.query(`CREATE DATABASE "${name}"`); names.push(name);
  const url = new URL(process.env.TEST_DATABASE_URL!); url.pathname = `/${name}`;
  return url.toString();
}
async function rows(client: pg.Client) {
  const tables = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  const output: Record<string, string[]> = {};
  for (const { tablename } of tables) {
    if (!/^[a-z_]+$/.test(tablename)) throw new Error('Unexpected table name');
    output[tablename] = (await client.query(`SELECT to_jsonb(t) AS value FROM "${tablename}" t`)).rows.map(row => JSON.stringify(row.value)).sort();
  }
  return output;
}
beforeAll(async () => {
  await admin.connect();
  await mkdir('.data', { recursive: true }); folder = await mkdtemp(resolve('.data/backup-test-'));
  uploadDir = resolve(folder, 'source-uploads'); await mkdir(uploadDir);
  archive = resolve(folder, 'backup'); sourceUrl = await database(); await migrate(sourceUrl);
  source = new pg.Client({ connectionString: sourceUrl }); await source.connect();
  const user = randomUUID(), project = randomUUID(), task = randomUUID(), document = randomUUID(), event = randomUUID(), credential = randomUUID();
  await source.query("INSERT INTO users(id,name,email,identity_source) VALUES($1,'Restore user',$2,'invite')", [user, `${user}@example.test`]);
  await source.query("INSERT INTO projects(id,name,creator_id) VALUES($1,'Restore project',$2)", [project, user]);
  await source.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'admin')", [project, user]);
  await source.query("INSERT INTO tasks(id,project_id,number,title,description,creator_id) VALUES($1,$2,1,'Restore task','{}',$3)", [task, project, user]);
  await source.query("INSERT INTO documents(id,project_id,title,content,creator_id) VALUES($1,$2,'Restore Wiki','{}',$3)", [document, project, user]);
  await source.query("INSERT INTO audit_events(id,project_id,resource_type,resource_id,operation,actor_id,actor_name,source,operation_id,after_version) VALUES($1,$2,'document',$3,'create',$4,'Restore user','web',$5,1)", [event, project, document, user, randomUUID()]);
  await source.query("INSERT INTO resource_versions(id,project_id,resource_type,resource_id,version,snapshot,audit_id) VALUES($1,$2,'document',$3,1,$4,$5)", [randomUUID(), project, document, JSON.stringify({ fileId, title: 'Historical content' }), event]);
  await source.query("INSERT INTO files(id,project_id,uploader_id,name,mime_type,size,storage_key,checksum) VALUES($1,$2,$3,'history.txt','text/plain',$4,$6,$5)", [fileId, project, user, bytes.length, createHash('sha256').update(bytes).digest('hex'), fileId]);
  await source.query("INSERT INTO resource_attachments(id,project_id,file_id,resource_type,resource_id,removed_at) VALUES($1,$2,$3,'document',$4,now())", [randomUUID(), project, fileId, document]);
  await source.query("INSERT INTO invitations(id,target_type,project_id,email,role,inviter_id,token_hash,expires_at) VALUES($1,'project',$2,'invite@example.test','member',$3,$4,now()+interval '1 day')", [randomUUID(), project, user, randomUUID()]);
  await source.query("INSERT INTO api_credentials(id,user_id,name,token_hash,prefix,scope) VALUES($1,$2,'Restore key',$3,'yp_test','read')", [credential, user, randomUUID()]);
  await source.query('INSERT INTO credential_projects(credential_id,project_id) VALUES($1,$2)', [credential, project]);
  await writeFile(resolve(uploadDir, fileId), bytes);
  await writeFile(resolve(uploadDir, randomUUID()), 'unregistered object');
});
afterAll(async () => {
  await source?.end(); await pool.end();
  for (const name of names) {
    if (!/^yp_restore_[a-f0-9]{32}_test$/.test(name)) throw new Error('Refusing unsafe test database cleanup');
    await admin.query(`DROP DATABASE "${name}"`);
  }
  await admin.end();
  if (folder) {
    const rel = relative(resolve('.data'), resolve(folder));
    if (!/^backup-test-[^/\\]+$/.test(rel)) throw new Error('Refusing cleanup outside test workspace');
    await rm(folder, { recursive: true });
  }
});

it('requires maintenance and restores every table and historical attachment into a new database', async () => {
  await expect(backup({ databaseUrl: sourceUrl, uploadDir, authSecret: secret, output: archive })).rejects.toThrow('maintenance');
  await maintenance({ databaseUrl: sourceUrl, enabled: true });
  const expected = await rows(source);
  expect(await backup({ databaseUrl: sourceUrl, uploadDir, authSecret: secret, output: archive })).toMatchObject({ files: 1, maintenance: true });
  expect(await readdir(resolve(archive, 'uploads'))).toEqual([fileId]);
  expect(await readFile(resolve(archive, 'manifest.json'), 'utf8')).not.toContain(secret);
  const targetUrl = await database(), targetDir = resolve(folder, 'restored');
  expect(await restore({ databaseUrl: targetUrl, uploadDir: targetDir, authSecret: secret, input: archive })).toMatchObject({ files: 1, maintenance: true });
  const target = new pg.Client({ connectionString: targetUrl }); await target.connect();
  try { expect(await rows(target)).toEqual(expected); }
  finally { await target.end(); }
  expect(await readFile(resolve(targetDir, fileId))).toEqual(bytes);
  await expect(restore({ databaseUrl: targetUrl, uploadDir: targetDir, authSecret: secret, input: archive })).rejects.toThrow('empty');
  await expect(backup({ databaseUrl: sourceUrl, uploadDir, authSecret: secret, output: archive })).rejects.toThrow();
});

it('rejects wrong secrets and corrupt backups before writing the target database or uploads', async () => {
  const targetUrl = await database(); const targetDir = resolve(folder, 'rejected');
  await expect(restore({ databaseUrl: targetUrl, uploadDir: targetDir, authSecret: 'wrong', input: archive })).rejects.toThrow('AUTH_SECRET');
  const corrupt = resolve(folder, 'corrupt'); await cp(archive, corrupt, { recursive: true });
  await writeFile(resolve(corrupt, 'uploads', fileId), 'tampered');
  await expect(restore({ databaseUrl: targetUrl, uploadDir: targetDir, authSecret: secret, input: corrupt })).rejects.toThrow('checksum');
  await writeFile(resolve(corrupt, 'uploads', fileId), bytes);
  await writeFile(resolve(corrupt, 'database.dump'), 'corrupt dump');
  await expect(restore({ databaseUrl: targetUrl, uploadDir: targetDir, authSecret: secret, input: corrupt })).rejects.toThrow('checksum');
  const target = new pg.Client({ connectionString: targetUrl }); await target.connect();
  try { expect(await rows(target)).toEqual({}); } finally { await target.end(); }
});

it('waits for the upload maintenance lock before producing a completed backup', async () => {
  const locker = new pg.Client({ connectionString: sourceUrl }); await locker.connect();
  const output = resolve(folder, 'queued'); let pending: Promise<unknown> | undefined;
  try {
    await locker.query('BEGIN'); await locker.query('SELECT pg_advisory_xact_lock_shared(591339)');
    pending = backup({ databaseUrl: sourceUrl, uploadDir, authSecret: secret, output });
    await vi.waitFor(async () => {
      const waiting = await source.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=591339 AND NOT granted");
      expect(waiting.rowCount).toBeGreaterThan(0);
    });
    await locker.query('COMMIT'); await pending;
    expect(JSON.parse(await readFile(resolve(output, 'manifest.json'), 'utf8')).files).toHaveLength(1);
  } finally { await locker.query('ROLLBACK'); await locker.end(); await pending; }
});

it('keeps maintenance enabled and never marks a failed dump as a complete backup', async () => {
  const old = process.env.PG_DUMP_BIN; process.env.PG_DUMP_BIN = resolve(folder, 'missing-pg-dump');
  const output = resolve(folder, 'failed');
  try { await expect(backup({ databaseUrl: sourceUrl, uploadDir, authSecret: secret, output })).rejects.toThrow('could not start'); }
  finally { if (old === undefined) delete process.env.PG_DUMP_BIN; else process.env.PG_DUMP_BIN = old; }
  expect(await readdir(output)).not.toContain('manifest.json');
  expect((await source.query('SELECT maintenance FROM instance_settings')).rows[0].maintenance).toBe(true);
});

it('returns maintenance errors for browser and MCP requests while health remains available', async () => {
  await migrate(process.env.TEST_DATABASE_URL);
  await maintenance({ databaseUrl: process.env.TEST_DATABASE_URL!, enabled: true });
  try {
    expect((await app.request(`${config.APP_URL}/api/health`)).status).toBe(200);
    for (const path of ['/api/public/state', '/api/me', '/api/mcp']) {
      const response = await app.request(`${config.APP_URL}${path}`);
      expect(response.status).toBe(503); expect(response.headers.get('Retry-After')).toBe('60');
      expect((await response.json()).error.code).toBe('MAINTENANCE');
    }
  } finally { await maintenance({ databaseUrl: process.env.TEST_DATABASE_URL!, enabled: false }); }
});
