import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { serveStatic } from '@hono/node-server/serve-static';
import type { HttpBindings } from '@hono/node-server';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { db, one } from './db/index.js';
import { auth } from './modules/auth.js';
import { AppError, assert } from './lib/errors.js';
import { liveUser, type Actor } from './modules/core.js';
import { idSchema, roles, statuses, versionSchema } from '@yuanplan/contracts';
import { requestEmailRecovery } from './modules/recovery.js';
import * as accounts from './modules/accounts.js';
import * as projects from './modules/projects.js';
import * as overview from './modules/overview.js';
import { taskSchedule } from './modules/task-schedule.js';
import * as resources from './modules/resources.js';
import * as credentials from './modules/credentials.js';
import * as notifications from './modules/notifications.js';
import * as labels from './modules/labels.js';
import * as files from './modules/files.js';
import { handleMcp } from './modules/mcp.js';

type Env = { Bindings: HttpBindings; Variables: { actor: Actor } };
export const app = new Hono<Env>();
const requestLimit = new Map<string, { count: number; reset: number }>();
app.use('*', secureHeaders({ referrerPolicy: 'no-referrer', xFrameOptions: 'DENY', ...(config.NODE_ENV === 'production' ? { contentSecurityPolicy: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], objectSrc: ["'none'"], baseUri: ["'none'"], frameAncestors: ["'none'"] } } : {}) }));
app.use('/api/*', bodyLimit({ maxSize: config.MAX_UPLOAD_BYTES + 1024 * 1024, onError: c => c.json({ error: { code: 'BODY_TOO_LARGE', message: '请求内容过大' } }, 413) }));
app.use('/api/*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  const origin = c.req.header('Origin');
  if (origin && origin !== new URL(config.APP_URL).origin) throw new AppError(403, 'INVALID_ORIGIN', '请求来源不被允许');
  const allowedHosts = new Set([new URL(config.APP_URL).hostname, '127.0.0.1', 'localhost']);
  if (!allowedHosts.has(new URL(c.req.url).hostname)) throw new AppError(403, 'INVALID_HOST', '请求主机不被允许');
  if (!['GET','HEAD','OPTIONS'].includes(c.req.method) && !c.req.path.startsWith('/api/mcp')) {
    // Browser write requests always send Origin. Nonbrowser writes must explicitly set it.
    assert(origin === new URL(config.APP_URL).origin, 403, 'INVALID_ORIGIN', '写入请求需要有效 Origin');
  }
  await next();
});
app.get('/api/health', async c => { await db.execute(sql`SELECT 1`); return c.json({ status: 'ok', version: '0.1.0' }); });
app.use('/api/*', async (c, next) => {
  const settings = await one<{ maintenance: boolean }>(db, sql`SELECT maintenance FROM instance_settings WHERE id=1`);
  if (settings?.maintenance) { c.header('Retry-After', '60'); throw new AppError(503, 'MAINTENANCE', '系统维护中，请稍后重试'); }
  await next();
});
app.use('/api/public/*', async (c, next) => {
  if (c.req.method === 'POST') {
    const ip = c.env?.incoming?.socket?.remoteAddress ?? 'local'; const now = Date.now();
    if (requestLimit.size > 10000) for (const [key, value] of requestLimit) if (value.reset < now) requestLimit.delete(key);
    const current = requestLimit.get(ip); const bucket = !current || current.reset < now ? { count: 0, reset: now + 60000 } : current;
    assert(++bucket.count <= 30, 429, 'RATE_LIMIT', '请求过于频繁，请稍后再试'); requestLimit.set(ip, bucket);
  }
  await next();
});
app.get('/api/public/state', async c => c.json(await accounts.setupState()));
app.post('/api/public/setup', async c => c.json(await accounts.initialize(await c.req.json())));
app.post('/api/public/register', async c => c.json(await accounts.register(await c.req.json())));
app.get('/api/public/invitation', async c => c.json(await accounts.invitePreview(z.string().min(20).parse(c.req.query('token')))));
app.post('/api/public/verify', async c => c.json(await accounts.verifyEmail(z.object({ token: z.string().min(20) }).parse(await c.req.json()).token)));
app.post('/api/public/request-recovery',async c=>{const b=z.object({email:z.email()}).strict().parse(await c.req.json());return c.json(await requestEmailRecovery(b.email));});
app.post('/api/public/reset-password', async c => { const b = z.object({ token: z.string(), password: z.string() }).parse(await c.req.json()); return c.json(await accounts.resetPassword(b.token, b.password)); });
app.on(['GET','POST'], '/api/auth/*', async c => {
  const method = c.req.path.replace('/api/auth/', '');
  assert(['sign-in/email','sign-out','get-session','change-password'].includes(method), 404, 'NOT_FOUND', '接口不存在');
  if (method === 'sign-in/email' && c.req.method === 'POST') {
    const b = await c.req.raw.clone().json();
    const u = await one<{ disabled: boolean; emailVerified: boolean; identitySource: string }>(db, sql`SELECT disabled,email_verified,identity_source FROM users WHERE email=${String(b.email ?? '').trim().toLowerCase()}`);
    assert(!u || (!u.disabled && (u.emailVerified || u.identitySource !== 'email')), 401, 'LOGIN_FAILED', '账号不可用或邮箱尚未验证');
  }
  return auth.handler(c.req.raw);
});
app.all('/api/mcp', c => handleMcp(c.req.raw));
app.use('/api/*', async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  assert(session, 401, 'UNAUTHENTICATED', '请先登录');
  const actor: Actor = { userId: session.user.id, source: 'web' }; await liveUser(db, actor);
  c.set('actor', actor); await next();
});
const id = (value: string | undefined) => idSchema.parse(value);
const op = (value: string | undefined) => z.string().uuid().parse(value);
const dataBody = z.object({ data: z.record(z.string(), z.unknown()), expectedVersion: versionSchema.optional() }).strict();
app.get('/api/me', async c => c.json(await liveUser(db, c.get('actor'))));
app.post('/api/invitations/accept', async c => c.json(await accounts.acceptInvitation(c.get('actor'), z.object({ token: z.string() }).parse(await c.req.json()).token)));
app.get('/api/projects', async c => c.json(c.req.query('page') !== undefined
  ? await projects.listProjectPage(c.get('actor'), c.req.query())
  : await projects.listProjects(c.get('actor'), c.req.query('includeDeleted') === 'true')));
app.post('/api/projects', async c => c.json(await projects.createProject(c.get('actor'), await c.req.json(), op(c.req.header('Idempotency-Key'))), 201));
app.get('/api/projects/:projectId', async c => c.json(await projects.getProject(c.get('actor'), id(c.req.param('projectId')))));
app.get('/api/projects/:projectId/overview', async c => c.json(await overview.projectOverview(c.get('actor'), id(c.req.param('projectId')), c.req.query())));
app.get('/api/projects/:projectId/task-schedule', async c => c.json(await taskSchedule(c.get('actor'), id(c.req.param('projectId')), c.req.query())));
app.put('/api/projects/:projectId/overview/layout', async c => c.json(await overview.saveOverviewLayout(c.get('actor'), id(c.req.param('projectId')), await c.req.json(), op(c.req.header('Idempotency-Key')))));
app.put('/api/projects/:projectId', async c => { const b = dataBody.parse(await c.req.json()); return c.json(await projects.updateProject(c.get('actor'), id(c.req.param('projectId')), b.data, versionSchema.parse(b.expectedVersion), op(c.req.header('Idempotency-Key')))); });
app.get('/api/projects/:projectId/labels',async c=>c.json(await labels.listLabels(c.get('actor'),id(c.req.param('projectId')))));
app.post('/api/projects/:projectId/labels',async c=>{const b=z.object({name:z.string()}).strict().parse(await c.req.json());return c.json(await labels.createLabel(c.get('actor'),id(c.req.param('projectId')),b.name,op(c.req.header('Idempotency-Key'))));});
app.put('/api/projects/:projectId/labels/:id',async c=>{const b=z.object({name:z.string().nullable(),expectedVersion:versionSchema}).strict().parse(await c.req.json());return c.json(await labels.changeLabel(c.get('actor'),id(c.req.param('projectId')),id(c.req.param('id')),b.name,b.expectedVersion,op(c.req.header('Idempotency-Key'))));});
app.get('/api/projects/:projectId/members', async c => c.json(await projects.listMembers(c.get('actor'), id(c.req.param('projectId')))));
app.put('/api/projects/:projectId/members/:userId', async c => { const b = z.object({ role: z.enum(roles).nullable() }).strict().parse(await c.req.json()); return c.json(await projects.changeMember(c.get('actor'), id(c.req.param('projectId')), c.req.param('userId'), b.role, op(c.req.header('Idempotency-Key')))); });
app.post('/api/projects/:projectId/members/from-team', async c => { const b = z.object({ teamId: idSchema, userIds: z.array(z.string()).min(1).max(100), role: z.enum(roles) }).strict().parse(await c.req.json()); return c.json(await projects.addFromTeam(c.get('actor'), id(c.req.param('projectId')), b.teamId, b.userIds, b.role, op(c.req.header('Idempotency-Key')))); });
app.get('/api/teams', async c => c.json(await projects.listTeams(c.get('actor'))));
app.post('/api/teams', async c => c.json(await projects.createTeam(c.get('actor'), z.object({ name: z.string() }).parse(await c.req.json()).name, op(c.req.header('Idempotency-Key'))), 201));
app.put('/api/teams/:teamId',async c=>{const b=z.object({name:z.string(),expectedVersion:versionSchema}).strict().parse(await c.req.json());return c.json(await projects.renameTeam(c.get('actor'),id(c.req.param('teamId')),b.name,b.expectedVersion,op(c.req.header('Idempotency-Key'))));});
app.put('/api/teams/:teamId/members/:userId',async c=>{const b=z.object({role:z.enum(['admin','member']),expectedRole:z.enum(['admin','member'])}).strict().parse(await c.req.json());return c.json(await projects.changeTeamRole(c.get('actor'),id(c.req.param('teamId')),c.req.param('userId'),b.role,b.expectedRole,op(c.req.header('Idempotency-Key'))));});
app.get('/api/teams/:teamId/members', async c => c.json(await projects.teamMembers(c.get('actor'), id(c.req.param('teamId')))));
app.post('/api/teams/:teamId/manage', async c => { const b = z.object({ action: z.enum(['delete','remove_member']), userId: z.string().nullable().default(null),expectedVersion:versionSchema.optional() }).strict().parse(await c.req.json()); return c.json(await projects.manageTeam(c.get('actor'), id(c.req.param('teamId')), b.action, b.userId, op(c.req.header('Idempotency-Key')),b.expectedVersion)); });
app.get('/api/invitations/:target/:targetId', async c => c.json(await accounts.listInvitations(c.get('actor'), z.enum(['project','team']).parse(c.req.param('target')), id(c.req.param('targetId')))));
app.post('/api/invitations/:target/:targetId', async c => { const b = z.object({ email: z.email(), role: z.enum(roles) }).strict().parse(await c.req.json()); return c.json(await accounts.createInvitation(c.get('actor'), z.enum(['project','team']).parse(c.req.param('target')), id(c.req.param('targetId')), b.email, b.role, op(c.req.header('Idempotency-Key')))); });
app.post('/api/invitations/:id/revoke', async c => c.json(await accounts.revokeInvitation(c.get('actor'), id(c.req.param('id')), op(c.req.header('Idempotency-Key')))));
app.get('/api/my-tasks', async c => c.json(await resources.myTasks(c.get('actor'), c.req.query())));
app.get('/api/notifications/unread-count', async c => c.json(await notifications.unreadNotifications(c.get('actor'))));
app.get('/api/notifications', async c => c.json(await notifications.listNotifications(c.get('actor'), c.req.query())));
app.post('/api/notifications/read-all', async c => c.json(await notifications.markAllNotificationsRead(c.get('actor'), await c.req.json(), op(c.req.header('Idempotency-Key')))));
app.post('/api/notifications/:id/read', async c => c.json(await notifications.markNotificationRead(c.get('actor'), id(c.req.param('id')), op(c.req.header('Idempotency-Key')))));
app.get('/api/projects/:projectId/tasks', async c => c.json(await resources.listTasks(c.get('actor'), id(c.req.param('projectId')), { ...c.req.query(), roots: c.req.query('roots') === 'true', archived: c.req.query('archived') === 'true', deleted: c.req.query('deleted') === 'true' })));
app.post('/api/projects/:projectId/tasks', async c => c.json(await resources.createTask(c.get('actor'), id(c.req.param('projectId')), await c.req.json(), op(c.req.header('Idempotency-Key'))), 201));
app.post('/api/projects/:projectId/tasks/:id/move', async c => { const b = z.object({ status: z.enum(statuses), beforeId: idSchema.nullable(), beforeVersion: versionSchema.optional(), expectedVersion: versionSchema }).strict().parse(await c.req.json()); return c.json(await resources.moveTask(c.get('actor'), id(c.req.param('projectId')), id(c.req.param('id')), b, op(c.req.header('Idempotency-Key')))); });
app.get('/api/projects/:projectId/documents', async c => c.json(await resources.listDocuments(c.get('actor'), id(c.req.param('projectId')), { ...c.req.query(), deleted: c.req.query('deleted') === 'true' })));
app.post('/api/projects/:projectId/documents', async c => c.json(await resources.createDocument(c.get('actor'), id(c.req.param('projectId')), await c.req.json(), op(c.req.header('Idempotency-Key'))), 201));
for (const kind of ['task','document'] as const) {
  const path = `/api/projects/:projectId/${kind}s/:id`;
  app.get(path, async c => c.json(await resources.getResource(c.get('actor'), id(c.req.param('projectId')), kind, id(c.req.param('id')))));
  app.put(path, async c => { const b = dataBody.parse(await c.req.json()); const f = kind === 'task' ? resources.updateTask : resources.updateDocument; return c.json(await f(c.get('actor'), id(c.req.param('projectId')), id(c.req.param('id')), b.data, versionSchema.parse(b.expectedVersion), op(c.req.header('Idempotency-Key')))); });
  app.get(`${path}/history`, async c => c.json(await resources.history(c.get('actor'), id(c.req.param('projectId')), kind, id(c.req.param('id')), c.req.query('cursor'), c.req.query())));
  app.get(`${path}/versions/:version`, async c => c.json(await resources.getVersion(c.get('actor'), id(c.req.param('projectId')), kind, id(c.req.param('id')), versionSchema.parse(Number(c.req.param('version'))))));
  app.get(`${path}/files`, async c => c.json(await files.attachments(c.get('actor'), id(c.req.param('projectId')), kind, id(c.req.param('id')))));
  app.post(`${path}/files`, async c => { const form = await c.req.raw.formData(); const f = form.get('file'); assert(f instanceof File, 400, 'INVALID_FILE', '请选择文件'); return c.json(await files.upload(c.get('actor'), id(c.req.param('projectId')), kind, id(c.req.param('id')), f, versionSchema.parse(Number(form.get('expectedVersion'))), op(c.req.header('Idempotency-Key')))); });
}
app.post('/api/projects/:projectId/documents/:id/move',async c=>{const b=z.object({direction:z.enum(['up','down']),expectedVersion:versionSchema,neighborId:idSchema,neighborVersion:versionSchema}).strict().parse(await c.req.json());return c.json(await resources.moveDocument(c.get('actor'),id(c.req.param('projectId')),id(c.req.param('id')),b,op(c.req.header('Idempotency-Key'))));});
app.post('/api/projects/:projectId/documents/:id/restore-version', async c => { const b = z.object({ expectedVersion: versionSchema, version: versionSchema }).strict().parse(await c.req.json()); return c.json(await resources.updateDocument(c.get('actor'), id(c.req.param('projectId')), id(c.req.param('id')), {}, b.expectedVersion, op(c.req.header('Idempotency-Key')), b.version)); });
app.post('/api/projects/:projectId/lifecycle/:kind/:id', async c => { const b = z.object({ action: z.enum(['delete','restore','archive','unarchive']), expectedVersion: versionSchema }).strict().parse(await c.req.json()); return c.json(await resources.lifecycle(c.get('actor'), id(c.req.param('projectId')), z.enum(['task','document','project']).parse(c.req.param('kind')), id(c.req.param('id')), b.action, b.expectedVersion, op(c.req.header('Idempotency-Key')))); });
app.get('/api/projects/:projectId/tasks/:id/comments', async c => c.json(await resources.comments(c.get('actor'), id(c.req.param('projectId')), id(c.req.param('id')), c.req.query('cursor'))));
app.get('/api/projects/:projectId/tasks/:id/activity', async c => c.json(await resources.taskActivity(c.get('actor'), id(c.req.param('projectId')), id(c.req.param('id')), c.req.query('cursor'))));
app.post('/api/projects/:projectId/tasks/:id/comments', async c => {
  const operationId = op(c.req.header('Idempotency-Key'));
  if (c.req.header('Content-Type')?.includes('multipart/form-data')) {
    const form = await c.req.raw.formData();
    const content = form.get('content');
    const attachments = form.getAll('files');
    assert(typeof content === 'string' && attachments.every(file => file instanceof File), 400, 'INVALID_INPUT', '评论内容或附件无效');
    return c.json(await resources.addComment(c.get('actor'), id(c.req.param('projectId')), id(c.req.param('id')), content, operationId, attachments as File[]), 201);
  }
  return c.json(await resources.addComment(c.get('actor'), id(c.req.param('projectId')), id(c.req.param('id')), z.object({ content: z.string() }).parse(await c.req.json()).content, operationId), 201);
});
app.delete('/api/projects/:projectId/comments/:id', async c => c.json(await resources.deleteComment(c.get('actor'), id(c.req.param('projectId')), id(c.req.param('id')), op(c.req.header('Idempotency-Key')))));
app.get('/api/projects/:projectId/tasks/:id/documents', async c => c.json(await resources.taskLinks(c.get('actor'), id(c.req.param('projectId')), id(c.req.param('id')))));
app.get('/api/projects/:projectId/documents/:id/tasks', async c => c.json(await resources.documentLinks(c.get('actor'), id(c.req.param('projectId')), id(c.req.param('id')))));
app.post('/api/projects/:projectId/tasks/:id/documents', async c => c.json(await resources.linkTask(c.get('actor'), id(c.req.param('projectId')), id(c.req.param('id')), id(z.object({ documentId: idSchema }).parse(await c.req.json()).documentId), op(c.req.header('Idempotency-Key')))));
app.get('/api/files/:id', async c => { const { file, bytes } = await files.download(c.get('actor'), id(c.req.param('id'))); return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': file.mimeType, 'Content-Disposition': `${file.mimeType.startsWith('image/') ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store', 'Content-Security-Policy': "default-src 'none'; sandbox" } }); });
app.get('/api/credentials', async c => c.json(await credentials.listCredentials(c.get('actor'))));
app.post('/api/credentials', async c => c.json(await credentials.createCredential(c.get('actor'), await c.req.json(), op(c.req.header('Idempotency-Key'))), 201));
app.post('/api/credentials/:id/revoke', async c => c.json(await credentials.revokeCredential(c.get('actor'), id(c.req.param('id')), op(c.req.header('Idempotency-Key')))));
app.get('/api/instance/users', async c => c.json(c.req.query('page')!==undefined?await accounts.adminUserPage(c.get('actor'),c.req.query()):await accounts.adminUsers(c.get('actor'))));
app.post('/api/instance/users', async c => c.json(await accounts.createUser(c.get('actor'), await c.req.json(), op(c.req.header('Idempotency-Key'))), 201));
app.get('/api/instance/settings', async c => c.json(await accounts.instanceSettings(c.get('actor'))));
app.put('/api/instance/settings', async c => c.json(await accounts.updateSettings(c.get('actor'), z.object({ registrationMode: z.enum(['invite','open','open_unverified']) }).strict().parse(await c.req.json()).registrationMode, op(c.req.header('Idempotency-Key')))));
app.post('/api/instance/users/:id/disabled', async c => c.json(await accounts.setUserDisabled(c.get('actor'), c.req.param('id'), z.object({ disabled: z.boolean() }).parse(await c.req.json()).disabled, op(c.req.header('Idempotency-Key')))));
app.post('/api/instance/users/:id/recovery', async c => c.json(await accounts.issueRecovery(c.get('actor'), c.req.param('id'), op(c.req.header('Idempotency-Key')))));
app.all('/api/*', c => c.json({ error: { code: 'NOT_FOUND', message: '接口不存在' } }, 404));
app.use('*', serveStatic({ root: config.WEB_DIST }));
app.get('*', serveStatic({ path: `${config.WEB_DIST}/index.html` }));
app.onError((error, c) => {
  if (error instanceof AppError) return c.json({ error: { code: error.code, message: error.message, details: error.details } }, error.status as 400);
  if (error instanceof z.ZodError) return c.json({ error: { code: 'INVALID_INPUT', message: error.issues.map(i => i.message).join('；'), issues: error.issues.map(i => ({ path: i.path, message: i.message })) } }, 400);
  if (error instanceof SyntaxError) return c.json({ error: { code: 'INVALID_JSON', message: '请求格式不正确' } }, 400);
  const cause = error.cause as { code?: string } | undefined;
  const code = (error as { code?: string }).code ?? cause?.code;
  if (code === '22P02' || code === '22007') return c.json({ error: { code: 'INVALID_INPUT', message: '参数格式不正确' } }, 400);
  if (code === '23505') return c.json({ error: { code: 'ALREADY_EXISTS', message: '记录已存在，请刷新后重试' } }, 409);
  const requestId = randomUUID(); console.error(JSON.stringify({ requestId, type: error.name, databaseCode: code }));
  return c.json({ error: { code: 'INTERNAL_ERROR', message: '操作失败，数据未确认保存，请稍后重试', requestId } }, 500);
});
