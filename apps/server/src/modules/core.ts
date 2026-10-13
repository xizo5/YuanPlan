import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { db, rows, one, type Database, type Transaction } from '../db/index.js';
import { assert, AppError } from '../lib/errors.js';
import { digest } from '../lib/crypto.js';
import type { Role, User } from '@yuanplan/contracts';
import { operationKeySchema } from '@yuanplan/contracts';

export type Actor = { userId: string; source: 'web' | 'mcp' | 'system'; credentialId?: string };
export type Context = { tx: Transaction; actor: Actor; user: User; operationId: string; projectId: string | null };
export async function liveUser(database: Database, actor: Actor, lock = false): Promise<User> {
  const user = await one<User>(database, sql`SELECT * FROM users WHERE id=${actor.userId} ${lock ? sql`FOR SHARE` : sql``}`);
  assert(user && !user.disabled, 401, 'UNAUTHENTICATED', '请重新登录');
  if (actor.credentialId) {
    const credential = await one(database, sql`SELECT id FROM api_credentials WHERE id=${actor.credentialId} AND user_id=${actor.userId} AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now()) ${lock ? sql`FOR SHARE` : sql``}`);
    assert(credential, 401, 'INVALID_CREDENTIAL', '凭据已过期或撤销');
  }
  return user;
}
export async function access(database: Database, actor: Actor, projectId: string, mode: 'read' | 'write' | 'admin' = 'read', options: { lock?: boolean; includeDeleted?: boolean; allowArchived?: boolean } = {}) {
  const project = await one<{ id: string; archivedAt: Date | null; deletedAt: Date | null }>(database, sql`SELECT id,archived_at,deleted_at FROM projects WHERE id=${projectId} ${options.lock ? sql`FOR UPDATE` : sql``}`);
  assert(project && (!project.deletedAt || options.includeDeleted), 404, 'NOT_FOUND', '项目不存在或无权访问');
  const member = await one<{ role: Role }>(database, sql`SELECT role FROM project_members WHERE project_id=${projectId} AND user_id=${actor.userId}`);
  assert(member, 404, 'NOT_FOUND', '项目不存在或无权访问');
  if (mode !== 'read') assert(member.role !== 'viewer', 403, 'FORBIDDEN', '只读成员不能修改内容');
  if (mode === 'admin') assert(member.role === 'admin', 403, 'FORBIDDEN', '需要项目管理员权限');
  if (mode !== 'read' && !options.allowArchived) assert(!project.archivedAt && !project.deletedAt, 409, 'PROJECT_READONLY', '项目已归档或删除，当前为只读');
  if (actor.credentialId) {
    const c = await one<{ scope: string }>(database, sql`SELECT c.scope FROM api_credentials c WHERE c.id=${actor.credentialId} AND c.user_id=${actor.userId} AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at>now()) AND (c.all_projects OR EXISTS(SELECT 1 FROM credential_projects cp WHERE cp.credential_id=c.id AND cp.project_id=${projectId}))`);
    assert(c && (mode === 'read' || c.scope === 'write'), 403, 'CREDENTIAL_SCOPE', '凭据未获此操作授权');
    assert(mode !== 'admin', 403, 'CREDENTIAL_SCOPE', 'MCP 凭据不支持管理操作');
  }
  return member.role;
}
/** Credential project visibility for list queries: an all-projects credential sees every project its owner belongs to. */
export function credentialProjectFilter(actor: Actor, projectColumn: SQL): SQL {
  if (!actor.credentialId) return sql``;
  return sql`AND (EXISTS(SELECT 1 FROM api_credentials c WHERE c.id=${actor.credentialId} AND c.all_projects AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at>now())) OR EXISTS(SELECT 1 FROM credential_projects cp WHERE cp.credential_id=${actor.credentialId} AND cp.project_id=${projectColumn}))`;
}
export async function read<T>(actor: Actor, projectId: string, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async tx => { await liveUser(tx, actor, true); await access(tx, actor, projectId); return fn(tx); }, { isolationLevel: 'repeatable read' });
}
export async function mutate<T>(actor: Actor, projectId: string | null, mode: 'write' | 'admin', operationId: string, input: unknown, fn: (ctx: Context) => Promise<T>, options: { includeDeleted?: boolean; allowArchived?: boolean } = {}): Promise<T> {
  operationKeySchema.parse(operationId);
  return db.transaction(async tx => {
    const user = await liveUser(tx, actor, true);
    const setting = await one<{ maintenance: boolean }>(tx, sql`SELECT maintenance FROM instance_settings WHERE id=1 FOR SHARE`);
    assert(!setting?.maintenance, 503, 'MAINTENANCE', '系统维护中，请稍后保存');
    if (projectId) await access(tx, actor, projectId, mode, { ...options, lock: true });
    else assert(!actor.credentialId, 403, 'CREDENTIAL_SCOPE', 'MCP 凭据不能执行该管理操作');
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${actor.userId + operationId},0))`);
    const hash = digest(JSON.stringify({ projectId, mode, input, source: actor.source, credentialId: actor.credentialId ?? null }));
    const receipt = await one<{ requestHash: string; response: T }>(tx, sql`SELECT request_hash,response FROM operation_receipts WHERE actor_id=${actor.userId} AND operation_id=${operationId}`);
    if (receipt) { assert(receipt.requestHash === hash, 409, 'IDEMPOTENCY_CONFLICT', '该操作编号已用于不同请求'); return receipt.response; }
    const result = await fn({ tx, actor, user, operationId, projectId });
    await tx.execute(sql`INSERT INTO operation_receipts(actor_id,operation_id,request_hash,response) VALUES(${actor.userId},${operationId},${hash},${JSON.stringify(result)}::jsonb)`);
    return result;
  });
}
export async function audit(ctx: Context, type: string, id: string, operation: string, beforeValue: object | null, afterValue: object | null, keepVersion = false) {
  const before = beforeValue as Record<string, unknown> | null;
  const after = afterValue as Record<string, unknown> | null;
  const changes: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])) {
    if (['updatedAt','version'].includes(key)) continue;
    if (JSON.stringify(before?.[key] ?? null) !== JSON.stringify(after?.[key] ?? null)) changes[key] = { before: before?.[key] ?? null, after: after?.[key] ?? null };
  }
  const eventId = randomUUID();
  await ctx.tx.execute(sql`INSERT INTO audit_events(id,project_id,resource_type,resource_id,operation,actor_id,actor_name,source,credential_id,operation_id,before_version,after_version,changes) VALUES(${eventId},${ctx.projectId},${type},${id},${operation},${ctx.actor.userId},${ctx.user.name},${ctx.actor.source},${ctx.actor.credentialId ?? null},${ctx.operationId},${before?.version ?? null},${after?.version ?? null},${JSON.stringify(changes)}::jsonb)`);
  if (keepVersion && after) await ctx.tx.execute(sql`INSERT INTO resource_versions(id,project_id,resource_type,resource_id,version,snapshot,audit_id) VALUES(${randomUUID()},${ctx.projectId},${type},${id},${after.version},${JSON.stringify(after)}::jsonb,${eventId})`);
}
export function checkVersion(entity: { version: number } | undefined, expected: number) {
  assert(entity, 404, 'NOT_FOUND', '内容不存在');
  if (entity.version !== expected) throw new AppError(409, 'VERSION_CONFLICT', '其他人已经修改了此内容，请重新读取后再保存', { currentVersion: entity.version });
}
export function paging(cursor?: string, size = 30) { const offset = Number(cursor ?? 0); assert(Number.isInteger(offset) && offset >= 0 && offset < 1000000, 400, 'BAD_CURSOR', '分页参数无效'); return { offset, limit: Math.min(100, Math.max(1, size)) }; }
export function page<T>(data: T[], offset: number, limit: number) { return { items: data.slice(0, limit), nextCursor: data.length > limit ? String(offset + limit) : null }; }
