import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { defaultOverviewLayout, overviewWidgetKinds, type OverviewLayout, type Task } from '@yuanplan/contracts';
import { db, one, pool } from '../apps/server/src/db';
import { migrate } from '../apps/server/src/db/migrate';
import { projectOverview, saveOverviewLayout } from '../apps/server/src/modules/overview';
import { createProject } from '../apps/server/src/modules/projects';
import { listTasks } from '../apps/server/src/modules/resources';
import { createCredential, credentialActor } from '../apps/server/src/modules/credentials';
import { createInvitation, register } from '../apps/server/src/modules/accounts';
import { app } from '../apps/server/src/app';
import { config } from '../apps/server/src/config';
import type { Actor } from '../apps/server/src/modules/core';

const admin: Actor = { userId: randomUUID(), source: 'web' };
const member: Actor = { userId: randomUUID(), source: 'web' };
const viewer: Actor = { userId: randomUUID(), source: 'web' };
const outsider: Actor = { userId: randomUUID(), source: 'web' };

beforeAll(async () => {
  await migrate(process.env.TEST_DATABASE_URL);
  for (const [index, actor] of [admin, member, viewer, outsider].entries()) await db.execute(sql`INSERT INTO users(id,name,email,is_admin,identity_source)
    VALUES(${actor.userId},${`Overview ${index}`},${`${actor.userId}@example.test`},${actor === outsider},'invite')`);
});
afterAll(async () => { await pool.end(); });

async function fixture() {
  const project = await createProject(admin, { name: 'Overview fixture' }, randomUUID());
  for (const [actor, role] of [[member, 'member'], [viewer, 'viewer']] as const) await db.execute(sql`INSERT INTO project_members(project_id,user_id,role) VALUES(${project.id},${actor.userId},${role})`);
  return project.id;
}
async function task(projectId: string, number: number, overrides: Partial<Task> = {}) {
  const id = randomUUID();
  await db.execute(sql`INSERT INTO tasks(id,project_id,number,title,description,creator_id,status,priority,assignee_id,parent_id,due_date,archived_at,deleted_at)
    VALUES(${id},${projectId},${number},${overrides.title ?? `Overview task ${number}`},'{"type":"doc","content":[]}',${admin.userId},
    ${overrides.status ?? 'todo'},${overrides.priority ?? 'normal'},${overrides.assigneeId ?? null},${overrides.parentId ?? null},
    ${overrides.dueDate ?? null},${overrides.archivedAt ?? null},${overrides.deletedAt ?? null})`);
  return id;
}
async function allTasks(projectId: string, options: Parameters<typeof listTasks>[2]) {
  const tasks: Task[] = [];
  let cursor: string | undefined;
  do { const page = await listTasks(viewer, projectId, { ...options, cursor }); tasks.push(...page.items); cursor = page.nextCursor ?? undefined; } while (cursor);
  return tasks;
}

describe('project overview statistics and layout', () => {
  it('returns a shared default without persisting anything, including for empty projects', async () => {
    const id = await fixture();
    const empty = await projectOverview(viewer, id);
    expect(empty).toMatchObject({ layout: defaultOverviewLayout, version: 0, summary: { total: 0, completed: 0, unfinished: 0, overdue: 0, upcoming: 0, attention: 0, unassigned: 0 }, assignees: [], attention: [] });
    expect(empty.statuses.every(item => item.count === 0)).toBe(true);
    expect(await one(db, sql`SELECT * FROM project_overviews WHERE project_id=${id}`)).toBeUndefined();
    expect((await projectOverview(member, id)).layout).toEqual(empty.layout);
  });

  it('counts all active root tasks, with matching paginated drilldowns and no duplicate attention tasks', async () => {
    const id = await fixture();
    const today = (await projectOverview(admin, id)).today;
    const plus = (days: number) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
    const overdue = await task(id, 1, { priority: 'urgent', dueDate: plus(-1), assigneeId: member.userId });
    await task(id, 2, { status: 'in_progress', dueDate: today, assigneeId: member.userId });
    await task(id, 3, { status: 'in_review', dueDate: plus(7), assigneeId: admin.userId });
    await task(id, 4, { dueDate: plus(8), assigneeId: admin.userId });
    await task(id, 5, { priority: 'high' });
    await task(id, 6, { status: 'done', priority: 'urgent', dueDate: plus(-10) });
    await task(id, 7, { parentId: overdue, priority: 'urgent', dueDate: plus(-1) });
    await task(id, 8, { archivedAt: new Date().toISOString(), dueDate: plus(-1) });
    await task(id, 9, { deletedAt: new Date().toISOString(), dueDate: plus(-1) });
    for (let n = 10; n < 45; n++) await task(id, n);
    await task(await fixture(), 1, { dueDate: plus(-1), priority: 'urgent' });
    const data = await projectOverview(viewer, id);
    expect(data.summary).toEqual({ total: 41, completed: 1, unfinished: 40, overdue: 1, upcoming: 2, attention: 4, unassigned: 36 });
    expect(data.statuses).toEqual([{ status: 'todo', count: 38 }, { status: 'in_progress', count: 1 }, { status: 'in_review', count: 1 }, { status: 'done', count: 1 }]);
    expect(data.priorities).toEqual([{ priority: 'low', count: 0 }, { priority: 'normal', count: 38 }, { priority: 'high', count: 1 }, { priority: 'urgent', count: 1 }]);
    expect(data.assignees.find(a => a.assigneeId === member.userId)).toMatchObject({ count: 2, overdue: 1 });
    expect(data.attention).toHaveLength(4);
    expect(new Set(data.attention.map(t => t.id)).size).toBe(4);
    expect(data.attention[0].id).toBe(overdue);
    for (const focus of ['unfinished', 'overdue', 'upcoming', 'attention'] as const) {
      const drilldown = await allTasks(id, { roots: true, focus, asOfDate: data.today });
      expect(drilldown).toHaveLength(data.summary[focus]);
    }
    expect(await allTasks(id, { roots: true, focus: 'unfinished', asOfDate: data.today, priority: 'urgent' })).toHaveLength(1);
    expect(await allTasks(id, { roots: true, focus: 'unfinished', asOfDate: data.today, assigneeId: 'unassigned' })).toHaveLength(36);
  });

  it('keeps attention empty when all tasks are done, including overdue and undated urgent tasks', async () => {
    const id = await fixture();
    await task(id, 1, { status: 'done', priority: 'high', dueDate: '2020-01-01' });
    await task(id, 2, { status: 'done', priority: 'urgent' });
    const data = await projectOverview(viewer, id);
    expect(data.summary).toMatchObject({ total: 2, completed: 2, unfinished: 0, attention: 0 });
    expect(data.attention).toEqual([]);
    expect(await allTasks(id, { roots: true, focus: 'attention', asOfDate: data.today })).toEqual([]);
  });

  it('uses the viewer timezone for today and rejects invalid dates and focus values', async () => {
    const id = await fixture();
    await task(id, 1, { dueDate: '2030-01-01' });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-01T16:01:00Z'));
    try {
      const utc = await projectOverview(admin, id, { timeZone: 'UTC' });
      const local = await projectOverview(admin, id, { timeZone: 'Asia/Shanghai' });
      expect(utc).toMatchObject({ today: '2030-01-01', summary: { overdue: 0, upcoming: 1 } });
      expect(local).toMatchObject({ today: '2030-01-02', summary: { overdue: 1, upcoming: 0 } });
      expect(await allTasks(id, { roots: true, focus: 'overdue', asOfDate: local.today })).toHaveLength(1);
      await expect(projectOverview(admin, id, { timeZone: 'invalid-zone' })).rejects.toBeTruthy();
      for (const options of [{ focus: 'invalid', asOfDate: local.today }, { focus: 'overdue' }, { focus: 'overdue', asOfDate: '' }, { focus: 'overdue', asOfDate: '2026-02-30' }]) await expect(listTasks(admin, id, options)).rejects.toBeTruthy();
    } finally { vi.useRealTimers(); }
  });

  it('enforces membership and credential scope, even for system administrators', async () => {
    const id = await fixture();
    await expect(projectOverview(outsider, id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    for (const actor of [member, viewer]) await expect(saveOverviewLayout(actor, id, { layout: defaultOverviewLayout, expectedVersion: 0 }, randomUUID())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const credential = await createCredential(admin, { name: 'overview readonly', scope: 'read', projectIds: [id] }, randomUUID());
    const actor = await credentialActor(credential.token);
    expect((await projectOverview(actor, id)).summary.total).toBe(0);
    await expect(projectOverview(actor, await fixture())).rejects.toMatchObject({ code: 'CREDENTIAL_SCOPE' });
    await expect(saveOverviewLayout(actor, id, { layout: defaultOverviewLayout, expectedVersion: 0 }, randomUUID())).rejects.toMatchObject({ code: 'CREDENTIAL_SCOPE' });
    await db.execute(sql`UPDATE projects SET archived_at=now() WHERE id=${id}`);
    expect((await projectOverview(viewer, id)).summary.total).toBe(0);
    await expect(saveOverviewLayout(admin, id, { layout: defaultOverviewLayout, expectedVersion: 0 }, randomUUID())).rejects.toMatchObject({ code: 'PROJECT_READONLY' });
    await db.execute(sql`UPDATE projects SET deleted_at=now() WHERE id=${id}`);
    await expect(projectOverview(admin, id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('saves a shared layout with retry deduplication, independent versions and auditing', async () => {
    const id = await fixture();
    const layout: OverviewLayout = { columns: 1, widgets: [{ kind: 'unassigned', width: 'full' }, { kind: 'status', width: 'half' }, { kind: 'upcoming', width: 'half' }] };
    for (let number = 1; number <= 12; number++) await task(id, number, { dueDate: (await projectOverview(admin, id)).today });
    const op = randomUUID(), input = { layout, expectedVersion: 0 };
    expect(await saveOverviewLayout(admin, id, input, op)).toEqual({ layout, version: 1 });
    expect(await saveOverviewLayout(admin, id, input, op)).toEqual({ layout, version: 1 });
    const shared = await projectOverview(viewer, id);
    expect(shared).toMatchObject({ layout, version: 1, summary: { unassigned: 12, upcoming: 12 } });
    expect(shared.unassigned).toHaveLength(8);
    expect(shared.upcoming).toHaveLength(8);
    expect(shared.attention).toEqual([]); // Hidden task lists are not queried or transferred.
    expect((await one(db, sql`SELECT version FROM projects WHERE id=${id}`))!.version).toBe(1);
    expect((await one(db, sql`SELECT count(*)::int count FROM audit_events WHERE project_id=${id} AND resource_type='project_overview'`))!.count).toBe(1);
    await expect(saveOverviewLayout(admin, id, { layout: defaultOverviewLayout, expectedVersion: 0 }, randomUUID())).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(saveOverviewLayout(admin, id, { layout: defaultOverviewLayout, expectedVersion: 1 }, op)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const changes = await Promise.allSettled([saveOverviewLayout(admin, id, { layout: defaultOverviewLayout, expectedVersion: 1 }, randomUUID()), saveOverviewLayout(admin, id, { layout, expectedVersion: 1 }, randomUUID())]);
    expect(changes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((changes.find(result => result.status === 'rejected') as PromiseRejectedResult).reason.code).toBe('VERSION_CONFLICT');
  });

  it('validates allowed widget types, widths, count, uniqueness and version', async () => {
    const id = await fixture();
    for (const layout of [
      { columns: 3, widgets: defaultOverviewLayout.widgets }, { columns: 2, widgets: [] },
      { columns: 2, widgets: [{ kind: 'unknown', width: 'half' }] }, { columns: 2, widgets: [{ kind: 'status', width: 'unknown' }] },
      { columns: 2, widgets: [{ kind: 'status', width: 'half' }, { kind: 'status', width: 'full' }] },
      { columns: 2, widgets: [...overviewWidgetKinds.map(kind => ({ kind, width: 'half' })), { kind: 'status', width: 'half' }] },
    ]) await expect(saveOverviewLayout(admin, id, { layout, expectedVersion: 0 }, randomUUID())).rejects.toBeTruthy();
    await expect(saveOverviewLayout(admin, id, { layout: defaultOverviewLayout, expectedVersion: -1 }, randomUUID())).rejects.toBeTruthy();
    expect(await one(db, sql`SELECT * FROM project_overviews WHERE project_id=${id}`)).toBeUndefined();
  });

  it('serves statistics and layout updates through authenticated HTTP with CSRF protection', async () => {
    const id = await fixture(), email = `${randomUUID()}@example.test`, password = 'Overview-test-password-123';
    const invitation = await createInvitation(admin, 'project', id, email, 'admin', randomUUID());
    await register({ email, name: 'Overview HTTP admin', password, inviteToken: new URL(invitation.url).searchParams.get('token') });
    const login = await app.request(`${config.APP_URL}/api/auth/sign-in/email`, { method: 'POST', headers: { Origin: config.APP_URL, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    expect(login.status).toBe(200);
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const read = await app.request(`${config.APP_URL}/api/projects/${id}/overview?timeZone=Asia%2FShanghai`, { headers: { Cookie: cookie } });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ version: 0, layout: defaultOverviewLayout });
    const path = `${config.APP_URL}/api/projects/${id}/overview/layout`;
    const body = JSON.stringify({ layout: defaultOverviewLayout, expectedVersion: 0 });
    const saved = await app.request(path, { method: 'PUT', headers: { Cookie: cookie, Origin: config.APP_URL, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body });
    expect(saved.status, await saved.clone().text()).toBe(200);
    expect(await saved.json()).toMatchObject({ version: 1 });
    expect((await app.request(path, { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body })).status).toBe(403);
    expect((await app.request(`${config.APP_URL}/api/projects/${id}/overview`)).status).toBe(401);
  });
});
