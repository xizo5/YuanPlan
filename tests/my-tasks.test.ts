import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, pool } from '../apps/server/src/db';
import { migrate } from '../apps/server/src/db/migrate';
import { createProject } from '../apps/server/src/modules/projects';
import { myTasks } from '../apps/server/src/modules/resources';
import type { Actor } from '../apps/server/src/modules/core';

const owner: Actor = { userId: randomUUID(), source: 'web' };
const other: Actor = { userId: randomUUID(), source: 'web' };
let projectId: string;
beforeAll(async () => {
  await migrate(process.env.TEST_DATABASE_URL);
  for (const actor of [owner, other]) await db.execute(sql`INSERT INTO users(id,name,email,identity_source)
    VALUES(${actor.userId},'My tasks test',${actor.userId + '@example.test'},'invite')`);
  projectId = (await createProject(owner, { name: 'My tasks pagination' }, randomUUID())).id;
  await db.execute(sql`INSERT INTO tasks(id,project_id,number,title,description,creator_id,assignee_id,status,priority)
    SELECT gen_random_uuid(),${projectId},n,'任务-' || lpad(n::text,2,'0'),'{"type":"doc","content":[]}'::jsonb,
      ${owner.userId},${owner.userId},CASE WHEN n<=12 THEN 'todo' ELSE 'done' END,
      CASE WHEN n%2=0 THEN 'high' ELSE 'normal' END FROM generate_series(1,25) n`);
});
afterAll(async () => { await pool.end(); });

it('paginates my tasks with combined filters, stable ordering, title-only search and permission boundaries', async () => {
  const first = await myTasks(owner, {});
  const second = await myTasks(owner, { page: '2' });
  expect(first).toMatchObject({ total: 25, page: 1, pageSize: 10 });
  expect(first.items).toHaveLength(10);
  expect(second.items).toHaveLength(10);
  expect(second.items.some(t => first.items.some(a => a.id === t.id))).toBe(false);
  expect((await myTasks(owner, {})).items.map(t => t.id)).toEqual(first.items.map(t => t.id));
  expect(await myTasks(owner, { page: 999 })).toMatchObject({ total: 25, page: 3 });
  expect((await myTasks(owner, { pageSize: 20 })).items).toHaveLength(20);
  expect((await myTasks(owner, { pageSize: 50 })).items).toHaveLength(25);
  expect(await myTasks(owner, { query: '任务-25' })).toMatchObject({ total: 1, items: [expect.objectContaining({ title: '任务-25' })] });
  expect(await myTasks(owner, { query: '任务-0', status: 'todo', priority: 'high' })).toMatchObject({ total: 4 });
  expect(await myTasks(owner, { status: 'done', priority: 'high' })).toMatchObject({ total: 6 });
  expect(await myTasks(owner, { query: 'missing', page: 9 })).toMatchObject({ total: 0, page: 1, items: [] });
  expect((await myTasks(other)).total).toBe(0);
  await db.execute(sql`UPDATE tasks SET title='literal%_name' WHERE project_id=${projectId} AND number=25`);
  expect((await myTasks(owner, { query: '%_' })).total).toBe(1);
  await db.execute(sql`UPDATE tasks SET description='{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"description-only"}]}]}'::jsonb WHERE project_id=${projectId}`);
  expect((await myTasks(owner, { query: 'description-only' })).total).toBe(0);
  await db.execute(sql`UPDATE tasks SET archived_at=now() WHERE project_id=${projectId} AND number=1`);
  await db.execute(sql`UPDATE tasks SET deleted_at=now() WHERE project_id=${projectId} AND number=2`);
  await db.execute(sql`UPDATE tasks SET assignee_id=${other.userId} WHERE project_id=${projectId} AND number=3`);
  expect((await myTasks(owner)).total).toBe(22);
  expect((await myTasks(other)).total).toBe(0); // Assignment alone does not grant project access.
  await db.execute(sql`UPDATE projects SET archived_at=now() WHERE id=${projectId}`);
  expect((await myTasks(owner)).total).toBe(0);
  await db.execute(sql`UPDATE projects SET archived_at=NULL,deleted_at=now() WHERE id=${projectId}`);
  expect((await myTasks(owner)).total).toBe(0);
  await db.execute(sql`UPDATE projects SET deleted_at=NULL WHERE id=${projectId}`);
  await db.execute(sql`DELETE FROM project_members WHERE project_id=${projectId} AND user_id=${owner.userId}`);
  expect((await myTasks(owner)).total).toBe(0);
});

it('rejects invalid paging and filter inputs', async () => {
  for (const input of [{ page: 0 }, { page: 1.5 }, { pageSize: 500 }, { status: 'invalid' }, { priority: 'invalid' }, { query: 'a'.repeat(201) }]) {
    await expect(myTasks(owner, input)).rejects.toBeTruthy();
  }
});
