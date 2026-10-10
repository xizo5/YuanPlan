import { randomUUID, createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config.js';
import { db, rows, one } from '../db/index.js';
import { digest } from '../lib/crypto.js';
import { assert } from '../lib/errors.js';
import { liveUser, mutate, access, audit, type Actor } from './core.js';

export async function credentialActor(value: string): Promise<Actor> {
  const credential = await one<{ id: string; userId: string }>(db, sql`SELECT id,user_id FROM api_credentials WHERE token_hash=${digest(value)} AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())`);
  assert(credential, 401, 'INVALID_CREDENTIAL', '凭据无效或已撤销');
  const actor: Actor = { userId: credential.userId, credentialId: credential.id, source: 'mcp' }; await liveUser(db, actor); return actor;
}
export async function listCredentials(actor: Actor) { await liveUser(db, actor); return rows(db, sql`SELECT c.id,c.name,c.prefix,c.scope,c.expires_at,c.revoked_at,c.created_at,COALESCE(json_agg(cp.project_id) FILTER(WHERE cp.project_id IS NOT NULL),'[]') project_ids FROM api_credentials c LEFT JOIN credential_projects cp ON cp.credential_id=c.id WHERE c.user_id=${actor.userId} GROUP BY c.id ORDER BY c.created_at DESC`); }
const inputSchema = z.object({ name: z.string().trim().min(1).max(100), projectIds: z.array(z.string().uuid()).min(1).max(100), scope: z.enum(['read','write']), expiresAt: z.iso.datetime().nullable().default(null) }).strict();
export async function createCredential(actor: Actor, input: unknown, op: string) {
  const data = inputSchema.parse(input); if (data.expiresAt) assert(Date.parse(data.expiresAt) > Date.now(), 400, 'INVALID_EXPIRY', '有效期必须晚于当前时间');
  const value = 'yp_' + createHmac('sha256', config.AUTH_SECRET).update(`credential:${actor.userId}:${op}`).digest('base64url');
  const result = await mutate(actor, null, 'write', op, { action: 'create_credential', data }, async ctx => {
    for (const id of data.projectIds) await access(ctx.tx, actor, id, data.scope === 'write' ? 'write' : 'read');
    const id = randomUUID();
    await ctx.tx.execute(sql`INSERT INTO api_credentials(id,user_id,name,token_hash,prefix,scope,expires_at) VALUES(${id},${actor.userId},${data.name},${digest(value)},${value.slice(0,10)},${data.scope},${data.expiresAt})`);
    for (const p of [...new Set(data.projectIds)]) await ctx.tx.execute(sql`INSERT INTO credential_projects(credential_id,project_id) VALUES(${id},${p})`);
    await audit(ctx, 'credential', id, 'create', null, { name: data.name, projectIds: data.projectIds, scope: data.scope }); return { id };
  });
  return { ...result, token: value };
}
export async function revokeCredential(actor: Actor, id: string, op: string) {
  return mutate(actor, null, 'write', op, { action: 'revoke_credential', id }, async ctx => {
    const row = await one(ctx.tx, sql`UPDATE api_credentials SET revoked_at=now() WHERE id=${id} AND user_id=${actor.userId} RETURNING id`); assert(row, 404, 'NOT_FOUND', '凭据不存在');
    await audit(ctx, 'credential', id, 'revoke', null, { revoked: true }); return { ok: true };
  });
}
