import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { ScheduledTask } from '@yuanplan/contracts';
import { db, pool } from '../apps/server/src/db';
import { migrate } from '../apps/server/src/db/migrate';
import { createProject } from '../apps/server/src/modules/projects';
import { taskSchedule } from '../apps/server/src/modules/task-schedule';
import { listTasks, updateTask } from '../apps/server/src/modules/resources';
import { createCredential, credentialActor, revokeCredential } from '../apps/server/src/modules/credentials';
import type { Actor } from '../apps/server/src/modules/core';
import { addDays, calendarRange, datesBetween, monday, shiftMonth, taskInterval, tasksOnDay, timelinePosition, timelineRange, weekSegments, orderTimelineTasks } from '../apps/web/src/schedule-layout';

const admin: Actor = { userId: randomUUID(), source: 'web' };
const viewer: Actor = { userId: randomUUID(), source: 'web' };
const outsider: Actor = { userId: randomUUID(), source: 'web' };
const range = { from: '2026-09-01', to: '2026-09-30' };
beforeAll(async () => {
  await migrate(process.env.TEST_DATABASE_URL);
  for (const actor of [admin, viewer, outsider]) await db.execute(sql`INSERT INTO users(id,name,email,is_admin,identity_source) VALUES(${actor.userId},'Schedule tester',${actor.userId + '@example.test'},true,'invite')`);
});
afterAll(async () => { await pool.end(); });
async function fixture() { const project = await createProject(admin, { name: 'Task date views' }, randomUUID()); await db.execute(sql`INSERT INTO project_members(project_id,user_id,role) VALUES(${project.id},${viewer.userId},'viewer')`); return project.id; }
async function insert(projectId: string, number: number, changes: Partial<ScheduledTask> & { archived?: boolean; deleted?: boolean; label?: string } = {}) {
  const id = randomUUID();
  await db.execute(sql`INSERT INTO tasks(id,project_id,number,title,description,creator_id,status,priority,assignee_id,parent_id,start_date,due_date,labels,archived_at,deleted_at)
    VALUES(${id},${projectId},${number},${changes.title ?? `排期任务 ${number}`},'{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"description-only-needle"}]}]}'::jsonb,${admin.userId},${changes.status ?? 'todo'},${changes.priority ?? 'normal'},${changes.assigneeId ?? null},${changes.parentId ?? null},${changes.startDate ?? null},${changes.dueDate ?? null},${JSON.stringify(changes.label ? [changes.label] : [])}::jsonb,${changes.archived ? new Date() : null},${changes.deleted ? new Date() : null})`);
  return id;
}
describe('scheduled task reads', () => {
  it('includes intersecting intervals, both date boundaries and single-date points, with unplanned tasks separate', async () => {
    const id = await fixture();
    const cases = [
      { startDate: '2026-08-20', dueDate: '2026-10-10' }, { startDate: '2026-08-30', dueDate: '2026-09-01' },
      { startDate: '2026-09-30', dueDate: '2026-10-01' }, { dueDate: '2026-09-01' }, { startDate: '2026-09-30' },
      { startDate: '2026-09-15', dueDate: '2026-09-15' }, {}, { dueDate: '2026-08-31' }, { startDate: '2026-10-01' },
      { startDate: '2026-07-01', dueDate: '2026-08-31' }, { dueDate: '2026-09-10', archived: true }, { dueDate: '2026-09-10', deleted: true },
    ];
    for (const [index, changes] of cases.entries()) await insert(id, index + 1, changes);
    await insert(await fixture(), 1, { dueDate: '2026-09-10' });
    const data = await taskSchedule(viewer, id, range);
    expect(data).toMatchObject({ total: 6, unscheduledTotal: 1, nextCursor: null });
    expect(data.items.map(task => task.number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(data.items.every(task => !('description' in task) && !('creatorId' in task))).toBe(true);
    expect(data.items.find(t => t.number === 4)).toMatchObject({ startDate: null, dueDate: '2026-09-01' });
    expect(await taskSchedule(viewer, id, { ...range, bucket: 'unscheduled' })).toMatchObject({ total: 1, items: [expect.objectContaining({ number: 7 })] });
    expect(await taskSchedule(viewer, id, { from: '2027-01-01', to: '2027-01-31' })).toMatchObject({ total: 0, unscheduledTotal: 1 });
  });
  it('shares all task filters, escapes literal search and preserves independent child dates', async () => {
    const id = await fixture();
    const parentId = await insert(id, 1, { startDate: '2026-09-02', dueDate: '2026-09-04', title: 'Parent' });
    const childId = await insert(id, 2, { parentId, title: 'literal%_name', startDate: '2026-09-12', dueDate: '2026-09-15', status: 'in_review', priority: 'high', assigneeId: viewer.userId, label: 'Release' });
    await insert(id, 3, { dueDate: '2026-09-03', status: 'done', priority: 'high', assigneeId: viewer.userId });
    await insert(id, 4, { priority: 'high', assigneeId: viewer.userId, label: 'Release', status: 'in_review' });
    const options = { query: '%_', status: 'in_review', priority: 'high', assigneeId: viewer.userId, label: 'Release', dueFrom: '2026-09-15', dueTo: '2026-09-15' };
    expect((await taskSchedule(viewer, id, { ...range, ...options })).items).toMatchObject([{ id: childId, parentNumber: 1, parentTitle: 'Parent', startDate: '2026-09-12', dueDate: '2026-09-15' }]);
    expect((await listTasks(viewer, id, options)).items.map(task => task.id)).toEqual([childId]);
    expect((await taskSchedule(viewer, id, { ...range, roots: 'true' })).items.map(task => task.number)).toEqual([1, 3]);
    expect((await taskSchedule(viewer, id, { ...range, query: 'description-only-needle' })).total).toBe(3);
    expect((await taskSchedule(viewer, id, { ...range, assigneeId: 'unassigned' })).total).toBe(1);
    expect((await taskSchedule(viewer, id, { ...range, focus: 'overdue', asOfDate: '2026-09-10' })).items.map(t => t.id)).toEqual([parentId]);
    const parent = (await taskSchedule(viewer, id, range)).items.find(task => task.id === parentId)!;
    expect(parent).toMatchObject({ startDate: '2026-09-02', dueDate: '2026-09-04' });
  });
  it('paginates planned and unplanned tasks without silently capping totals, then updates after manual saving', async () => {
    const id = await fixture();
    await db.execute(sql`INSERT INTO tasks(id,project_id,number,title,description,creator_id,start_date,due_date)
      SELECT gen_random_uuid(),${id},n,'Batch ' || n,'{"type":"doc","content":[{"type":"paragraph"}]}'::jsonb,${admin.userId},CASE WHEN n<=105 THEN '2026-09-01'::date ELSE NULL END,CASE WHEN n<=105 THEN '2026-09-30'::date ELSE NULL END FROM generate_series(1,207) n`);
    const first = await taskSchedule(admin, id, range);
    expect(first).toMatchObject({ total: 105, unscheduledTotal: 102, nextCursor: '100' }); expect(first.items).toHaveLength(100);
    const second = await taskSchedule(admin, id, { ...range, cursor: first.nextCursor }); expect(second.items).toHaveLength(5);
    expect(new Set([...first.items, ...second.items].map(t => t.id)).size).toBe(105);
    const unplanned = await taskSchedule(admin, id, { ...range, bucket: 'unscheduled' }); expect(unplanned).toMatchObject({ total: 102, nextCursor: '100' });
    expect((await taskSchedule(admin, id, { ...range, bucket: 'unscheduled', cursor: '100' })).items).toHaveLength(2);
    const task = unplanned.items[0];
    await updateTask(admin, id, task.id, { startDate: '2026-09-29', dueDate: '2026-10-03' }, 1, randomUUID());
    expect(await taskSchedule(admin, id, range)).toMatchObject({ total: 106, unscheduledTotal: 101 });
    await updateTask(admin, id, task.id, { startDate: '2026-10-10', dueDate: '2026-10-13' }, 2, randomUUID());
    expect(await taskSchedule(admin, id, range)).toMatchObject({ total: 105, unscheduledTotal: 101 });
  });
  it('enforces project and credential read permissions and retains archived read-only behavior', async () => {
    const id = await fixture(); await insert(id, 1, { dueDate: '2026-09-20' });
    await expect(taskSchedule(outsider, id, range)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const token = await createCredential(admin, { name: 'Schedule read', scope: 'read', projectIds: [id] }, randomUUID()); const actor = await credentialActor(token.token);
    expect((await taskSchedule(actor, id, range)).total).toBe(1);
    await expect(taskSchedule(actor, await fixture(), range)).rejects.toMatchObject({ code: 'CREDENTIAL_SCOPE' });
    await revokeCredential(admin, token.id, randomUUID()); await expect(taskSchedule(actor, id, range)).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' });
    await db.execute(sql`UPDATE projects SET archived_at=now() WHERE id=${id}`); expect((await taskSchedule(viewer, id, range)).total).toBe(1);
    await db.execute(sql`UPDATE projects SET deleted_at=now() WHERE id=${id}`); await expect(taskSchedule(admin, id, range)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('rejects invalid dates, reversed or excessive ranges and bad paging', async () => {
    const id = await fixture();
    for (const input of [{ ...range, from: '2026-02-30' }, { ...range, from: '2026-10-01' }, { from: '2026-01-01', to: '2026-12-31' }, { ...range, bucket: 'unknown' }, { ...range, cursor: '-1' }, { ...range, cursor: '1.5' }, { ...range, focus: 'overdue' }, { ...range, status: 'invalid' }]) await expect(taskSchedule(admin, id, input)).rejects.toBeTruthy();
    expect((await taskSchedule(admin, id, { from: '2026-01-01', to: '2026-04-30' })).total).toBe(0);
  });
});

const sample = (id: string, number: number, startDate: string | null, dueDate: string | null, other: Partial<ScheduledTask> = {}): ScheduledTask => ({ id, projectId: 'p', number, title: id, status: 'todo', priority: 'normal', assigneeId: null, parentId: null, startDate, dueDate, ...other });
describe('calendar and timeline placement', () => {
  it('builds full Monday-Sunday months across year, leap day and daylight-saving changes', () => {
    expect(calendarRange('2026-09-30')).toEqual({ from: '2026-08-31', to: '2026-10-04' });
    expect(calendarRange('2024-02-29')).toEqual({ from: '2024-01-29', to: '2024-03-03' });
    expect(monday('2026-01-04')).toBe('2025-12-29'); expect(shiftMonth('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09'); expect(datesBetween('2026-03-07', '2026-03-10')).toHaveLength(4);
    const daily = timelineRange('2026-09-30', 'day'), weekly = timelineRange('2026-09-30', 'week');
    expect(datesBetween(daily.from, daily.to)).toHaveLength(42); expect(datesBetween(weekly.from, weekly.to)).toHaveLength(84);
  });
  it('uses date points only for missing endpoints and clips periods while preserving inclusive same-day duration', () => {
    const interval = sample('span', 1, '2026-08-25', '2026-10-05');
    const start = sample('start', 2, '2026-09-01', null), due = sample('due', 3, null, '2026-09-30'), same = sample('same', 4, '2026-09-15', '2026-09-15');
    expect(taskInterval(start)).toMatchObject({ point: true }); expect(taskInterval(due)).toMatchObject({ point: true }); expect(taskInterval(same)).toMatchObject({ point: false });
    expect(timelinePosition(interval, range.from, range.to)).toMatchObject({ left: 0, width: 100, before: true, after: true, point: false });
    expect(timelinePosition(due, range.from, range.to)).toMatchObject({ point: true });
    expect(timelinePosition(same, range.from, range.to)!.width).toBeCloseTo(100 / 30);
    expect(timelinePosition(sample('outside', 9, '2026-10-01', null), range.from, range.to)).toBeNull();
    expect(taskInterval(sample('none', 5, null, null))).toBeNull();
    expect(tasksOnDay([interval, start, due, same], '2026-09-15').map(t => t.id)).toEqual(['span', 'same']);
  });
  it('segments crossing weeks without overlapping lanes and preserves parent-child order', () => {
    const parent = sample('parent', 1, '2026-09-24', '2026-10-02');
    const child = sample('child', 5, null, '2026-09-30', { parentId: 'parent', parentNumber: 1 });
    const overlap = [parent, ...[2, 3, 4].map(n => sample(`t${n}`, n, '2026-09-29', '2026-10-01')), child];
    const segments = weekSegments(overlap, '2026-09-28');
    expect(segments.find(s => s.task.id === 'parent')).toMatchObject({ before: true, after: false, column: 0, span: 5 });
    expect(segments.some(s => s.lane >= 3)).toBe(true);
    for (const a of segments) for (const b of segments) if (a !== b && a.lane === b.lane) expect(a.column + a.span <= b.column || b.column + b.span <= a.column).toBe(true);
    expect(orderTimelineTasks([child, overlap[1], parent]).map(t => t.id)).toEqual(['parent', 'child', 't2']);
  });
});
