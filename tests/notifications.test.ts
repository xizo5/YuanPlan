import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { db, one, pool } from '../apps/server/src/db';
import { migrate } from '../apps/server/src/db/migrate';
import { createProject } from '../apps/server/src/modules/projects';
import { createCredential } from '../apps/server/src/modules/credentials';
import * as resources from '../apps/server/src/modules/resources';
import * as notifications from '../apps/server/src/modules/notifications';
import type { Actor } from '../apps/server/src/modules/core';
import { app } from '../apps/server/src/app';
import { auth } from '../apps/server/src/modules/auth';
import { config } from '../apps/server/src/config';

beforeAll(async () => { await migrate(process.env.TEST_DATABASE_URL); });
afterAll(async () => { await pool.end(); });
async function fixture() {
  const actors: Actor[] = Array.from({ length: 3 }, () => ({ userId: randomUUID(), source: 'web' }));
  for (const actor of actors) await db.execute(sql`INSERT INTO users(id,name,email,identity_source) VALUES(${actor.userId},'消息测试',${actor.userId + '@example.test'},'invite')`);
  const [owner, member, other] = actors;
  const project = await createProject(owner, { name: '通知测试项目' }, randomUUID());
  for (const actor of [member, other]) await db.execute(sql`INSERT INTO project_members(project_id,user_id,role) VALUES(${project.id},${actor.userId},'member')`);
  return { owner, member, other, project };
}

it('creates transactional assignment/comment notifications once, including MCP writes and self-assignment', async () => {
  const { owner, member, other, project } = await fixture();
  const op = randomUUID();
  const input = { title: '任务通知', assigneeId: member.userId };
  const task = await resources.createTask(owner, project.id, input, op);
  await resources.createTask(owner, project.id, input, op);
  expect(await notifications.unreadNotifications(member)).toEqual({ unreadCount: 1 });
  expect(await notifications.unreadNotifications(owner)).toEqual({ unreadCount: 0 });
  const page = await notifications.listNotifications(member);
  expect(page.items[0]).toMatchObject({ taskId: task.id, eventType: 'task.assigned', taskTitle: '任务通知', readAt: null });
  expect(await one(db, sql`SELECT status,channel FROM notification_deliveries WHERE notification_id=${page.items[0].id}`)).toEqual({ status: 'delivered', channel: 'in_app' });
  await resources.updateTask(owner, project.id, task.id, { priority: 'high' }, 1, randomUUID());
  expect((await notifications.unreadNotifications(member)).unreadCount).toBe(1);
  await resources.addComment(member, project.id, task.id, '自己的评论', randomUUID());
  expect((await notifications.unreadNotifications(member)).unreadCount).toBe(1);
  const commentOp = randomUUID();
  const comment = await resources.addComment(other, project.id, task.id, '评论正文不进入提醒', commentOp);
  await resources.addComment(other, project.id, task.id, '评论正文不进入提醒', commentOp);
  expect((await notifications.unreadNotifications(member)).unreadCount).toBe(2);
  expect(JSON.stringify(await notifications.listNotifications(member))).not.toContain('评论正文不进入提醒');
  await resources.deleteComment(owner, project.id, comment.id as string, randomUUID());
  expect((await notifications.unreadNotifications(member)).unreadCount).toBe(1);
  await resources.updateTask(owner, project.id, task.id, { assigneeId: other.userId }, 2, randomUUID());
  expect((await notifications.unreadNotifications(other)).unreadCount).toBe(1);
  const credential = await createCredential(owner, { name: '通知 MCP', projectIds: [project.id], scope: 'write' }, randomUUID());
  const mcp: Actor = { ...owner, source: 'mcp', credentialId: credential.id };
  const mcpTask = await resources.createTask(mcp, project.id, { title: 'MCP 分配', assigneeId: member.userId }, randomUUID());
  expect((await notifications.unreadNotifications(member)).unreadCount).toBe(2);
  expect(await one(db, sql`SELECT source FROM notification_events WHERE task_id=${mcpTask.id}`)).toEqual({ source: 'mcp' });
  const selfTask = await resources.createTask(owner, project.id, { title: '自分配', assigneeId: owner.userId }, randomUUID());
  expect((await notifications.unreadNotifications(owner)).unreadCount).toBe(1);
  expect((await notifications.listNotifications(owner)).items[0]).toMatchObject({ taskId: selfTask.id, actorName: '你' });
  await resources.addComment(owner, project.id, selfTask.id, '自评论', randomUUID());
  expect((await notifications.unreadNotifications(owner)).unreadCount).toBe(1);
  const reassigned = await resources.createTask(owner, project.id, { title: '重新指派给自己' }, randomUUID());
  await resources.updateTask(owner, project.id, reassigned.id, { assigneeId: owner.userId }, 1, randomUUID());
  expect((await notifications.unreadNotifications(owner)).unreadCount).toBe(2);
  await expect(notifications.listNotifications(mcp)).rejects.toMatchObject({ code: 'CREDENTIAL_SCOPE' });
});

it('isolates inbox/read state, preserves later messages during read-all and hides inaccessible resources', async () => {
  const { owner, member, other, project } = await fixture();
  const task = await resources.createTask(owner, project.id, { title: '权限消息', assigneeId: member.userId }, randomUUID());
  const first = await notifications.listNotifications(member);
  const id = first.items[0].id;
  await expect(notifications.markNotificationRead(other, id, randomUUID())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(notifications.markNotificationRead(owner, id, randomUUID())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  const readOp = randomUUID();
  await notifications.markNotificationRead(member, id, readOp);
  await notifications.markNotificationRead(member, id, readOp);
  expect((await notifications.listNotifications(member, { status: 'unread' })).total).toBe(0);
  expect(await resources.getResource(owner, project.id, 'task', task.id)).toMatchObject({ status: 'todo' });
  await resources.addComment(owner, project.id, task.id, '第一条评论', randomUUID());
  const snapshot = await notifications.listNotifications(member);
  await resources.addComment(owner, project.id, task.id, '快照后的评论', randomUUID());
  await notifications.markAllNotificationsRead(member, { asOf: snapshot.asOf }, randomUUID());
  expect((await notifications.unreadNotifications(member)).unreadCount).toBe(1);
  await db.execute(sql`DELETE FROM project_members WHERE project_id=${project.id} AND user_id=${member.userId}`);
  expect((await notifications.listNotifications(member)).total).toBe(0);
  expect((await notifications.unreadNotifications(member)).unreadCount).toBe(0);
  await expect(notifications.markNotificationRead(member, id, randomUUID())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await db.execute(sql`INSERT INTO project_members(project_id,user_id,role) VALUES(${project.id},${member.userId},'member')`);
  await resources.lifecycle(owner, project.id, 'task', task.id, 'delete', 1, randomUUID());
  expect((await notifications.listNotifications(member)).total).toBe(0);
  const another = await resources.createTask(owner, project.id, { title: '项目删除', assigneeId: member.userId }, randomUUID());
  expect((await notifications.listNotifications(member)).items[0].taskId).toBe(another.id);
  await resources.lifecycle(owner, project.id, 'project', project.id, 'delete', 1, randomUUID());
  expect((await notifications.listNotifications(member)).total).toBe(0);
});

it('rolls back the business write, event and inbox if delivery persistence fails', async () => {
  const { owner, member, project } = await fixture();
  const functionName = `notification_fail_${randomUUID().replaceAll('-', '')}`;
  const fn = sql.identifier(functionName);
  // Both identifiers and recipient UUID are generated by this fixture.
  await db.execute(sql`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS ${sql.raw(`$$BEGIN IF NEW.destination_key = '${member.userId}' THEN RAISE EXCEPTION 'injected notification failure'; END IF; RETURN NEW; END;$$`)}`);
  await db.execute(sql`CREATE TRIGGER ${fn} BEFORE INSERT ON notification_deliveries FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
  try {
    await expect(resources.createTask(owner, project.id, { title: '必须回滚', assigneeId: member.userId }, randomUUID())).rejects.toThrow();
    expect((await resources.listTasks(owner, project.id)).items).toHaveLength(0);
    expect(await one(db, sql`SELECT count(*)::int AS count FROM notification_events WHERE project_id=${project.id}`)).toEqual({ count: 0 });
    expect((await notifications.listNotifications(member)).total).toBe(0);
  } finally {
    await db.execute(sql`DROP TRIGGER ${fn} ON notification_deliveries`);
    await db.execute(sql`DROP FUNCTION ${fn}()`);
  }
});

it('repairs missed self-assignment once without duplicating it on retry', async () => {
  const { owner, project } = await fixture();
  const task = await resources.createTask(owner, project.id, { title: '修复以前的自分配', assigneeId: owner.userId }, randomUUID());
  const event = await one<{ id: string }>(db, sql`SELECT id FROM notification_events WHERE task_id=${task.id}`);
  await db.execute(sql`DELETE FROM notification_deliveries WHERE notification_id IN (SELECT id FROM notifications WHERE event_id=${event!.id})`);
  await db.execute(sql`DELETE FROM notifications WHERE event_id=${event!.id}`);
  await db.execute(sql`DELETE FROM notification_events WHERE id=${event!.id}`);
  expect((await notifications.unreadNotifications(owner)).unreadCount).toBe(0);
  const migration = await readFile(new URL('../apps/server/migrations/0006_repair_self_assignment_notifications.sql', import.meta.url), 'utf8');
  await db.execute(sql.raw(migration));
  await db.execute(sql.raw(migration));
  expect((await notifications.unreadNotifications(owner)).unreadCount).toBe(1);
  expect((await notifications.listNotifications(owner)).items).toMatchObject([expect.objectContaining({ taskId: task.id, actorName: '你' })]);
});

it('paginates consistently and exposes authenticated HTTP read endpoints', async () => {
  const { owner, member, project } = await fixture();
  const task = await resources.createTask(owner, project.id, { title: '分页提醒', assigneeId: member.userId }, randomUUID());
  for (let i = 0; i < 21; i++) await resources.addComment(owner, project.id, task.id, `评论 ${i}`, randomUUID());
  const first = await notifications.listNotifications(member);
  const last = await notifications.listNotifications(member, { page: 999 });
  expect(first.items).toHaveLength(20);
  expect(last).toMatchObject({ page: 2, total: 22 });
  expect(last.items).toHaveLength(2);
  expect(last.items.some(item => first.items.some(a => a.id === item.id))).toBe(false);
  await expect(notifications.listNotifications(member, { page: 0 })).rejects.toThrow();
  await expect(notifications.listNotifications(member, { status: 'invalid' })).rejects.toThrow();
  const session = vi.spyOn(auth.api, 'getSession').mockResolvedValue({ user: { id: member.userId } } as any);
  try {
    const count = await app.request('/api/notifications/unread-count');
    expect(count.status).toBe(200); expect(await count.json()).toEqual({ unreadCount: 22 });
    const response = await app.request('/api/notifications?status=unread&page=2');
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ total: 22, page: 2 });
    const read = await app.request(`/api/notifications/${first.items[0].id}/read`, { method: 'POST', headers: { Origin: new URL(config.APP_URL).origin, 'Idempotency-Key': randomUUID() } });
    expect(read.status).toBe(200);
    session.mockResolvedValue(null);
    expect((await app.request('/api/notifications')).status).toBe(401);
  } finally { session.mockRestore(); }
});
