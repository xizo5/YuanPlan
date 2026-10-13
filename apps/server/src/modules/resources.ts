import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { taskInput, documentInput, versionSchema, statuses, priorities, type Task, type Document, type TaskStatus } from '@yuanplan/contracts';
import { emptyDoc, validateDoc, docText, imageIds, fromMarkdown, toMarkdown } from '@yuanplan/editor-schema';
import { db, rows, one, type Database } from '../db/index.js';
import { mutate, audit, read, liveUser, access, checkVersion, paging, page, credentialProjectFilter, type Actor, type Context } from './core.js';
import { assert, AppError } from '../lib/errors.js';

import { ensureLabels } from './labels.js';
import { publishTaskNotification } from './notifications.js';
import { prepareCommentFiles, storeCommentFiles } from './files.js';
import { taskQueryScope, type TaskQuery } from './task-query.js';

export type Kind = 'task' | 'document';
const table = (kind: Kind) => kind === 'task' ? sql`tasks` : sql`documents`;
function content(input: unknown) { try { return validateDoc(input ?? emptyDoc); } catch (e) { throw new AppError(400, 'INVALID_DOCUMENT', (e as Error).message); } }
async function validateFiles(database: Database, projectId: string, body: ReturnType<typeof content>) {
  for (const id of imageIds(body)) assert(await one(database, sql`SELECT id FROM files WHERE id=${id} AND project_id=${projectId}`), 400, 'INVALID_ATTACHMENT', '图片不属于此项目');
}
export async function listTasks(actor: Actor, projectId: string, options: TaskQuery = {}) {
  const scope = taskQueryScope(projectId, options);
  return read(actor, projectId, async tx => {
    const { offset, limit } = paging(options.cursor);
    const items = await rows<Task>(tx, sql`SELECT t.*,(SELECT p.number FROM tasks p WHERE p.id=t.parent_id AND p.project_id=t.project_id) parent_number,(SELECT p.title FROM tasks p WHERE p.id=t.parent_id AND p.project_id=t.project_id) parent_title,(SELECT count(*)::int FROM tasks c WHERE c.project_id=t.project_id AND c.parent_id=t.id AND c.deleted_at IS NULL) child_count,(SELECT count(*)::int FROM tasks c WHERE c.project_id=t.project_id AND c.parent_id=t.id AND c.deleted_at IS NULL AND c.status='done') child_done FROM tasks t WHERE ${scope}
      ORDER BY t.position,t.created_at,t.id LIMIT ${limit + 1} OFFSET ${offset}`);
    return page(items, offset, limit);
  });
}
function escapeLike(s: string) { return s.slice(0, 200).replace(/[\\%_]/g, '\\$&'); }
const myTaskPageInput = z.object({
  query: z.string().trim().max(200).default(''),
  status: z.enum(statuses).optional(),
  priority: z.enum(priorities).optional(),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().refine(n => [10, 20, 50].includes(n)).default(10),
});

export async function myTasks(actor: Actor, input: unknown = {}) {
  const options = myTaskPageInput.parse(input);
  await liveUser(db, actor);
  const scope = sql`m.user_id=${actor.userId} AND t.assignee_id=${actor.userId}
    AND t.deleted_at IS NULL AND t.archived_at IS NULL AND p.deleted_at IS NULL AND p.archived_at IS NULL
    ${options.query ? sql`AND t.title ILIKE ${'%' + escapeLike(options.query) + '%'}` : sql``}
    ${options.status ? sql`AND t.status=${options.status}` : sql``}
    ${options.priority ? sql`AND t.priority=${options.priority}` : sql``}
    ${credentialProjectFilter(actor, sql`p.id`)}`;
  const from = sql`FROM tasks t JOIN projects p ON p.id=t.project_id JOIN project_members m ON m.project_id=p.id WHERE ${scope}`;
  const total = (await one<{ count: number }>(db, sql`SELECT count(*)::int AS count ${from}`))!.count;
  const currentPage = Math.min(options.page, Math.max(1, Math.ceil(total / options.pageSize)));
  const items = await rows<Task>(db, sql`SELECT t.*,p.name project_name ${from}
    ORDER BY t.due_date NULLS LAST,t.created_at DESC,t.id DESC
    LIMIT ${options.pageSize} OFFSET ${(currentPage - 1) * options.pageSize}`);
  return { items, total, page: currentPage, pageSize: options.pageSize };
}
export async function getResource(actor: Actor, projectId: string, kind: Kind, id: string) {
  return read(actor, projectId, async tx => { const item = await one<Task | Document>(tx, sql`SELECT * FROM ${table(kind)} WHERE id=${id} AND project_id=${projectId} AND deleted_at IS NULL`); assert(item, 404, 'NOT_FOUND', '内容不存在'); return item; });
}
async function taskRules(ctx: Context, data: ReturnType<typeof taskInput.parse>, id?: string) {
  if (data.assigneeId) assert(await one(ctx.tx, sql`SELECT m.user_id FROM project_members m JOIN users u ON u.id=m.user_id WHERE m.project_id=${ctx.projectId} AND m.user_id=${data.assigneeId} AND NOT u.disabled`), 400, 'INVALID_ASSIGNEE', '执行人必须为有效项目成员');
  if (data.parentId) {
    const parent = await one<{ parentId: string | null; archivedAt: Date | null }>(ctx.tx, sql`SELECT parent_id,archived_at FROM tasks WHERE id=${data.parentId} AND project_id=${ctx.projectId} AND deleted_at IS NULL`);
    assert(parent && !parent.parentId && data.parentId !== id && !parent.archivedAt, 400, 'INVALID_PARENT', '子任务只能属于同项目中未归档的一级任务');
    if (id) assert(!(await one(ctx.tx, sql`SELECT id FROM tasks WHERE parent_id=${id} LIMIT 1`)), 400, 'INVALID_PARENT', '有子任务的任务不能变成子任务');
  }
}
export async function createTask(actor: Actor, projectId: string, input: unknown, op: string) {
  const data = taskInput.parse(input); const description = content(data.description);
  return mutate(actor, projectId, 'write', op, { action: 'create_task', data }, async ctx => {
    await ensureLabels(ctx,data.labels); await taskRules(ctx, data); await validateFiles(ctx.tx, projectId, description);
    const counter = (await one<{ lastTaskNumber: number }>(ctx.tx, sql`UPDATE projects SET last_task_number=last_task_number+1 WHERE id=${projectId} RETURNING last_task_number`))!;
    const id = randomUUID();
    const task = (await one<Task>(ctx.tx, sql`INSERT INTO tasks(id,project_id,number,title,description,status,priority,assignee_id,parent_id,creator_id,start_date,due_date,labels,position,completed_at) VALUES(${id},${projectId},${counter.lastTaskNumber},${data.title},${JSON.stringify(description)}::jsonb,${data.status},${data.priority},${data.assigneeId},${data.parentId},${actor.userId},${data.startDate},${data.dueDate},${JSON.stringify([...new Set(data.labels)])}::jsonb,${data.position ?? counter.lastTaskNumber * 1024},${data.status === 'done' ? new Date() : null}) RETURNING *`))!;
    await audit(ctx, 'task', id, 'create', null, task, true);
    await publishTaskNotification(ctx, { type: 'task.assigned', taskId: id, taskTitle: task.title, recipientId: task.assigneeId });
    return task;
  });
}
const taskFields = (t: Task) => ({ title: t.title, description: t.description, status: t.status, priority: t.priority, assigneeId: t.assigneeId, parentId: t.parentId, startDate: t.startDate, dueDate: t.dueDate, labels: t.labels, position: t.position });
export async function updateTask(actor: Actor, projectId: string, id: string, input: Record<string, unknown>, version: number, op: string) {
  versionSchema.parse(version);
  return mutate(actor, projectId, 'write', op, { action: 'update_task', id, input, version }, async ctx => {
    const before = await one<Task>(ctx.tx, sql`SELECT * FROM tasks WHERE id=${id} AND project_id=${projectId} AND deleted_at IS NULL`); checkVersion(before, version);
    assert(!before!.archivedAt, 409, 'RESOURCE_ARCHIVED', '任务已归档，请先恢复');
    const data = taskInput.parse({ ...taskFields(before!), ...input }); const description = content(data.description);
    if (data.parentId !== before!.parentId) {
      assert(!before!.parentId || !data.parentId, 400, 'ALREADY_PARENTED', '请先解除原父子关系，再关联新父任务');
      if (before!.parentId) {
        const parent = await one<Task>(ctx.tx, sql`SELECT * FROM tasks WHERE id=${before!.parentId} AND project_id=${projectId}`);
        assert(parent && !parent.archivedAt && !parent.deletedAt, 409, 'RESOURCE_ARCHIVED', '请先恢复父任务，再解除关联');
      }
    }
    await ensureLabels(ctx,data.labels); await taskRules(ctx, data, id); await validateFiles(ctx.tx, projectId, description);
    const doneAt = data.status === 'done' ? before!.completedAt ?? new Date() : null;
    const after = (await one<Task>(ctx.tx, sql`UPDATE tasks SET parent_id=${data.parentId},title=${data.title},description=${JSON.stringify(description)}::jsonb,status=${data.status},priority=${data.priority},assignee_id=${data.assigneeId},start_date=${data.startDate},due_date=${data.dueDate},labels=${JSON.stringify([...new Set(data.labels)])}::jsonb,position=${data.position},completed_at=${doneAt},version=version+1,updated_at=now() WHERE id=${id} RETURNING *`))!;
    await audit(ctx, 'task', id, 'update', before!, after, true);
    if (before!.assigneeId !== after.assigneeId) await publishTaskNotification(ctx, { type: 'task.assigned', taskId: id, taskTitle: after.title, recipientId: after.assigneeId });
    return after;
  });
}
// Project mutation lock serializes ordering; only the moved task gains a content version.
export async function moveTask(actor: Actor, projectId: string, id: string, input: { status: TaskStatus; beforeId: string | null; beforeVersion?: number; expectedVersion: number }, op: string) {
  versionSchema.parse(input.expectedVersion);
  return mutate(actor, projectId, 'write', op, { action: 'move_task', id, ...input }, async ctx => {
    const before = await one<Task>(ctx.tx, sql`SELECT * FROM tasks WHERE id=${id} AND project_id=${projectId} AND deleted_at IS NULL`);
    checkVersion(before, input.expectedVersion);
    assert(!before!.archivedAt, 409, 'INVALID_MOVE', '只能移动未归档的任务');
    const scope = sql`project_id=${projectId} AND status=${input.status} AND deleted_at IS NULL AND archived_at IS NULL AND id<>${id}`;
    const anchor = input.beforeId ? await one<Task>(ctx.tx, sql`SELECT * FROM tasks WHERE ${scope} AND id=${input.beforeId}`) : undefined;
    if (input.beforeId) checkVersion(anchor, versionSchema.parse(input.beforeVersion));
    let previous = await one<Task>(ctx.tx, sql`SELECT * FROM tasks WHERE ${scope} ${anchor ? sql`AND (position,created_at,id)<(${anchor.position},${anchor.createdAt}::timestamptz,${anchor.id}::uuid)` : sql``} ORDER BY position DESC,created_at DESC,id DESC LIMIT 1`);
    let position = anchor ? previous ? (previous.position + anchor.position) / 2 : anchor.position - 1024 : (previous?.position ?? 0) + 1024;
    if (!Number.isFinite(position) || Math.abs(position) > 1e12 || (anchor && (position === anchor.position || position === previous?.position))) {
      await ctx.tx.execute(sql`WITH ranks AS (SELECT id,row_number() OVER (ORDER BY position,created_at,id)*1024 AS p FROM tasks WHERE ${scope}) UPDATE tasks t SET position=r.p FROM ranks r WHERE t.id=r.id`);
      const a = anchor ? await one<Task>(ctx.tx, sql`SELECT * FROM tasks WHERE id=${anchor.id}`) : undefined;
      previous = await one<Task>(ctx.tx, sql`SELECT * FROM tasks WHERE ${scope} ${a ? sql`AND position<${a.position}` : sql``} ORDER BY position DESC LIMIT 1`);
      position = a ? previous ? (previous.position + a.position) / 2 : a.position - 1024 : (previous?.position ?? 0) + 1024;
    }
    const after = (await one<Task>(ctx.tx, sql`UPDATE tasks SET status=${input.status},position=${position},completed_at=${input.status === 'done' ? before!.completedAt ?? new Date() : null},version=version+1,updated_at=now() WHERE id=${id} RETURNING *`))!;
    await audit(ctx, 'task', id, 'move', before!, after, true); return after;
  });
}
export async function moveDocument(actor:Actor,projectId:string,id:string,input:{direction:'up'|'down';expectedVersion:number;neighborId:string;neighborVersion:number},op:string){
 return mutate(actor,projectId,'write',op,{action:'move_document',id,...input},async ctx=>{
  const before=await one<Document&{createdAt:string}>(ctx.tx,sql`SELECT * FROM documents WHERE id=${id} AND project_id=${projectId} AND deleted_at IS NULL`);checkVersion(before,input.expectedVersion);
  const scope=sql`project_id=${projectId} AND parent_id IS NOT DISTINCT FROM ${before!.parentId}::uuid AND deleted_at IS NULL AND id<>${id}`;
  const up=input.direction==='up';
  const neighbor=await one<Document&{createdAt:string}>(ctx.tx,sql`SELECT * FROM documents WHERE ${scope} AND (position,created_at,id) ${up?sql`<`:sql`>`} (${before!.position},${before!.createdAt}::timestamptz,${id}::uuid) ORDER BY position ${up?sql`DESC`:sql`ASC`},created_at ${up?sql`DESC`:sql`ASC`},id ${up?sql`DESC`:sql`ASC`} LIMIT 1`);
  assert(neighbor?.id===input.neighborId,409,'VERSION_CONFLICT','目录顺序已变化，请刷新后重试');checkVersion(neighbor,input.neighborVersion);
  async function position(){const anchor=(await one<Document&{createdAt:string}>(ctx.tx,sql`SELECT * FROM documents WHERE id=${neighbor!.id}`))!;const edge=await one<Document>(ctx.tx,sql`SELECT * FROM documents WHERE ${scope} AND (position,created_at,id) ${up?sql`<`:sql`>`} (${anchor.position},${anchor.createdAt}::timestamptz,${anchor.id}::uuid) ORDER BY position ${up?sql`DESC`:sql`ASC`},created_at ${up?sql`DESC`:sql`ASC`},id ${up?sql`DESC`:sql`ASC`} LIMIT 1`);return {value:edge?(anchor.position+edge.position)/2:anchor.position+(up?-1024:1024),anchor:anchor.position,edge:edge?.position};}
  let p=await position();if(!Number.isFinite(p.value)||p.value===p.anchor||p.value===p.edge){await ctx.tx.execute(sql`WITH ranks AS (SELECT id,row_number() OVER(ORDER BY position,created_at,id)*1024 p FROM documents WHERE ${scope}) UPDATE documents d SET position=r.p FROM ranks r WHERE d.id=r.id`);p=await position();}
  const after=(await one<Document>(ctx.tx,sql`UPDATE documents SET position=${p.value},version=version+1,updated_at=now() WHERE id=${id} RETURNING *`))!;await audit(ctx,'document',id,'move',before!,after,true);return after;
 });
}
export async function listDocuments(actor: Actor, projectId: string, options: { query?: string; cursor?: string; deleted?: boolean } = {}) {
  return read(actor, projectId, async tx => {
    const { offset, limit } = paging(options.cursor, 100);
    const data = await rows<Document>(tx, sql`SELECT id,project_id,parent_id,title,position,version,updated_at,deleted_at FROM documents WHERE project_id=${projectId} AND ${options.deleted ? sql`deleted_at IS NOT NULL` : sql`deleted_at IS NULL`} ${options.query ? sql`AND (title ILIKE ${'%' + escapeLike(options.query) + '%'} OR plain_text ILIKE ${'%' + escapeLike(options.query) + '%'})` : sql``} ORDER BY position,created_at,id LIMIT ${limit + 1} OFFSET ${offset}`);
    return page(data, offset, limit);
  });
}
async function documentParent(ctx: Context, parentId: string | null, id?: string) {
  let current = parentId; let depth = 1; const seen = new Set(id ? [id] : []);
  while (current) {
    assert(!seen.has(current) && ++depth <= 5, 400, 'INVALID_PARENT', '目录最多五层且不能形成循环'); seen.add(current);
    const p: { parentId: string | null } | undefined = await one(ctx.tx, sql`SELECT parent_id FROM documents WHERE id=${current} AND project_id=${ctx.projectId} AND deleted_at IS NULL`);
    assert(p, 400, 'INVALID_PARENT', '上级文档不存在'); current = p.parentId;
  }
  if (id) {
    const descendants = await one<{ depth: number }>(ctx.tx, sql`WITH RECURSIVE d AS (SELECT id,1 depth FROM documents WHERE parent_id=${id} AND deleted_at IS NULL UNION ALL SELECT c.id,d.depth+1 FROM documents c JOIN d ON c.parent_id=d.id WHERE c.deleted_at IS NULL AND d.depth<6) SELECT COALESCE(max(depth),0)::int depth FROM d`);
    assert(depth + (descendants?.depth ?? 0) <= 5, 400, 'INVALID_PARENT', '移动后目录将超过五层');
  }
}
export async function createDocument(actor: Actor, projectId: string, input: unknown, op: string) {
  const data = documentInput.parse(input); const body = content(data.content);
  return mutate(actor, projectId, 'write', op, { action: 'create_document', data }, async ctx => {
    await documentParent(ctx, data.parentId); await validateFiles(ctx.tx, projectId, body);
    const id = randomUUID();
    const doc = (await one<Document>(ctx.tx, sql`INSERT INTO documents(id,project_id,parent_id,title,content,plain_text,position,creator_id) VALUES(${id},${projectId},${data.parentId},${data.title},${JSON.stringify(body)}::jsonb,${docText(body)},${data.position ?? Date.now()},${actor.userId}) RETURNING *`))!;
    await audit(ctx, 'document', id, 'create', null, doc, true); return doc;
  });
}
export async function updateDocument(actor: Actor, projectId: string, id: string, input: Record<string, unknown>, version: number, op: string, restoreVersion?: number) {
  versionSchema.parse(version);
  return mutate(actor, projectId, 'write', op, { action: restoreVersion ? 'restore_document_version' : 'update_document', id, input, version, restoreVersion }, async ctx => {
    const before = await one<Document>(ctx.tx, sql`SELECT * FROM documents WHERE id=${id} AND project_id=${projectId} AND deleted_at IS NULL`); checkVersion(before, version);
    let values = input;
    if (restoreVersion) {
      const historical = await one<{ snapshot: Document }>(ctx.tx, sql`SELECT snapshot FROM resource_versions WHERE project_id=${projectId} AND resource_type='document' AND resource_id=${id} AND version=${restoreVersion}`);
      assert(historical, 404, 'NOT_FOUND', '历史版本不存在'); values = { title: historical.snapshot.title, content: historical.snapshot.content };
    }
    if (actor.source === 'mcp') assert(toMarkdown(before!.content).lossless, 409, 'UNSUPPORTED_DOCUMENT_FORMAT', '该文档包含不能无损转换为 Markdown 的内容，请在网页中编辑');
    const data = documentInput.parse({ title: before!.title, content: before!.content, parentId: before!.parentId, position: before!.position, ...values }); const body = content(data.content);
    await documentParent(ctx, data.parentId, id); await validateFiles(ctx.tx, projectId, body);
    const after = (await one<Document>(ctx.tx, sql`UPDATE documents SET title=${data.title},content=${JSON.stringify(body)}::jsonb,plain_text=${docText(body)},parent_id=${data.parentId},position=${data.position},version=version+1,updated_at=now() WHERE id=${id} RETURNING *`))!;
    await audit(ctx, 'document', id, restoreVersion ? `restore_version:${restoreVersion}` : 'update', before!, after, true); return after;
  });
}
export async function history(actor: Actor, projectId: string, kind: Kind, id: string, cursor?: string, filters: {source?:string;actor?:string;from?:string;to?:string}={}) {
  for(const date of [filters.from,filters.to])if(date)taskInput.parse({title:'filter',dueDate:date});
  return read(actor, projectId, async tx => {
    assert(await one(tx, sql`SELECT id FROM ${table(kind)} WHERE id=${id} AND project_id=${projectId}`), 404, 'NOT_FOUND', '内容不存在');
    const { offset, limit } = paging(cursor);
    const events = await rows(tx, sql`SELECT a.* FROM audit_events a WHERE a.project_id=${projectId} AND a.resource_type=${kind} AND a.resource_id=${id} ${filters.source?sql`AND a.source=${filters.source}`:sql``} ${filters.actor?sql`AND a.actor_name ILIKE ${'%'+escapeLike(filters.actor)+'%'}`:sql``} ${filters.from?sql`AND a.created_at>=${filters.from}::date`:sql``} ${filters.to?sql`AND a.created_at<${filters.to}::date+interval '1 day'`:sql``} ORDER BY a.created_at DESC,a.id LIMIT ${limit + 1} OFFSET ${offset}`);
    return page(events, offset, limit);
  });
}
export async function getVersion(actor: Actor, projectId: string, kind: Kind, id: string, version: number) {
  return read(actor, projectId, async tx => { const v = await one(tx, sql`SELECT v.*,a.actor_name,a.source FROM resource_versions v JOIN audit_events a ON a.id=v.audit_id WHERE v.project_id=${projectId} AND v.resource_type=${kind} AND v.resource_id=${id} AND v.version=${version}`); assert(v, 404, 'NOT_FOUND', '版本不存在'); return v; });
}
export async function lifecycle(actor: Actor, projectId: string, kind: Kind | 'project', id: string, action: 'delete' | 'restore' | 'archive' | 'unarchive', version: number, op: string) {
  versionSchema.parse(version);
  assert(kind !== 'project' || id === projectId, 400, 'INVALID_INPUT', '项目不匹配');
  assert(kind !== 'document' || ['delete','restore'].includes(action), 400, 'INVALID_INPUT', '文档不支持归档');
  return mutate(actor, projectId, 'admin', op, { kind, id, action, version }, async ctx => {
    const tbl = kind === 'project' ? sql`projects` : table(kind);
    const before = await one<{ id: string; version: number; deletedAt: Date | null; archivedAt?: Date | null; parentId?: string | null; deletionBatch?: string }>(ctx.tx, sql`SELECT * FROM ${tbl} WHERE id=${id} ${kind === 'project' ? sql`` : sql`AND project_id=${projectId}`}`); checkVersion(before, version);
    if (kind !== 'project') assert(!before!.deletedAt || action === 'restore', 409, 'RESOURCE_DELETED', '内容已删除');
    if (action === 'restore') assert(before!.deletedAt, 409, 'NOT_DELETED', '内容未删除');
    if (kind === 'document' && action === 'delete') assert(!(await one(ctx.tx, sql`SELECT id FROM documents WHERE parent_id=${id} AND deleted_at IS NULL LIMIT 1`)), 409, 'HAS_CHILDREN', '请先移动或删除子页面');
    if (action === 'restore' && before!.parentId) assert(await one(ctx.tx, sql`SELECT id FROM ${tbl} WHERE id=${before!.parentId} AND deleted_at IS NULL`), 409, 'PARENT_DELETED', '请先恢复上级内容');
    const column = ['delete','restore'].includes(action) ? sql`deleted_at` : sql`archived_at`;
    const value = ['delete','archive'].includes(action) ? new Date() : null;
    const after = (await one(ctx.tx, sql`UPDATE ${tbl} SET ${column}=${value},version=version+1,updated_at=now() ${kind === 'task' && action === 'delete' ? sql`,deletion_batch=${ctx.operationId}` : sql``} WHERE id=${id} RETURNING *`))!;
    await audit(ctx, kind, id, action, before!, after, kind !== 'project');
    if (kind === 'task' && ['delete','restore'].includes(action)) {
      const children = await rows<{ id: string }>(ctx.tx, sql`SELECT * FROM tasks WHERE parent_id=${id} AND ${action === 'delete' ? sql`deleted_at IS NULL` : sql`deleted_at IS NOT NULL AND deletion_batch=${before!.deletionBatch ?? null}`}`);
      for (const child of children) {
        const changed = (await one(ctx.tx, sql`UPDATE tasks SET deleted_at=${value},deletion_batch=${action === 'delete' ? ctx.operationId : null},version=version+1,updated_at=now() WHERE id=${child.id} RETURNING *`))!;
        await audit(ctx, 'task', child.id, `${action}_with_parent`, child, changed, true);
      }
    }
    return after;
  }, { includeDeleted: kind === 'project' && action === 'restore', allowArchived: kind === 'project' });
}
export async function comments(actor: Actor, projectId: string, taskId: string, cursor?: string) {
  return read(actor, projectId, async tx => {
    assert(await one(tx, sql`SELECT id FROM tasks WHERE id=${taskId} AND project_id=${projectId}`), 404, 'NOT_FOUND', '任务不存在');
    const { offset, limit } = paging(cursor);
    const role=await access(tx,actor,projectId);
    const data = await rows<{ id: string; content: string; deletedAt: Date | null; authorName: string; createdAt: Date }>(tx, sql`SELECT c.*,u.name author_name FROM comments c JOIN users u ON u.id=c.author_id WHERE c.project_id=${projectId} AND c.task_id=${taskId} ORDER BY c.created_at DESC,c.id LIMIT ${limit + 1} OFFSET ${offset}`);
    const result = page(data, offset, limit);
    const ids = result.items.map(c => c.id);
    const attachments = ids.length ? await rows<{ commentId: string; id: string; name: string; mimeType: string; size: number }>(tx, sql`SELECT a.comment_id,f.id,f.name,f.mime_type,f.size FROM comment_attachments a JOIN files f ON f.id=a.file_id WHERE a.project_id=${projectId} AND a.comment_id IN (${sql.join(ids.map(id => sql`${id}::uuid`), sql`,`)}) ORDER BY a.created_at,a.id`) : [];
    return { ...result, items: result.items.map(c => ({ ...c, content: c.deletedAt && role !== 'admin' ? null : c.content, attachments: c.deletedAt && role !== 'admin' ? [] : attachments.filter(f => f.commentId === c.id).map(({ commentId: _commentId, ...file }) => file) })) };
  });
}
export async function addComment(actor: Actor, projectId: string, taskId: string, value: string, op: string, files: File[] = []) {
  assert(typeof value === 'string' && value.length <= 10000 && (value.trim().length > 0 || files.length > 0), 400, 'INVALID_INPUT', '请输入评论或添加文件');
  const prepared = await prepareCommentFiles(files);
  return mutate(actor, projectId, 'write', op, { action: 'comment', taskId, value: value.trim(), files: prepared.map(f => ({ name: f.name, checksum: f.checksum, size: f.bytes.length })) }, async ctx => {
    const task = await one<Task>(ctx.tx, sql`SELECT * FROM tasks WHERE id=${taskId} AND project_id=${projectId} AND deleted_at IS NULL AND archived_at IS NULL`);
    assert(task, 404, 'NOT_FOUND', '任务不存在或已归档');
    const id = randomUUID(); const c = (await one<{ id: string; content: string }>(ctx.tx, sql`INSERT INTO comments(id,project_id,task_id,author_id,content) VALUES(${id},${projectId},${taskId},${actor.userId},${value.trim()}) RETURNING *`))!;
    const attachments = await storeCommentFiles(ctx, projectId, id, prepared);
    await audit(ctx, 'comment', id, 'create', null, { ...c, attachmentIds: attachments.map(f => f.id) });
    await publishTaskNotification(ctx, { type: 'task.commented', taskId, taskTitle: task.title, recipientId: task.assigneeId, commentId: id });
    return { ...c, attachments };
  });
}
export async function deleteComment(actor: Actor, projectId: string, id: string, op: string) {
  return mutate(actor, projectId, 'admin', op, { action: 'delete_comment', id }, async ctx => {
    const before = await one(ctx.tx, sql`SELECT * FROM comments WHERE id=${id} AND project_id=${projectId} AND deleted_at IS NULL`); assert(before, 404, 'NOT_FOUND', '评论不存在');
    const after = (await one(ctx.tx, sql`UPDATE comments SET deleted_at=now() WHERE id=${id} RETURNING *`))!; await audit(ctx, 'comment', id, 'delete', before, after); return { ok: true };
  });
}
export async function linkTask(actor: Actor, projectId: string, taskId: string, documentId: string, op: string) {
  return mutate(actor, projectId, 'write', op, { action: 'link', taskId, documentId }, async ctx => {
    const before = await one<Task>(ctx.tx, sql`SELECT * FROM tasks WHERE id=${taskId} AND project_id=${projectId} AND deleted_at IS NULL AND archived_at IS NULL`);
    assert(before && await one(ctx.tx, sql`SELECT id FROM documents WHERE id=${documentId} AND project_id=${projectId} AND deleted_at IS NULL`), 404, 'NOT_FOUND', '任务或文档不存在');
    await ctx.tx.execute(sql`INSERT INTO task_document_links(project_id,task_id,document_id) VALUES(${projectId},${taskId},${documentId}) ON CONFLICT DO NOTHING`);
    await audit(ctx, 'task_link', taskId, 'link_document', null, { taskId, documentId }); return { ok: true };
  });
}
export async function taskLinks(actor: Actor, projectId: string, taskId: string) { return read(actor, projectId, tx => rows(tx, sql`SELECT d.id,d.title FROM task_document_links l JOIN documents d ON d.id=l.document_id WHERE l.project_id=${projectId} AND l.task_id=${taskId} AND d.deleted_at IS NULL`)); }
export async function documentLinks(actor: Actor, projectId: string, documentId: string) { return read(actor, projectId, tx => rows(tx, sql`SELECT t.id,t.title FROM task_document_links l JOIN tasks t ON t.id=l.task_id WHERE l.project_id=${projectId} AND l.document_id=${documentId} AND t.deleted_at IS NULL ORDER BY t.number`)); }
export async function taskActivity(actor: Actor, projectId: string, taskId: string, cursor?: string) {
  return read(actor, projectId, async tx => {
    assert(await one(tx, sql`SELECT id FROM tasks WHERE id=${taskId} AND project_id=${projectId} AND deleted_at IS NULL`),404,'NOT_FOUND','任务不存在');
    const role=await access(tx,actor,projectId);const {offset,limit}=paging(cursor);
    const events=await rows(tx,sql`SELECT a.*,CASE WHEN c.deleted_at IS NULL OR ${role==='admin'} THEN c.content ELSE NULL END comment_content,c.deleted_at comment_deleted_at,c.id comment_id FROM audit_events a LEFT JOIN comments c ON a.resource_type='comment' AND a.resource_id=c.id::text AND c.project_id=${projectId} WHERE a.project_id=${projectId} AND ((a.resource_type IN ('task','task_link') AND a.resource_id=${taskId}) OR c.task_id=${taskId}) ORDER BY a.created_at DESC,a.id LIMIT ${limit+1} OFFSET ${offset}`);
    // Deleted comment bodies can also occur in the immutable audit diff.
    return page(events.map(e=>e.resourceType==='comment'&&e.commentDeletedAt&&role!=='admin'?{...e,changes:{}}:e),offset,limit);
  });
}
