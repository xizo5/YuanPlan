import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { type SQL } from 'drizzle-orm';
import * as schema from './schema.js';
import { config } from '../config.js';
export const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 });
export const db = drizzle(pool, { schema });
export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type Database = typeof db | Transaction;
export async function rows<T = Record<string, unknown>>(database: Database, query: SQL): Promise<T[]> {
  const result = await database.execute(query);
  return result.rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), value]))) as T[];
}
export async function one<T = Record<string, unknown>>(database: Database, query: SQL): Promise<T | undefined> { return (await rows<T>(database, query))[0]; }
