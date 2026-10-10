import { randomUUID, createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { hashPassword } from 'better-auth/crypto';
import nodemailer from 'nodemailer';
import { db, one, rows, type Transaction, type Database } from '../db/index.js';
import { config } from '../config.js';
import { token, digest, safeEqual } from '../lib/crypto.js';
import { assert } from '../lib/errors.js';
import { liveUser, access, mutate, audit, type Actor, type Context } from './core.js';
import { teamAccess } from './projects.js';
import type { User, Role } from '@yuanplan/contracts';

const signup = z.object({ email: z.email().transform(v => v.toLowerCase().trim()), name: z.string().trim().min(1).max(80), password: z.string().min(10).max(128), setupToken: z.string().optional(), inviteToken: z.string().optional() }).strict();
type Invitation = { id: string; targetType: 'project' | 'team'; projectId: string | null; teamId: string | null; email: string; role: Role; inviterId: string; expiresAt: Date; acceptedAt: Date | null; revokedAt: Date | null };
async function newUser(tx: Transaction, data: Pick<z.infer<typeof signup>, 'name' | 'email'>, password: string, source: 'setup' | 'invite' | 'email' | 'self' | 'admin', admin = false) {
  const exists = await one(tx, sql`SELECT id FROM users WHERE email=${data.email}`); assert(!exists, 409, 'ACCOUNT_EXISTS', '该邮箱已注册，请登录或找回账号');
  const id = randomUUID();
  const user = (await one<User>(tx, sql`INSERT INTO users(id,name,email,is_admin,identity_source) VALUES(${id},${data.name},${data.email},${admin},${source}) RETURNING *`))!;
  await tx.execute(sql`INSERT INTO accounts(id,account_id,provider_id,user_id,password) VALUES(${randomUUID()},${id},'credential',${id},${password})`);
  return user;
}
export async function hasApplicationUsers(database:Database=db){return !!await one(database,sql`SELECT id FROM users WHERE id<>'system:account-recovery' LIMIT 1`);}
export async function setupState() {
  const exists = await hasApplicationUsers();
  const settings = await one<{ registrationMode: string }>(db, sql`SELECT registration_mode FROM instance_settings WHERE id=1`);
  return { initialized: !!exists, registrationMode: settings?.registrationMode ?? 'invite', emailEnabled: !!(config.SMTP_HOST && config.SMTP_FROM) };
}
export async function initialize(input: unknown) {
  const data = signup.parse(input); assert(safeEqual(data.setupToken ?? '', config.SETUP_TOKEN), 403, 'BAD_SETUP_TOKEN', '初始化凭据不正确');
  const password = await hashPassword(data.password);
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(591338)`);
    assert(!(await hasApplicationUsers(tx)), 409, 'ALREADY_INITIALIZED', '系统已初始化');
    const user = await newUser(tx, data, password, 'setup', true);
    const actor: Actor = { userId: user.id, source: 'web' };
    await audit({ tx, actor, user, operationId: randomUUID(), projectId: null }, 'instance', 'setup', 'initialize', null, { userId: user.id });
    return { ok: true };
  });
}
async function validInvite(tx: Transaction, inviteToken: string): Promise<Invitation> {
  const found = await one<Invitation>(tx, sql`SELECT * FROM invitations WHERE token_hash=${digest(inviteToken)}`);
  assert(found, 404, 'INVALID_INVITE', '邀请无效或已过期');
  if (found.projectId) await access(tx, { userId: found.inviterId, source: 'web' }, found.projectId, 'admin', { lock: true });
  else { await tx.execute(sql`SELECT id FROM teams WHERE id=${found.teamId} FOR UPDATE`); await teamAccess(tx, found.inviterId, found.teamId!, true); }
  await liveUser(tx, { userId: found.inviterId, source: 'web' });
  const locked = (await one<Invitation>(tx, sql`SELECT * FROM invitations WHERE id=${found.id} FOR UPDATE`))!;
  assert(!locked.acceptedAt && !locked.revokedAt && new Date(locked.expiresAt).getTime() > Date.now(), 410, 'INVALID_INVITE', '邀请无效或已过期');
  return locked;
}
async function consumeInvite(tx: Transaction, invitation: Invitation, user: User) {
  assert(user.email.toLowerCase() === invitation.email, 403, 'EMAIL_MISMATCH', '请使用受邀邮箱登录');
  if (invitation.projectId) await tx.execute(sql`INSERT INTO project_members(project_id,user_id,role) VALUES(${invitation.projectId},${user.id},${invitation.role}) ON CONFLICT DO NOTHING`);
  else await tx.execute(sql`INSERT INTO team_members(team_id,user_id,role) VALUES(${invitation.teamId},${user.id},${invitation.role}) ON CONFLICT DO NOTHING`);
  await tx.execute(sql`UPDATE invitations SET accepted_at=now() WHERE id=${invitation.id}`);
  await audit({ tx, actor: { userId: user.id, source: 'web' }, user, operationId: randomUUID(), projectId: invitation.projectId }, 'invitation', invitation.id, 'accept', null, { targetType: invitation.targetType, role: invitation.role });
}
export async function register(input: unknown) {
  const data = signup.parse(input); const password = await hashPassword(data.password); const verificationToken = token();
  const result = await db.transaction(async tx => {
    const invitation = data.inviteToken ? await validInvite(tx, data.inviteToken) : null;
    if (invitation) assert(data.email === invitation.email, 403, 'EMAIL_MISMATCH', '请使用受邀邮箱注册');
    const settings = invitation ? null : await one<{ registrationMode: string }>(tx, sql`SELECT registration_mode FROM instance_settings WHERE id=1`);
    if (!invitation) {
      assert(settings?.registrationMode === 'open' || settings?.registrationMode === 'open_unverified', 403, 'INVITE_REQUIRED', '当前仅支持邀请注册');
      if (settings.registrationMode === 'open') assert(config.SMTP_HOST && config.SMTP_FROM, 503, 'MAIL_UNAVAILABLE', '邮件服务未配置');
    }
    const needsVerification = !invitation && settings?.registrationMode === 'open';
    const user = await newUser(tx, data, password, invitation ? 'invite' : needsVerification ? 'email' : 'self');
    if (invitation) await consumeInvite(tx, invitation, user);
    else if (needsVerification) await tx.execute(sql`INSERT INTO verifications(id,identifier,value,expires_at) VALUES(${randomUUID()},${'email:' + user.id},${digest(verificationToken)},now()+interval '1 day')`);
    await audit({ tx, actor: { userId: user.id, source: 'web' }, user, operationId: randomUUID(), projectId: null }, 'user', user.id, 'register', null, { identitySource: invitation ? 'invite' : needsVerification ? 'email' : 'self' });
    return { ok: true, needsVerification };
  });
  if (result.needsVerification) await sendMail(data.email, '验证您的 YuanPlan 邮箱', `${config.APP_URL}/verify?token=${verificationToken}`);
  return result;
}
export async function verifyEmail(value: string) {
  return db.transaction(async tx => {
    const row = await one<{ id: string; identifier: string }>(tx, sql`SELECT id,identifier FROM verifications WHERE value=${digest(value)} AND identifier LIKE 'email:%' AND expires_at>now() FOR UPDATE`);
    assert(row, 410, 'INVALID_TOKEN', '验证链接无效或已过期');
    await tx.execute(sql`UPDATE users SET email_verified=true WHERE id=${row.identifier.slice(6)}`);
    await tx.execute(sql`DELETE FROM verifications WHERE id=${row.id}`); return { ok: true };
  });
}
export async function acceptInvitation(actor: Actor, value: string) {
  return db.transaction(async tx => {
    const user = await liveUser(tx, actor, true);
    const identity = await one<{ emailVerified: boolean; identitySource: string }>(tx, sql`SELECT email_verified,identity_source FROM users WHERE id=${user.id}`);
    assert(identity?.emailVerified || identity?.identitySource !== 'email', 403, 'EMAIL_UNVERIFIED', '请先验证已有账号的邮箱');
    await consumeInvite(tx, await validInvite(tx, value), user); return { ok: true };
  });
}
export async function invitePreview(value: string) {
  const item = await one<{ email: string; targetType: string; role: string }>(db, sql`SELECT email,target_type,role FROM invitations WHERE token_hash=${digest(value)} AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now()`);
  assert(item, 410, 'INVALID_INVITE', '邀请无效或已过期'); return item;
}
export async function createInvitation(actor: Actor, type: 'project' | 'team', targetId: string, email: string, role: Role, op: string) {
  email = z.email().parse(email).toLowerCase().trim();
  assert(type !== 'team' || role !== 'viewer', 400, 'INVALID_ROLE', '团队支持管理员或成员');
  const value = createHmac('sha256', config.AUTH_SECRET).update(`invite:${actor.userId}:${op}`).digest('base64url');
  return mutate(actor, type === 'project' ? targetId : null, 'admin', op, { action: 'invite', type, targetId, email, role }, async ctx => {
    if (type === 'team') await teamAccess(ctx.tx, actor.userId, targetId, true);
    const id = randomUUID();
    await ctx.tx.execute(sql`INSERT INTO invitations(id,target_type,project_id,team_id,email,role,inviter_id,token_hash,expires_at) VALUES(${id},${type},${type === 'project' ? targetId : null},${type === 'team' ? targetId : null},${email},${role},${actor.userId},${digest(value)},now()+interval '7 days')`);
    await audit(ctx, 'invitation', id, 'create', null, { email, role, type, targetId });
    // Derivation makes an authenticated retry stable without storing the secret.
    return { id };
  }).then(result => ({ ...result, url: `${config.APP_URL}/invite?token=${value}` }));
}
export async function listInvitations(actor: Actor, type: 'project' | 'team', id: string) {
  await liveUser(db, actor); if (type === 'project') await access(db, actor, id, 'admin'); else await teamAccess(db, actor.userId, id, true);
  return rows(db, sql`SELECT id,email,role,expires_at,accepted_at,revoked_at,created_at FROM invitations WHERE ${type === 'project' ? sql`project_id=${id}` : sql`team_id=${id}`} ORDER BY created_at DESC LIMIT 100`);
}
export async function revokeInvitation(actor: Actor, id: string, op: string) {
  const invitation = await one<Invitation>(db, sql`SELECT * FROM invitations WHERE id=${id}`); assert(invitation, 404, 'NOT_FOUND', '邀请不存在');
  return mutate(actor, invitation.projectId, 'admin', op, { action: 'revoke_invite', id }, async ctx => {
    if (invitation.teamId) await teamAccess(ctx.tx, actor.userId, invitation.teamId, true);
    await ctx.tx.execute(sql`UPDATE invitations SET revoked_at=now() WHERE id=${id}`);
    await audit(ctx, 'invitation', id, 'revoke', null, { revoked: true }); return { ok: true };
  });
}
export const mailTransport={create:nodemailer.createTransport};
export async function sendMail(to: string, subject: string, url: string) {
  assert(config.SMTP_HOST && config.SMTP_FROM, 503, 'MAIL_UNAVAILABLE', '邮件服务未配置');
  const transport = mailTransport.create({ host: config.SMTP_HOST, port: config.SMTP_PORT, secure: config.SMTP_PORT === 465, auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS } : undefined });
  await transport.sendMail({ from: config.SMTP_FROM, to, subject, text: `${subject}\n\n${url}\n\n如果不是您本人操作，请忽略。` });
}
export async function adminUsers(actor: Actor) { const u = await liveUser(db, actor); assert(u.isAdmin, 403, 'FORBIDDEN', '需要系统管理员权限'); return rows(db, sql`SELECT id,name,email,is_admin,disabled,created_at FROM users WHERE id<>'system:account-recovery' ORDER BY created_at LIMIT 500`); }
const userPageInput = z.object({
  query:z.string().trim().max(200).default(''), role:z.enum(['all','admin','user']).default('all'),
  status:z.enum(['all','active','disabled']).default('all'),
  page:z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize:z.coerce.number().int().refine(n=>[10,20,50].includes(n)).default(10),
});
export async function adminUserPage(actor:Actor,input:unknown){
  const user=await liveUser(db,actor);assert(user.isAdmin,403,'FORBIDDEN','需要系统管理员权限');
  const options=userPageInput.parse(input);const keyword=options.query.replace(/[\\%_]/g,'\\$&');
  const scope=sql`id<>'system:account-recovery'
    ${options.query?sql`AND (name ILIKE ${'%'+keyword+'%'} OR email ILIKE ${'%'+keyword+'%'})`:sql``}
    ${options.role!=='all'?sql`AND is_admin=${options.role==='admin'}`:sql``}
    ${options.status!=='all'?sql`AND disabled=${options.status==='disabled'}`:sql``}`;
  const total=(await one<{count:number}>(db,sql`SELECT count(*)::int count FROM users WHERE ${scope}`))!.count;
  const page=Math.min(options.page,Math.max(1,Math.ceil(total/options.pageSize)));
  const items=await rows(db,sql`SELECT id,name,email,email_verified,identity_source,is_admin,disabled,created_at FROM users WHERE ${scope} ORDER BY created_at DESC,id DESC LIMIT ${options.pageSize} OFFSET ${(page-1)*options.pageSize}`);
  return {items,total,page,pageSize:options.pageSize};
}
const adminCreateInput = z.object({ email: z.email().transform(v => v.toLowerCase().trim()), name: z.string().trim().min(1).max(80) }).strict();
export async function createUser(actor: Actor, input: unknown, op: string) {
  const data = adminCreateInput.parse(input);
  const password = await hashPassword(token());
  const value = createHmac('sha256', config.AUTH_SECRET).update(`new-user:${actor.userId}:${op}`).digest('base64url');
  return mutate(actor, null, 'admin', op, { action: 'create_user', data }, async ctx => {
    assert(ctx.user.isAdmin, 403, 'FORBIDDEN', '需要系统管理员权限');
    const user = await newUser(ctx.tx, data, password, 'admin');
    const recoveryId = randomUUID();
    await ctx.tx.execute(sql`INSERT INTO recovery_tokens(id,user_id,token_hash,expires_at) VALUES(${recoveryId},${user.id},${digest(value)},now()+interval '30 minutes')`);
    await audit(ctx, 'user', user.id, 'create', null, { name: user.name, email: user.email, isAdmin: false, recoveryId });
    return { id: user.id, url: `${config.APP_URL}/recover?token=${value}` };
  });
}
export async function instanceSettings(actor: Actor) { const u = await liveUser(db, actor); assert(u.isAdmin, 403, 'FORBIDDEN', '需要系统管理员权限'); return { ...(await one(db, sql`SELECT * FROM instance_settings WHERE id=1`)), emailEnabled: !!(config.SMTP_HOST && config.SMTP_FROM) }; }
export async function updateSettings(actor: Actor, registrationMode: 'invite' | 'open' | 'open_unverified', op: string) {
  return mutate(actor, null, 'admin', op, { action: 'settings', registrationMode }, async ctx => {
    assert(ctx.user.isAdmin, 403, 'FORBIDDEN', '需要系统管理员权限');
    assert(registrationMode !== 'open' || (config.SMTP_HOST && config.SMTP_FROM), 400, 'MAIL_REQUIRED', '开放注册需要先配置邮件服务');
    const before = await one(ctx.tx, sql`SELECT registration_mode FROM instance_settings WHERE id=1`);
    await ctx.tx.execute(sql`UPDATE instance_settings SET registration_mode=${registrationMode} WHERE id=1`);
    await audit(ctx, 'instance', 'settings', 'update', before!, { registrationMode }); return { ok: true };
  });
}
export async function setUserDisabled(actor: Actor, userId: string, disabled: boolean, op: string) {
  return mutate(actor, null, 'admin', op, { action: 'disable_user', userId, disabled }, async ctx => {
    assert(ctx.user.isAdmin && userId !== actor.userId && userId!=='system:account-recovery', 403, 'FORBIDDEN', '不能操作此账号');
    // Match business writes: lock the target user before their projects. Otherwise
    // a writer holding the user share lock can deadlock with account suspension.
    assert(await one(ctx.tx, sql`SELECT id FROM users WHERE id=${userId} FOR UPDATE`), 404, 'NOT_FOUND', '账号不存在');
    // Project locks serialize this check with membership changes.
    await ctx.tx.execute(sql`SELECT p.id FROM projects p JOIN project_members m ON m.project_id=p.id WHERE m.user_id=${userId} ORDER BY p.id FOR UPDATE OF p`);
    if (disabled) {
      const last = await one(ctx.tx, sql`SELECT m.project_id FROM project_members m WHERE m.user_id=${userId} AND m.role='admin' AND NOT EXISTS(SELECT 1 FROM project_members m2 JOIN users u ON u.id=m2.user_id WHERE m2.project_id=m.project_id AND m2.role='admin' AND m2.user_id<>${userId} AND NOT u.disabled) LIMIT 1`);
      assert(!last, 409, 'LAST_ADMIN', '请先交接该账号管理的项目');
    }
    const target = await one(ctx.tx, sql`UPDATE users SET disabled=${disabled} WHERE id=${userId} RETURNING id`); assert(target, 404, 'NOT_FOUND', '账号不存在');
    if (disabled) { await ctx.tx.execute(sql`UPDATE recovery_tokens SET consumed_at=now() WHERE user_id=${userId} AND consumed_at IS NULL`); await ctx.tx.execute(sql`DELETE FROM sessions WHERE user_id=${userId}`); await ctx.tx.execute(sql`UPDATE api_credentials SET revoked_at=now() WHERE user_id=${userId} AND revoked_at IS NULL`); }
    await audit(ctx, 'user', userId, disabled ? 'disable' : 'enable', null, { disabled }); return { ok: true };
  });
}
export async function issueRecovery(actor: Actor, userId: string, op: string) {
  const value = createHmac('sha256', config.AUTH_SECRET).update(`recovery:${actor.userId}:${op}`).digest('base64url');
  const result = await mutate(actor, null, 'admin', op, { action: 'issue_recovery', userId }, async ctx => {
    assert(ctx.user.isAdmin, 403, 'FORBIDDEN', '需要系统管理员权限');
    assert(await one(ctx.tx, sql`SELECT id FROM users WHERE id=${userId} AND NOT disabled FOR UPDATE`), 404, 'NOT_FOUND', '账号不存在');
    const id = randomUUID();
    await ctx.tx.execute(sql`UPDATE recovery_tokens SET consumed_at=now() WHERE user_id=${userId} AND consumed_at IS NULL`);
    await ctx.tx.execute(sql`INSERT INTO recovery_tokens(id,user_id,token_hash,expires_at) VALUES(${id},${userId},${digest(value)},now()+interval '30 minutes')`);
    await audit(ctx, 'user', userId, 'issue_recovery', null, { recoveryId: id }); return { id };
  });
  return { ...result, url: `${config.APP_URL}/recover?token=${value}` };
}
export async function resetPassword(value: string, password: string) {
  z.string().min(20).max(200).parse(value); z.string().min(10).max(128).parse(password); const hashed = await hashPassword(password);
  return db.transaction(async tx => {
    const candidate=await one<{userId:string}>(tx,sql`SELECT user_id FROM recovery_tokens WHERE token_hash=${digest(value)}`);
    assert(candidate,410,'INVALID_TOKEN','恢复链接无效或已过期');
    await tx.execute(sql`SELECT id FROM users WHERE id=${candidate.userId} FOR UPDATE`);
    const recovery = await one<{ id: string; userId: string }>(tx, sql`SELECT id,user_id FROM recovery_tokens WHERE token_hash=${digest(value)} AND consumed_at IS NULL AND expires_at>now() FOR UPDATE`);
    assert(recovery, 410, 'INVALID_TOKEN', '恢复链接无效或已过期');
    const actor: Actor = { userId: recovery.userId, source: 'web' }; const user = await liveUser(tx, actor);
    const changed=await one(tx,sql`UPDATE accounts SET password=${hashed},updated_at=now() WHERE user_id=${user.id} AND provider_id='credential' RETURNING id`);
    assert(changed,409,'NO_PASSWORD_ACCOUNT','该账号没有密码登录方式');
    await tx.execute(sql`UPDATE recovery_tokens SET consumed_at=now() WHERE user_id=${user.id} AND consumed_at IS NULL`);
    await tx.execute(sql`DELETE FROM sessions WHERE user_id=${user.id}`);
    await tx.execute(sql`UPDATE api_credentials SET revoked_at=now() WHERE user_id=${user.id} AND revoked_at IS NULL`);
    await audit({ tx, actor, user, projectId: null, operationId: randomUUID() }, 'user', user.id, 'reset_password', null, { recoveryId: recovery.id }); return { ok: true };
  });
}
