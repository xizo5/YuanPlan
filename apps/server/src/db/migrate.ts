import 'dotenv/config';
import pg from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
export async function migrate(url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL) {
  if (!url) throw new Error('MIGRATION_DATABASE_URL or DATABASE_URL required');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock(591337)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    const dir = fileURLToPath(new URL('../../migrations/', import.meta.url));
    for (const name of (await readdir(dir)).filter(n => n.endsWith('.sql')).sort()) {
      const body = await readFile(`${dir}/${name}`, 'utf8');
      const checksum = createHash('sha256').update(body).digest('hex');
      const existing = await client.query('SELECT checksum FROM schema_migrations WHERE name=$1', [name]);
      if (existing.rowCount) { if (existing.rows[0].checksum !== checksum) throw new Error(`Applied migration changed: ${name}`); continue; }
      await client.query('BEGIN');
      try { await client.query(body); await client.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)', [name, checksum]); await client.query('COMMIT'); }
      catch (error) { await client.query('ROLLBACK'); throw error; }
      console.log(`Applied ${name}`);
    }
  } finally { await client.query('SELECT pg_advisory_unlock(591337)').catch(() => {}); await client.end(); }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await migrate();
