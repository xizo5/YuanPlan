import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { projectInput, type Project, type Member, type User, type Role } from '@yuanplan/contracts';
import { db, rows, one, type Database } from '../db/index.js';
import { access, credentialProjectFilter, liveUser, mutate, audit, read, checkVersion, type Actor, type Context } from './core.js';
import { assert } from '../lib/errors.js';

const projectPageInput = z.object({
  query: z.string().trim().max(200).default(''),
  status: z.enum(['active', 'archived', 'all', 'deleted']).default('active'),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().refine(n => [10, 20, 50].includes(n)).default(10),
});

export async function listProjectPage(actor: Actor, input: unknown) {
  const options = projectPageInput.parse(input);
  await liveUser(db, actor);
  const keyword = options.query.replace(/[\\%_]/g, '\\$&');
  const scope = sql`m.user_id=${actor.userId}
    AND ${options.status === 'deleted' ? sql`p.deleted_at IS NOT NULL AND m.role='admin'` : sql`p.deleted_at IS NULL`}
    ${options.status === 'active' ? sql`AND p.archived_at IS NULL` : options.status === 'archived' ? sql`AND p.archived_at IS NOT NULL` : sql``}
    ${options.query ? sql`AND p.name ILIKE ${`%${keyword}%`}` : sql``}
    ${credentialProjectFilter(actor, sql`p.id`)}`;
  const total = (await one<{count:number}>(db, sql`SELECT count(*)::int AS count FROM projects p JOIN project_members m ON m.project_id=p.id WHERE ${scope}`))!.count;
  const page = Math.min(options.page, Math.max(1, Math.ceil(total / options.pageSize)));
  const items = await rows<Project>(db, sql`SELECT p.*,m.role,
    (SELECT count(*)::int FROM tasks t WHERE t.project_id=p.id AND t.deleted_at IS NULL AND t.parent_id IS NULL) task_count,
    (SELECT count(*)::int FROM tasks t WHERE t.project_id=p.id AND t.deleted_at IS NULL AND t.parent_id IS NULL AND t.status='done') completed_count
    FROM projects p JOIN project_members m ON m.project_id=p.id WHERE ${scope}
    ORDER BY p.created_at DESC,p.id DESC LIMIT ${options.pageSize} OFFSET ${(page - 1) * options.pageSize}`);
  return { items, total, page, pageSize: options.pageSize };
}

export async function listProjects(actor: Actor, includeDeleted = false) {
  await liveUser(db, actor);
  return rows<Project>(db, sql`SELECT p.*,m.role,(SELECT count(*)::int FROM tasks t WHERE t.project_id=p.id AND t.deleted_at IS NULL AND t.parent_id IS NULL) task_count,(SELECT count(*)::int FROM tasks t WHERE t.project_id=p.id AND t.deleted_at IS NULL AND t.parent_id IS NULL AND t.status='done') completed_count FROM projects p JOIN project_members m ON m.project_id=p.id AND m.user_id=${actor.userId} WHERE ${includeDeleted ? sql`m.role='admin'` : sql`p.deleted_at IS NULL`} ${credentialProjectFilter(actor, sql`p.id`)} ORDER BY p.created_at DESC LIMIT 200`);
}
export async function getProject(actor: Actor, projectId: string) {
  return read(actor, projectId, async tx => (await one<Project>(tx, sql`SELECT p.*,m.role FROM projects p JOIN project_members m ON m.project_id=p.id WHERE p.id=${projectId} AND m.user_id=${actor.userId}`))!);
}
export async function teamAccess(database: Database, userId: string, teamId: string, admin = false) {
  const member = await one<{ role: string }>(database, sql`SELECT m.role FROM team_members m JOIN teams t ON t.id=m.team_id WHERE m.team_id=${teamId} AND m.user_id=${userId} AND t.deleted_at IS NULL FOR SHARE OF t`);
  assert(member && (!admin || member.role === 'admin'), 404, 'NOT_FOUND', '团队不存在或无权访问'); return member.role;
}
export async function createProject(actor: Actor, input: unknown, op: string) {
  const data = projectInput.parse(input);
  return mutate(actor, null, 'write', op, { action: 'create_project', data }, async ctx => {
    if (data.teamId) await teamAccess(ctx.tx, actor.userId, data.teamId);
    const id = randomUUID();
    const project = (await one<Project>(ctx.tx, sql`INSERT INTO projects(id,name,description,team_id,creator_id) VALUES(${id},${data.name},${data.description},${data.teamId},${actor.userId}) RETURNING *`))!;
    await ctx.tx.execute(sql`INSERT INTO project_members(project_id,user_id,role) VALUES(${id},${actor.userId},'admin')`);
    await audit({ ...ctx, projectId: id }, 'project', id, 'create', null, project);
    return { ...project, role: 'admin' as Role };
  });
}
export async function updateProject(actor: Actor, id: string, input: unknown, version: number, op: string) {
  const data = projectInput.parse(input);
  return mutate(actor, id, 'admin', op, { action: 'update_project', data, version }, async ctx => {
    const before = await one<Project>(ctx.tx, sql`SELECT * FROM projects WHERE id=${id}`); checkVersion(before, version);
    if (data.teamId && data.teamId !== before!.teamId) await teamAccess(ctx.tx, actor.userId, data.teamId);
    const after = (await one<Project>(ctx.tx, sql`UPDATE projects SET name=${data.name},description=${data.description},team_id=${data.teamId},version=version+1,updated_at=now() WHERE id=${id} RETURNING *`))!;
    await audit(ctx, 'project', id, 'update', before!, after); return after;
  });
}
export async function listMembers(actor: Actor, id: string) { return read(actor, id, tx => rows<Member>(tx, sql`SELECT m.user_id,u.name,u.email,m.role,u.disabled FROM project_members m JOIN users u ON u.id=m.user_id WHERE m.project_id=${id} ORDER BY m.created_at`)); }
export async function changeMember(actor: Actor, id: string, userId: string, role: Role | null, op: string) {
  return mutate(actor, id, 'admin', op, { action: 'change_member', userId, role }, async ctx => {
    const member = await one<{ role: Role }>(ctx.tx, sql`SELECT role FROM project_members WHERE project_id=${id} AND user_id=${userId}`);
    assert(member, 404, 'NOT_FOUND', '成员不存在');
    if (member.role === 'admin' && role !== 'admin') {
      const count = await one<{ count: number }>(ctx.tx, sql`SELECT count(*)::int count FROM project_members WHERE project_id=${id} AND role='admin'`);
      assert(count && count.count > 1, 409, 'LAST_ADMIN', '至少保留一名项目管理员');
    }
    if (role) await ctx.tx.execute(sql`UPDATE project_members SET role=${role} WHERE project_id=${id} AND user_id=${userId}`);
    else {
      const tasks = await rows<{ id: string; version: number }>(ctx.tx, sql`SELECT * FROM tasks WHERE project_id=${id} AND assignee_id=${userId} AND deleted_at IS NULL AND archived_at IS NULL`);
      for (const task of tasks) {
        const after = (await one(ctx.tx, sql`UPDATE tasks SET assignee_id=NULL,version=version+1,updated_at=now() WHERE id=${task.id} RETURNING *`))!;
        await audit(ctx, 'task', task.id, 'member_removed', task, after, true);
      }
      await ctx.tx.execute(sql`DELETE FROM project_members WHERE project_id=${id} AND user_id=${userId}`);
    }
    await audit(ctx, 'project_member', userId, role ? 'role_change' : 'remove', member, role ? { role } : null);
    return { ok: true };
  });
}
export async function listTeams(actor: Actor) {
  await liveUser(db, actor);
  return rows<{ id: string; name: string; role: string; memberCount: number }>(db, sql`SELECT t.*,m.role,(SELECT count(*)::int FROM team_members tm WHERE tm.team_id=t.id) member_count FROM teams t JOIN team_members m ON m.team_id=t.id AND m.user_id=${actor.userId} WHERE t.deleted_at IS NULL ORDER BY t.created_at DESC`);
}
export async function createTeam(actor: Actor, name: string, op: string) {
  name = z.string().trim().min(1).max(100).parse(name);
  return mutate(actor, null, 'write', op, { action: 'create_team', name }, async ctx => {
    const id = randomUUID();
    await ctx.tx.execute(sql`INSERT INTO teams(id,name,creator_id) VALUES(${id},${name},${actor.userId})`);
    await ctx.tx.execute(sql`INSERT INTO team_members(team_id,user_id,role) VALUES(${id},${actor.userId},'admin')`);
    await audit(ctx, 'team', id, 'create', null, { name }); return { id, name };
  });
}
export async function teamMembers(actor: Actor, id: string) {
  await liveUser(db, actor); await teamAccess(db, actor.userId, id);
  return rows<Member>(db, sql`SELECT m.user_id,u.name,u.email,m.role,u.disabled FROM team_members m JOIN users u ON u.id=m.user_id WHERE m.team_id=${id} ORDER BY u.name`);
}
export async function renameTeam(actor:Actor,teamId:string,name:string,version:number,op:string){
 name=z.string().trim().min(1).max(100).parse(name);
 return mutate(actor,null,'admin',op,{action:'rename_team',teamId,name,version},async ctx=>{
  const before=await one<{version:number}>(ctx.tx,sql`SELECT * FROM teams WHERE id=${teamId} AND deleted_at IS NULL FOR UPDATE`);
  await teamAccess(ctx.tx,actor.userId,teamId,true);checkVersion(before,version);
  const after=(await one(ctx.tx,sql`UPDATE teams SET name=${name},version=version+1 WHERE id=${teamId} RETURNING *`))!;
  await audit(ctx,'team',teamId,'rename',before!,after);return after;
 });
}
export async function changeTeamRole(actor:Actor,teamId:string,userId:string,role:'admin'|'member',expectedRole:'admin'|'member',op:string){
 return mutate(actor,null,'admin',op,{action:'team_role',teamId,userId,role,expectedRole},async ctx=>{
  await ctx.tx.execute(sql`SELECT id FROM teams WHERE id=${teamId} FOR UPDATE`);await teamAccess(ctx.tx,actor.userId,teamId,true);
  const members=await rows<{userId:string;role:string}>(ctx.tx,sql`SELECT user_id,role FROM team_members WHERE team_id=${teamId}`);const before=members.find(m=>m.userId===userId);
  assert(before,404,'NOT_FOUND','成员不存在');assert(before.role===expectedRole,409,'VERSION_CONFLICT','成员角色已变化，请刷新');
  assert(!(before.role==='admin'&&role!=='admin'&&members.filter(m=>m.role==='admin').length===1),409,'LAST_ADMIN','至少保留一名团队管理员');
  await ctx.tx.execute(sql`UPDATE team_members SET role=${role} WHERE team_id=${teamId} AND user_id=${userId}`);
  await audit(ctx,'team',teamId,'member_role',before,{userId,role});return {ok:true};
 });
}
export async function addFromTeam(actor: Actor, projectId: string, teamId: string, userIds: string[], role: Role, op: string) {
  return mutate(actor, projectId, 'admin', op, { action: 'add_from_team', teamId, userIds, role }, async ctx => {
    await teamAccess(ctx.tx, actor.userId, teamId);
    for (const userId of [...new Set(userIds)]) {
      await teamAccess(ctx.tx, userId, teamId);
      const user = await one<User>(ctx.tx, sql`SELECT * FROM users WHERE id=${userId}`); assert(user && !user.disabled, 400, 'DISABLED_USER', '不能加入停用账号');
      const result = await rows(ctx.tx, sql`INSERT INTO project_members(project_id,user_id,role) VALUES(${projectId},${userId},${role}) ON CONFLICT DO NOTHING RETURNING user_id`);
      if (result.length) await audit(ctx, 'project_member', userId, 'add_from_team', null, { role, teamId });
    }
    return { ok: true };
  });
}
export async function manageTeam(actor: Actor, teamId: string, action: 'delete' | 'remove_member', userId: string | null, op: string, expectedVersion?:number) {
  return mutate(actor, null, 'admin', op, { teamId, action, userId,expectedVersion }, async ctx => {
    await ctx.tx.execute(sql`SELECT id FROM teams WHERE id=${teamId} FOR UPDATE`); await teamAccess(ctx.tx, actor.userId, teamId, true);
    if(expectedVersion!==undefined)checkVersion(await one<{version:number}>(ctx.tx,sql`SELECT version FROM teams WHERE id=${teamId}`),expectedVersion);
    if (action === 'delete') {
      const projects = await rows<{ id: string }>(ctx.tx, sql`SELECT id FROM projects WHERE team_id=${teamId} ORDER BY id FOR UPDATE`);
      for (const p of projects) {
        const before = (await one(ctx.tx, sql`SELECT * FROM projects WHERE id=${p.id}`))!;
        const after = (await one(ctx.tx, sql`UPDATE projects SET team_id=NULL,version=version+1,updated_at=now() WHERE id=${p.id} RETURNING *`))!;
        await audit({ ...ctx, projectId: p.id }, 'project', p.id, 'team_deleted', before, after);
      }
      await ctx.tx.execute(sql`UPDATE teams SET deleted_at=now() WHERE id=${teamId}`);
    } else {
      assert(userId, 400, 'INVALID_INPUT', '请选择成员');
      const members = await rows<{ userId: string; role: string }>(ctx.tx, sql`SELECT user_id,role FROM team_members WHERE team_id=${teamId}`);
      assert(members.some(m=>m.userId===userId),404,'NOT_FOUND','成员不存在');
      assert(!(members.filter(m => m.role === 'admin').length === 1 && members.some(m => m.userId === userId && m.role === 'admin')), 409, 'LAST_ADMIN', '不能移除最后一名团队管理员');
      await ctx.tx.execute(sql`DELETE FROM team_members WHERE team_id=${teamId} AND user_id=${userId}`);
    }
    await audit(ctx, 'team', teamId, action, null, { userId }); return { ok: true };
  });
}
