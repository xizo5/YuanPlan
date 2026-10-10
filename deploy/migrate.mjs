import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { migrate } from '../apps/server/dist/db/migrate.js';

try {
  await migrate(process.env.MIGRATION_DATABASE_URL);
  const client = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await client.connect();
  try { await client.query(await readFile(new URL('./grant-runtime.sql', import.meta.url), 'utf8')); }
  finally { await client.end(); }
} catch {
  console.error('Migration or runtime grants failed. Keep the application stopped and check the database and migration history.');
  process.exitCode = 1;
}
