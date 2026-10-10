import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { migrate } from '../apps/server/src/db/migrate';
import { db, pool, one } from '../apps/server/src/db';
import * as projects from '../apps/server/src/modules/projects';
import * as resources from '../apps/server/src/modules/resources';
import * as files from '../apps/server/src/modules/files';
import * as labels from '../apps/server/src/modules/labels';
import * as credentials from '../apps/server/src/modules/credentials';
import { createMcpServer } from '../apps/server/src/modules/mcp';
import type { Actor } from '../apps/server/src/modules/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { app } from '../apps/server/src/app';
import { adminUserPage, createInvitation, acceptInvitation, revokeInvitation, register, createUser, updateSettings, resetPassword } from '../apps/server/src/modules/accounts';
import { config } from '../apps/server/src/config';
import { fromMarkdown, toMarkdown } from '@yuanplan/editor-schema';
import { taskInput } from '@yuanplan/contracts';
const admin:Actor={userId:randomUUID(),source:'web'};const member:Actor={userId:randomUUID(),source:'web'};const viewer:Actor={userId:randomUUID(),source:'web'};const outsider:Actor={userId:randomUUID(),source:'web'};let projectId:string;
beforeAll(async()=>{await migrate(process.env.TEST_DATABASE_URL);for(const [i,a] of [admin,member,viewer,outsider].entries())await db.execute(sql`INSERT INTO users(id,name,email,identity_source) VALUES(${a.userId},${`User ${i}`},${`${a.userId}@example.test`},'invite')`);const p=await projects.createProject(admin,{name:'Integration project'},randomUUID());projectId=p.id;for(const [a,role] of [[member,'member'],[viewer,'viewer']] as const)await db.execute(sql`INSERT INTO project_members(project_id,user_id,role) VALUES(${projectId},${a.userId},${role})`);});
afterAll(async()=>{await pool.end();});
describe('project authorization and transactional history',()=>{
it('rejects outsiders and viewer writes',async()=>{await expect(projects.getProject(outsider,projectId)).rejects.toMatchObject({code:'NOT_FOUND'});await expect(resources.createTask(viewer,projectId,{title:'denied'},randomUUID())).rejects.toMatchObject({code:'FORBIDDEN'});});
it('deduplicates retries and rejects operation reuse',async()=>{const op=randomUUID();const a=await resources.createTask(member,projectId,{title:'idempotent'},op);const b=await resources.createTask(member,projectId,{title:'idempotent'},op);expect(b.id).toBe(a.id);await expect(resources.createTask(member,projectId,{title:'different'},op)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});const h=await resources.history(member,projectId,'task',a.id);expect(h.items).toHaveLength(1);});
it('accepts one concurrent update and attributes the saved version',async()=>{const t=await resources.createTask(admin,projectId,{title:'concurrent'},randomUUID());const changes=await Promise.allSettled([resources.updateTask(admin,projectId,t.id,{title:'admin edit'},1,randomUUID()),resources.updateTask(member,projectId,t.id,{title:'member edit'},1,randomUUID())]);expect(changes.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect((changes.find(r=>r.status==='rejected') as PromiseRejectedResult).reason.code).toBe('VERSION_CONFLICT');const h=await resources.history(viewer,projectId,'task',t.id);expect(h.items).toHaveLength(2);expect(h.items[0].afterVersion).toBe(2);expect([admin.userId,member.userId]).toContain(h.items[0].actorId);});
it('keeps creator distinct from assignee and allows project members to edit',async()=>{const t=await resources.createTask(admin,projectId,{title:'assigned',assigneeId:member.userId},randomUUID());const changed=await resources.updateTask(member,projectId,t.id,{status:'done'},t.version,randomUUID());expect(changed.creatorId).toBe(admin.userId);expect(changed.assigneeId).toBe(member.userId);expect(changed.completedAt).toBeTruthy();await expect(resources.updateTask(member,projectId,t.id,{assigneeId:outsider.userId},changed.version,randomUUID())).rejects.toMatchObject({code:'INVALID_ASSIGNEE'});});
it('limits subtasks to one level and restores only parent-deleted children',async()=>{const p=await resources.createTask(admin,projectId,{title:'parent'},randomUUID());const a=await resources.createTask(admin,projectId,{title:'child',parentId:p.id},randomUUID());const b=await resources.createTask(admin,projectId,{title:'independently deleted',parentId:p.id},randomUUID());await expect(resources.createTask(member,projectId,{title:'grandchild',parentId:a.id},randomUUID())).rejects.toMatchObject({code:'INVALID_PARENT'});await resources.lifecycle(admin,projectId,'task',b.id,'delete',1,randomUUID());await resources.lifecycle(admin,projectId,'task',p.id,'delete',1,randomUUID());await resources.lifecycle(admin,projectId,'task',p.id,'restore',2,randomUUID());expect((await resources.getResource(admin,projectId,'task',a.id)).version).toBe(3);await expect(resources.getResource(admin,projectId,'task',b.id)).rejects.toMatchObject({code:'NOT_FOUND'});});
it('restores Wiki by appending a version and forbids rewriting audit history',async()=>{const d=await resources.createDocument(member,projectId,{title:'Original',content:fromMarkdown('hello **world**')},randomUUID());await resources.updateDocument(member,projectId,d.id,{title:'Changed'},1,randomUUID());const restored=await resources.updateDocument(member,projectId,d.id,{},2,randomUUID(),1);expect(restored.title).toBe('Original');expect(restored.version).toBe(3);const h=await resources.history(viewer,projectId,'document',d.id);expect(h.items).toHaveLength(3);await expect(db.execute(sql`UPDATE audit_events SET actor_name='tampered' WHERE resource_id=${d.id}`)).rejects.toBeTruthy();await expect(db.execute(sql`DELETE FROM resource_versions WHERE resource_id=${d.id}`)).rejects.toBeTruthy();});
it('enforces token project scope, write scope and revocation',async()=>{const c=await credentials.createCredential(member,{name:'read',projectIds:[projectId],scope:'read'},randomUUID());const actor=await credentials.credentialActor(c.token);await expect(resources.createTask(actor,projectId,{title:'denied'},randomUUID())).rejects.toMatchObject({code:'CREDENTIAL_SCOPE'});await credentials.revokeCredential(member,c.id,randomUUID());await expect(projects.getProject(actor,projectId)).rejects.toMatchObject({code:'INVALID_CREDENTIAL'});});
it('exposes actual MCP tools and records an Agent write',async()=>{const c=await credentials.createCredential(member,{name:'Agent',projectIds:[projectId],scope:'write'},randomUUID());const actor=await credentials.credentialActor(c.token);const server=createMcpServer(actor);const client=new Client({name:'integration-test',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);try{const list=await client.listTools();expect(list.tools.map(t=>t.name)).toContain('update_document');expect(list.tools.map(t=>t.name)).not.toContain('delete_task');const result=await client.callTool({name:'create_task',arguments:{projectId,title:'Agent-created',operationId:randomUUID()}});expect(result.isError, JSON.stringify(result)).not.toBe(true);const task=JSON.parse((result.content as any[])[0].text);const h=await resources.history(member,projectId,'task',task.id);expect(h.items[0]).toMatchObject({source:'mcp',actorId:member.userId,credentialId:c.id});}finally{await client.close();await server.close();}});
it('rejects invalid calendar dates without throwing RangeError',()=>{expect(taskInput.safeParse({title:'date',dueDate:'2026-99-99'}).success).toBe(false);expect(toMarkdown(fromMarkdown('# Hello\n\nA **bold** paragraph.')).lossless).toBe(true);});
it('handles invitation registration, real session cookies and CSRF rejection',async()=>{
 const email=`${randomUUID()}@example.test`;const invite=await createInvitation(admin,'project',projectId,email,'member',randomUUID());const password='Integration-test-password-123';
 const token=new URL(invite.url).searchParams.get('token');expect(token).toBeTruthy();
 const request=(path:string,body:unknown,cookie?:string)=>app.request(`${config.APP_URL}/api${path}`,{method:'POST',headers:{Origin:config.APP_URL,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)});
 const registration=await request('/public/register',{email,name:'Invited user',password,inviteToken:token});expect(registration.status,await registration.clone().text()).toBe(200);
 const login=await request('/auth/sign-in/email',{email,password});expect(login.status,await login.clone().text()).toBe(200);const cookie=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');expect(cookie).toContain('session_token');
 const me=await app.request(`${config.APP_URL}/api/me`,{headers:{Cookie:cookie}});expect(me.status).toBe(200);const meData=await me.json();expect(meData.email).toBe(email);
 const task=await resources.createTask({userId:meData.id,source:'web'},projectId,{title:'multipart comment'},randomUUID());
 const form=new FormData();form.set('content','');form.append('files',new File([new Uint8Array([137,80,78,71,13,10,26,10,1])],'capture.png',{type:'image/png'}));
 const posted=await app.request(`${config.APP_URL}/api/projects/${projectId}/tasks/${task.id}/comments`,{method:'POST',headers:{Origin:config.APP_URL,Cookie:cookie,'Idempotency-Key':randomUUID()},body:form});
 expect(posted.status,await posted.clone().text()).toBe(201);
 const commentList=await app.request(`${config.APP_URL}/api/projects/${projectId}/tasks/${task.id}/comments`,{headers:{Cookie:cookie}});
 expect((await commentList.json()).items[0].attachments[0].name).toBe('capture.png');
 const missingOrigin=await app.request(`${config.APP_URL}/api/projects`,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({name:'csrf'})});expect(missingOrigin.status).toBe(403);
 const replay=await request('/public/register',{email:`wrong-${email}`,name:'Wrong identity',password,inviteToken:token});expect(replay.status).not.toBe(200);
});
it('supports open registration without SMTP and administrator-created users',async()=>{
 const owner:Actor={userId:randomUUID(),source:'web'};
 await db.execute(sql`INSERT INTO users(id,name,email,is_admin,identity_source) VALUES(${owner.userId},'Registration manager',${owner.userId+'@example.test'},true,'setup')`);
 const email=`${randomUUID()}@example.test`,password='Integration-test-password-123';
 await updateSettings(owner,'open_unverified',randomUUID());
 try{
  expect((await register({email,name:'Self registered',password})).needsVerification).toBe(false);
  const self=await one<{id:string;isAdmin:boolean;emailVerified:boolean;identitySource:string}>(db,sql`SELECT id,is_admin,email_verified,identity_source FROM users WHERE email=${email}`);
  expect(self).toMatchObject({isAdmin:false,emailVerified:false,identitySource:'self'});
  const login=await app.request(`${config.APP_URL}/api/auth/sign-in/email`,{method:'POST',headers:{Origin:config.APP_URL,'Content-Type':'application/json'},body:JSON.stringify({email,password})});
  expect(login.status,await login.clone().text()).toBe(200);
  await expect(projects.getProject({userId:self!.id,source:'web'},projectId)).rejects.toMatchObject({code:'NOT_FOUND'});
  await expect(createUser({userId:self!.id,source:'web'},{name:'Denied',email:`${randomUUID()}@example.test`},randomUUID())).rejects.toMatchObject({code:'FORBIDDEN'});
  const managedEmail=`${randomUUID()}@example.test`,managedPassword='Managed-password-12345';
  const created=await createUser(owner,{name:'Managed user',email:managedEmail},randomUUID());
  expect(created.url).toContain('/recover?token=');
  await expect(createUser(owner,{name:'Duplicate',email:managedEmail},randomUUID())).rejects.toMatchObject({code:'ACCOUNT_EXISTS'});
  const managed=await one<{isAdmin:boolean;emailVerified:boolean;identitySource:string}>(db,sql`SELECT is_admin,email_verified,identity_source FROM users WHERE email=${managedEmail}`);
  expect(managed).toMatchObject({isAdmin:false,emailVerified:false,identitySource:'admin'});
  const recoveryToken=new URL(created.url).searchParams.get('token')!;
  await resetPassword(recoveryToken,managedPassword);
  await expect(resetPassword(recoveryToken,managedPassword)).rejects.toMatchObject({code:'INVALID_TOKEN'});
  const managedLogin=await app.request(`${config.APP_URL}/api/auth/sign-in/email`,{method:'POST',headers:{Origin:config.APP_URL,'Content-Type':'application/json'},body:JSON.stringify({email:managedEmail,password:managedPassword})});
  expect(managedLogin.status,await managedLogin.clone().text()).toBe(200);
 }finally{await updateSettings(owner,'invite',randomUUID());}
 await expect(register({email:`${randomUUID()}@example.test`,name:'Rejected',password})).rejects.toMatchObject({code:'INVITE_REQUIRED'});
});
it('supports the Streamable HTTP MCP client end to end',async()=>{
 const c=await credentials.createCredential(member,{name:'HTTP Agent',projectIds:[projectId],scope:'write'},randomUUID());
 const transport=new StreamableHTTPClientTransport(new URL(`${config.APP_URL}/api/mcp`),{requestInit:{headers:{Authorization:`Bearer ${c.token}`}},fetch:async(input,init)=>app.request(new Request(input,init))});
 const client=new Client({name:'http-test',version:'1'});await client.connect(transport);try{const r=await client.callTool({name:'create_document',arguments:{projectId,title:'HTTP Wiki',markdown:'',operationId:randomUUID()}});expect(r.isError,JSON.stringify(r)).not.toBe(true);const d=JSON.parse((r.content as any[])[0].text);expect(d.version).toBe(1);await credentials.revokeCredential(member,c.id,randomUUID());await expect(client.listTools()).rejects.toBeTruthy();}finally{await client.close();}
});
it('moves within a column, checks both versions and records only the moved task',async()=>{
 const a=await resources.createTask(admin,projectId,{title:'sort first'},randomUUID());const b=await resources.createTask(admin,projectId,{title:'sort second'},randomUUID());
 const op=randomUUID();const input={status:'todo' as const,beforeId:a.id,beforeVersion:a.version,expectedVersion:b.version};
 const moved=await resources.moveTask(member,projectId,b.id,input,op);expect(moved.position).toBeLessThan(a.position);
 expect((await resources.moveTask(member,projectId,b.id,input,op)).version).toBe(2);
 expect((await resources.history(member,projectId,'task',a.id)).items).toHaveLength(1);
 await expect(resources.moveTask(member,projectId,b.id,input,randomUUID())).rejects.toMatchObject({code:'VERSION_CONFLICT'});
 await resources.updateTask(admin,projectId,a.id,{title:'anchor changed'},a.version,randomUUID());
 await expect(resources.moveTask(member,projectId,b.id,{...input,expectedVersion:2},randomUUID())).rejects.toMatchObject({code:'VERSION_CONFLICT'});
 await expect(resources.moveTask(viewer,projectId,b.id,{...input,expectedVersion:2},randomUUID())).rejects.toMatchObject({code:'FORBIDDEN'});
 const done=await resources.moveTask(member,projectId,b.id,{status:'done',beforeId:null,expectedVersion:2},randomUUID());expect(done.completedAt).toBeTruthy();
 const reopened=await resources.moveTask(member,projectId,b.id,{status:'todo',beforeId:null,expectedVersion:3},randomUUID());expect(reopened.completedAt).toBeNull();
});
it('filters task dates and unassigned tasks, including independent status pages',async()=>{
 const t=await resources.createTask(admin,projectId,{title:'dated task',dueDate:'2026-12-15',status:'in_review'},randomUUID());
 const page=await resources.listTasks(viewer,projectId,{status:'in_review',assigneeId:'unassigned',dueFrom:'2026-12-01',dueTo:'2026-12-31'});expect(page.items.map(t=>t.id)).toContain(t.id);
 expect((await resources.listTasks(viewer,projectId,{dueFrom:'2027-01-01'})).items.map(t=>t.id)).not.toContain(t.id);
 await expect(resources.listTasks(viewer,projectId,{dueFrom:'2026-99-01'})).rejects.toBeTruthy();
});
it('combines task/comment activity and protects removed comment content',async()=>{
 const t=await resources.createTask(member,projectId,{title:'discussion'},randomUUID());
 const c=await resources.addComment(member,projectId,t.id,'private removed comment',randomUUID());
 expect((await resources.taskActivity(viewer,projectId,t.id)).items).toHaveLength(2);
 await resources.deleteComment(admin,projectId,c.id as string,randomUUID());
 expect(JSON.stringify(await resources.comments(viewer,projectId,t.id))).not.toContain('private removed comment');
 const visible=await resources.taskActivity(viewer,projectId,t.id);expect(JSON.stringify(visible)).not.toContain('private removed comment');
 expect(JSON.stringify(await resources.taskActivity(admin,projectId,t.id))).toContain('private removed comment');
 await expect(resources.taskActivity(outsider,projectId,t.id)).rejects.toMatchObject({code:'NOT_FOUND'});
});
it('attaches images to comments and hides them when the comment is deleted',async()=>{
 const task=await resources.createTask(member,projectId,{title:'comment image'},randomUUID());
 const image=new File([new Uint8Array([137,80,78,71,13,10,26,10,1])],'screen.png',{type:'image/png'});
 const comment=await resources.addComment(member,projectId,task.id,'',randomUUID(),[image]);
 const listed=await resources.comments(viewer,projectId,task.id);
 expect(listed.items[0].attachments[0]).toMatchObject({name:'screen.png',mimeType:'image/png'});
 const fileId=comment.attachments[0].id;
 expect((await files.download(viewer,fileId)).bytes.length).toBe(9);
 await resources.deleteComment(admin,projectId,comment.id,randomUUID());
 expect((await resources.comments(viewer,projectId,task.id)).items[0].attachments).toEqual([]);
 await expect(files.download(viewer,fileId)).rejects.toMatchObject({code:'NOT_FOUND'});
 expect((await files.download(admin,fileId)).file.id).toBe(fileId);
});
it('links documents in both directions and hides deleted targets',async()=>{
 const t=await resources.createTask(member,projectId,{title:'linked task'},randomUUID());const d=await resources.createDocument(member,projectId,{title:'linked wiki',content:fromMarkdown('关联')},randomUUID());
 await resources.linkTask(member,projectId,t.id,d.id,randomUUID());expect((await resources.documentLinks(viewer,projectId,d.id)).map(t=>t.id)).toContain(t.id);
 await resources.lifecycle(admin,projectId,'task',t.id,'delete',1,randomUUID());expect(await resources.documentLinks(viewer,projectId,d.id)).toHaveLength(0);
});

it('filters history and records unchanged explicit document saves',async()=>{
 const d=await resources.createDocument(member,projectId,{title:'history filters',content:fromMarkdown('text')},randomUUID());
 await resources.updateDocument(member,projectId,d.id,{title:d.title,content:d.content},1,randomUUID());
 const all=await resources.history(viewer,projectId,'document',d.id,undefined,{source:'web',actor:'User 1'});expect(all.items).toHaveLength(2);
 expect((await resources.history(viewer,projectId,'document',d.id,undefined,{source:'mcp'})).items).toHaveLength(0);
 expect((await resources.getResource(member,projectId,'document',d.id)).version).toBe(2);
});
it('rejects cross-project ordering and concurrent moves of the same task',async()=>{
 const another=await projects.createProject(admin,{name:'other board'},randomUUID());const anchor=await resources.createTask(admin,another.id,{title:'foreign anchor'},randomUUID());
 const t=await resources.createTask(member,projectId,{title:'parallel move'},randomUUID());
 await expect(resources.moveTask(admin,projectId,t.id,{status:'todo',beforeId:anchor.id,beforeVersion:1,expectedVersion:1},randomUUID())).rejects.toMatchObject({code:'NOT_FOUND'});
 const changes=await Promise.allSettled(['done','in_review'].map(status=>resources.moveTask(member,projectId,t.id,{status:status as 'done'|'in_review',beforeId:null,expectedVersion:1},randomUUID())));expect(changes.filter(c=>c.status==='fulfilled')).toHaveLength(1);
 expect((await resources.history(viewer,projectId,'task',t.id)).items).toHaveLength(2);
});

it('manages project labels transactionally across active, archived and deleted tasks',async()=>{
 const a=await resources.createTask(member,projectId,{title:'label active',labels:['Old']},randomUUID());const b=await resources.createTask(member,projectId,{title:'label archived',labels:['Old']},randomUUID());
 await resources.lifecycle(admin,projectId,'task',b.id,'archive',1,randomUUID());
 const label=(await labels.listLabels(member,projectId)).find(l=>l.name==='Old')!;
 await expect(labels.changeLabel(viewer,projectId,label.id,'New',1,randomUUID())).rejects.toMatchObject({code:'FORBIDDEN'});
 const op=randomUUID();const changed=await labels.changeLabel(member,projectId,label.id,'New',1,op);expect(changed.affectedTasks).toBe(2);
 expect((await labels.changeLabel(member,projectId,label.id,'New',1,op)).version).toBe(2);
 expect(await resources.getResource(viewer,projectId,'task',a.id)).toMatchObject({labels:['New']});
 expect((await resources.getResource(viewer,projectId,'task',b.id)).version).toBe(3);
 expect(JSON.stringify(await resources.getVersion(viewer,projectId,'task',a.id,1))).toContain('Old');
 await expect(resources.updateTask(member,projectId,a.id,{labels:['Old']},1,randomUUID())).rejects.toMatchObject({code:'VERSION_CONFLICT'});
 await expect(labels.changeLabel(member,projectId,label.id,null,2,randomUUID())).rejects.toMatchObject({code:'FORBIDDEN'});
 await resources.lifecycle(admin,projectId,'task',a.id,'delete',2,randomUUID());
 await labels.changeLabel(admin,projectId,label.id,null,2,randomUUID());
 const restored=await resources.lifecycle(admin,projectId,'task',a.id,'restore',4,randomUUID());expect(restored.labels).toEqual([]);
 await expect(resources.createTask(member,projectId,{title:'stale deleted label',labels:['New']},randomUUID())).rejects.toMatchObject({code:'LABEL_DELETED'});
});
it('keeps label names project-scoped and rejects colliding renames without changes',async()=>{
 const p=await projects.createProject(admin,{name:'label isolation'},randomUUID());const label=await labels.createLabel(admin,p.id,'One',randomUUID());await labels.createLabel(admin,p.id,'Two',randomUUID());
 await expect(labels.changeLabel(admin,p.id,label.id,'Two',1,randomUUID())).rejects.toMatchObject({code:'LABEL_EXISTS'});
 expect((await labels.listLabels(admin,p.id)).find(l=>l.id===label.id)?.version).toBe(1);
 await expect(labels.changeLabel(admin,projectId,label.id,'Outside',1,randomUUID())).rejects.toMatchObject({code:'NOT_FOUND'});
 await expect(labels.listLabels(outsider,p.id)).rejects.toMatchObject({code:'NOT_FOUND'});
});
it('protects team roles and keeps project membership independent of team changes',async()=>{
 const team=await projects.createTeam(admin,'Team control',randomUUID());await db.execute(sql`INSERT INTO team_members(team_id,user_id,role) VALUES(${team.id},${member.userId},'member')`);
 await expect(projects.changeTeamRole(admin,team.id,admin.userId,'member','admin',randomUUID())).rejects.toMatchObject({code:'LAST_ADMIN'});
 await expect(projects.renameTeam(member,team.id,'denied',1,randomUUID())).rejects.toMatchObject({code:'NOT_FOUND'});
 await projects.renameTeam(admin,team.id,'Renamed team',1,randomUUID());
 await expect(projects.renameTeam(admin,team.id,'stale',1,randomUUID())).rejects.toMatchObject({code:'VERSION_CONFLICT'});
 const p=await projects.createProject(admin,{name:'linked team project',teamId:team.id},randomUUID());
 await expect(projects.getProject(member,p.id)).rejects.toMatchObject({code:'NOT_FOUND'});
 await projects.addFromTeam(admin,p.id,team.id,[member.userId],'member',randomUUID());
 await projects.manageTeam(admin,team.id,'remove_member',member.userId,randomUUID(),2);expect((await projects.getProject(member,p.id)).role).toBe('member');
 await projects.manageTeam(admin,team.id,'delete',null,randomUUID(),2);expect((await projects.getProject(member,p.id)).teamId).toBeNull();
});
it('cannot concurrently demote the last two team administrators',async()=>{
 const team=await projects.createTeam(admin,'parallel team admins',randomUUID());await db.execute(sql`INSERT INTO team_members(team_id,user_id,role) VALUES(${team.id},${member.userId},'admin')`);
 const attempts=await Promise.allSettled([projects.changeTeamRole(admin,team.id,admin.userId,'member','admin',randomUUID()),projects.changeTeamRole(member,team.id,member.userId,'member','admin',randomUUID())]);
 expect(attempts.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect((await projects.teamMembers(admin,team.id)).filter(m=>m.role==='admin')).toHaveLength(1);
});
it('moves only sibling Wiki pages and preserves versioned content',async()=>{
 const p=await projects.createProject(admin,{name:'wiki order'},randomUUID());const a=await resources.createDocument(admin,p.id,{title:'A',content:fromMarkdown('A'),position:1024},randomUUID());const b=await resources.createDocument(admin,p.id,{title:'B',content:fromMarkdown('B'),position:2048},randomUUID());const c=await resources.createDocument(admin,p.id,{title:'child',parentId:a.id,content:fromMarkdown('child')},randomUUID());
 const input={direction:'up' as const,expectedVersion:1,neighborId:a.id,neighborVersion:1};const op=randomUUID();const moved=await resources.moveDocument(admin,p.id,b.id,input,op);expect(moved.position).toBeLessThan(a.position);expect(moved.content).toEqual(b.content);
 expect((await resources.moveDocument(admin,p.id,b.id,input,op)).version).toBe(2);expect((await resources.history(admin,p.id,'document',a.id)).items).toHaveLength(1);
 await expect(resources.moveDocument(admin,p.id,b.id,input,randomUUID())).rejects.toMatchObject({code:'VERSION_CONFLICT'});
 await expect(resources.moveDocument(admin,p.id,c.id,{...input,neighborId:b.id,neighborVersion:2},randomUUID())).rejects.toMatchObject({code:'VERSION_CONFLICT'});
 const back=await resources.moveDocument(admin,p.id,b.id,{direction:'down',expectedVersion:2,neighborId:a.id,neighborVersion:1},randomUUID());expect(back.position).toBeGreaterThan(a.position);
 await expect(resources.moveDocument(outsider,p.id,b.id,{...input,expectedVersion:3},randomUUID())).rejects.toMatchObject({code:'NOT_FOUND'});
});

});


describe('permission regression matrix',()=>{
 async function fixture(){
  const p=await projects.createProject(admin,{name:'permission matrix'},randomUUID());
  for(const [a,role] of [[member,'member'],[viewer,'viewer']] as const)await db.execute(sql`INSERT INTO project_members(project_id,user_id,role) VALUES(${p.id},${a.userId},${role})`);
  const t=await resources.createTask(admin,p.id,{title:'protected',assigneeId:member.userId},randomUUID());
  const d=await resources.createDocument(admin,p.id,{title:'protected wiki',content:fromMarkdown('secret')},randomUUID());
  return {p,t,d};
 }
 it('blocks viewer writes across tasks, Wiki, comments, links, labels and membership',async()=>{
  const {p,t,d}=await fixture();
  const writes=[()=>resources.updateTask(viewer,p.id,t.id,{title:'denied'},1,randomUUID()),()=>resources.updateDocument(viewer,p.id,d.id,{title:'denied'},1,randomUUID()),()=>resources.addComment(viewer,p.id,t.id,'denied',randomUUID()),()=>resources.linkTask(viewer,p.id,t.id,d.id,randomUUID()),()=>labels.createLabel(viewer,p.id,'denied',randomUUID()),()=>projects.changeMember(viewer,p.id,member.userId,'admin',randomUUID()),()=>resources.lifecycle(viewer,p.id,'task',t.id,'delete',1,randomUUID())];
  for(const write of writes)await expect(write()).rejects.toMatchObject({code:'FORBIDDEN'});
  expect((await resources.history(viewer,p.id,'task',t.id)).items).toHaveLength(1);
  expect((await resources.history(viewer,p.id,'document',d.id)).items).toHaveLength(1);
 });
 it('rechecks roles before replaying saved operations and before cached MCP actor writes',async()=>{
  const {p,t}=await fixture();const op=randomUUID();const input={title:'saved'};
  await resources.updateTask(member,p.id,t.id,input,1,op);
  const c=await credentials.createCredential(member,{name:'role regression',projectIds:[p.id],scope:'write'},randomUUID());const actor=await credentials.credentialActor(c.token);
  await projects.changeMember(admin,p.id,member.userId,'viewer',randomUUID());
  for(const a of [member,actor])await expect(resources.updateTask(a,p.id,t.id,input,1,op)).rejects.toMatchObject({code:'FORBIDDEN'});
  expect((await resources.getResource(actor,p.id,'task',t.id)).version).toBe(2);
  await projects.changeMember(admin,p.id,member.userId,null,randomUUID());
  for(const a of [member,actor]){
   await expect(resources.getResource(a,p.id,'task',t.id)).rejects.toMatchObject({code:'NOT_FOUND'});
   await expect(resources.getVersion(a,p.id,'task',t.id,1)).rejects.toMatchObject({code:'NOT_FOUND'});
   await expect(resources.history(a,p.id,'task',t.id)).rejects.toMatchObject({code:'NOT_FOUND'});
   expect((await projects.listProjects(a)).map(p=>p.id)).not.toContain(p.id);
  }
  expect(await resources.getResource(admin,p.id,'task',t.id)).toMatchObject({assigneeId:null,version:3});
 });
 it('rejects foreign resources even when the caller belongs to both projects',async()=>{
  const {p,t,d}=await fixture();const other=await projects.createProject(admin,{name:'other permission scope'},randomUUID());
  await expect(resources.getResource(admin,other.id,'task',t.id)).rejects.toMatchObject({code:'NOT_FOUND'});
  await expect(resources.getVersion(admin,other.id,'document',d.id,1)).rejects.toMatchObject({code:'NOT_FOUND'});
  await expect(resources.updateTask(admin,other.id,t.id,{title:'wrong project'},1,randomUUID())).rejects.toMatchObject({code:'NOT_FOUND'});
  await expect(resources.linkTask(admin,other.id,t.id,d.id,randomUUID())).rejects.toBeTruthy();
  const c=await credentials.createCredential(admin,{name:'one project',projectIds:[p.id],scope:'write'},randomUUID());const actor=await credentials.credentialActor(c.token);
  await expect(projects.getProject(actor,other.id)).rejects.toMatchObject({code:'CREDENTIAL_SCOPE'});
  await expect(resources.lifecycle(actor,p.id,'task',t.id,'delete',1,randomUUID())).rejects.toMatchObject({code:'CREDENTIAL_SCOPE'});
 });
 it('keeps archived projects readable while rejecting all collaboration writes',async()=>{
  const {p,t,d}=await fixture();await resources.lifecycle(admin,p.id,'project',p.id,'archive',p.version,randomUUID());
  expect((await resources.getResource(viewer,p.id,'document',d.id)).id).toBe(d.id);
  for(const write of [()=>resources.updateTask(member,p.id,t.id,{title:'denied'},1,randomUUID()),()=>resources.updateDocument(member,p.id,d.id,{title:'denied'},1,randomUUID()),()=>resources.addComment(member,p.id,t.id,'denied',randomUUID()),()=>resources.linkTask(member,p.id,t.id,d.id,randomUUID()),()=>labels.createLabel(member,p.id,'denied',randomUUID())])await expect(write()).rejects.toMatchObject({code:'PROJECT_READONLY'});
 });
 it('rejects expired and revoked invitations without adding membership',async()=>{
  const p=await projects.createProject(admin,{name:'invite boundary'},randomUUID());
  for(const expired of [true,false]){
   const invite=await createInvitation(admin,'project',p.id,`${outsider.userId}@example.test`,'member',randomUUID());
   if(expired)await db.execute(sql`UPDATE invitations SET expires_at=now()-interval '1 second' WHERE id=${invite.id}`);else await revokeInvitation(admin,invite.id,randomUUID());
   await expect(acceptInvitation(outsider,new URL(invite.url).searchParams.get('token')!)).rejects.toMatchObject({code:'INVALID_INVITE'});
  }
  await expect(projects.getProject(outsider,p.id)).rejects.toMatchObject({code:'NOT_FOUND'});
 });
 it('protects the last project administrator against concurrent removals',async()=>{
  const {p}=await fixture();await projects.changeMember(admin,p.id,member.userId,'admin',randomUUID());
  const results=await Promise.allSettled([projects.changeMember(admin,p.id,admin.userId,'member',randomUUID()),projects.changeMember(member,p.id,member.userId,'member',randomUUID())]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect((results.find(r=>r.status==='rejected') as PromiseRejectedResult).reason.code).toBe('LAST_ADMIN');
  expect((await projects.listMembers(admin,p.id)).filter(m=>m.role==='admin')).toHaveLength(1);
 });
});

describe('authorization changes during queued requests',()=>{
 async function waitForBlocked(count:number){await vi.waitFor(async()=>{const r=await pool.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'");expect(r.rows[0].count).toBeGreaterThanOrEqual(count);},{timeout:5000,interval:20});}
 it('rejects invitation consumption queued behind issuer demotion',async()=>{
  const p=await projects.createProject(admin,{name:'queued invitation'},randomUUID());
  await db.execute(sql`INSERT INTO project_members(project_id,user_id,role) VALUES(${p.id},${member.userId},'admin')`);
  const invite=await createInvitation(member,'project',p.id,`${outsider.userId}@example.test`,'member',randomUUID());
  const blocker=await pool.connect();let pending:Promise<PromiseSettledResult<unknown>[]>|undefined;
  try{
   await blocker.query('BEGIN');await blocker.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[p.id]);
   const demote=Promise.allSettled([projects.changeMember(admin,p.id,member.userId,'member',randomUUID())]);await waitForBlocked(1);
   pending=Promise.allSettled([acceptInvitation(outsider,new URL(invite.url).searchParams.get('token')!)]);await waitForBlocked(2);
   await blocker.query('COMMIT');expect((await demote)[0].status).toBe('fulfilled');
   const result=(await pending)[0];expect(result.status).toBe('rejected');expect((result as PromiseRejectedResult).reason.code).toBe('FORBIDDEN');
   expect(await one(db,sql`SELECT user_id FROM project_members WHERE project_id=${p.id} AND user_id=${outsider.userId}`)).toBeUndefined();
   expect((await one(db,sql`SELECT accepted_at FROM invitations WHERE id=${invite.id}`))?.acceptedAt).toBeNull();
  }finally{await blocker.query('ROLLBACK');blocker.release();await pending;}
 });
 it('consumes a concurrently accepted invitation once and audits it once',async()=>{
  const p=await projects.createProject(admin,{name:'single invitation consumption'},randomUUID());
  const invite=await createInvitation(admin,'project',p.id,`${outsider.userId}@example.test`,'member',randomUUID());const value=new URL(invite.url).searchParams.get('token')!;
  const results=await Promise.allSettled([acceptInvitation(outsider,value),acceptInvitation(outsider,value)]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect((results.find(r=>r.status==='rejected') as PromiseRejectedResult).reason.code).toBe('INVALID_INVITE');
  expect((await one<{count:number}>(db,sql`SELECT count(*)::int count FROM audit_events WHERE resource_id=${invite.id} AND operation='accept'`))?.count).toBe(1);
 });
 it('rejects a cached credential actor queued behind revocation without saving a version',async()=>{
  const p=await projects.createProject(admin,{name:'queued credential'},randomUUID());const t=await resources.createTask(admin,p.id,{title:'unchanged'},randomUUID());
  const c=await credentials.createCredential(admin,{name:'queued token',projectIds:[p.id],scope:'write'},randomUUID());const actor=await credentials.credentialActor(c.token);
  const blocker=await pool.connect();let pending:Promise<PromiseSettledResult<unknown>[]>|undefined;
  try{
   await blocker.query('BEGIN');await blocker.query('SELECT id FROM api_credentials WHERE id=$1 FOR UPDATE',[c.id]);
   const revoke=Promise.allSettled([credentials.revokeCredential(admin,c.id,randomUUID())]);await waitForBlocked(1);
   pending=Promise.allSettled([resources.updateTask(actor,p.id,t.id,{title:'denied'},1,randomUUID())]);await waitForBlocked(2);
   await blocker.query('COMMIT');expect((await revoke)[0].status).toBe('fulfilled');const result=(await pending)[0];expect(result.status).toBe('rejected');expect((result as PromiseRejectedResult).reason.code).toBe('INVALID_CREDENTIAL');
   expect((await resources.history(admin,p.id,'task',t.id)).items).toHaveLength(1);
  }finally{await blocker.query('ROLLBACK');blocker.release();await pending;}
 });
 it('rechecks credential expiry for cached actors and operation receipt retries',async()=>{
  const p=await projects.createProject(admin,{name:'expired credential'},randomUUID());const c=await credentials.createCredential(admin,{name:'expiring',projectIds:[p.id],scope:'write',expiresAt:new Date(Date.now()+60000).toISOString()},randomUUID());const actor=await credentials.credentialActor(c.token);const op=randomUUID();const input={title:'saved before expiry'};
  const t=await resources.createTask(actor,p.id,input,op);await db.execute(sql`UPDATE api_credentials SET expires_at=now()-interval '1 second' WHERE id=${c.id}`);
  await expect(credentials.credentialActor(c.token)).rejects.toMatchObject({code:'INVALID_CREDENTIAL'});await expect(resources.createTask(actor,p.id,input,op)).rejects.toMatchObject({code:'INVALID_CREDENTIAL'});await expect(resources.getResource(actor,p.id,'task',t.id)).rejects.toMatchObject({code:'INVALID_CREDENTIAL'});
  expect((await resources.history(admin,p.id,'task',t.id)).items).toHaveLength(1);
 });
});

it('counts child progress consistently after archiving and deleting children',async()=>{
 const p=await projects.createProject(admin,{name:'child count regression'},randomUUID());const parent=await resources.createTask(admin,p.id,{title:'parent'},randomUUID());
 const todo=await resources.createTask(admin,p.id,{title:'child todo',parentId:parent.id},randomUUID());const done=await resources.createTask(admin,p.id,{title:'child done',parentId:parent.id,status:'done'},randomUUID());
 const other=await resources.createTask(admin,p.id,{title:'another root'},randomUUID());await resources.createTask(admin,p.id,{title:'unrelated child',parentId:other.id},randomUUID());
 let result=await resources.listTasks(admin,p.id,{roots:true,status:'todo'});expect(result.items.find(t=>t.id===parent.id)).toMatchObject({childCount:2,childDone:1});expect(result.items.find(t=>t.id===other.id)).toMatchObject({childCount:1,childDone:0});
 await resources.lifecycle(admin,p.id,'task',done.id,'archive',1,randomUUID());await resources.lifecycle(admin,p.id,'task',todo.id,'delete',1,randomUUID());
 result=await resources.listTasks(admin,p.id,{roots:true,status:'todo'});expect(result.items.find(t=>t.id===parent.id)).toMatchObject({childCount:1,childDone:1});
});

describe('subtask linking and independent board movement',()=>{
 it('links and unlinks an existing task without changing its work fields, with history and retry protection',async()=>{
  const p=await projects.createProject(admin,{name:'link regression'},randomUUID());
  const parent=await resources.createTask(admin,p.id,{title:'Parent'},randomUUID());
  const task=await resources.createTask(admin,p.id,{title:'Existing',status:'in_progress',priority:'high',assigneeId:admin.userId,description:fromMarkdown('keep me')},randomUUID());
  const op=randomUUID();const linked=await resources.updateTask(admin,p.id,task.id,{parentId:parent.id},1,op);
  expect(linked).toMatchObject({parentId:parent.id,number:task.number,status:task.status,priority:task.priority,assigneeId:task.assigneeId,description:task.description});
  expect((await resources.updateTask(admin,p.id,task.id,{parentId:parent.id},1,op)).version).toBe(2);
  expect((await resources.listTasks(admin,p.id)).items.find(t=>t.id===task.id)).toMatchObject({parentNumber:parent.number,parentTitle:parent.title});
  expect((await resources.listTasks(admin,p.id,{roots:true})).items.map(t=>t.id)).not.toContain(task.id);
  expect((await resources.listTasks(admin,p.id,{parentId:parent.id})).items.map(t=>t.id)).toContain(task.id);
  const detached=await resources.updateTask(admin,p.id,task.id,{parentId:null},2,randomUUID());expect(detached.parentId).toBeNull();expect(detached.status).toBe('in_progress');
  expect((await resources.history(admin,p.id,'task',task.id)).items).toHaveLength(3);
  expect((await resources.listTasks(admin,p.id,{attachTo:parent.id,query:`#${task.number}`})).items.map(t=>t.id)).toEqual([task.id]);
 });
 it('rejects invalid hierarchy, reassignment, archived parents and viewer writes',async()=>{
  const parent=await resources.createTask(admin,projectId,{title:'link parent'},randomUUID());const child=await resources.createTask(admin,projectId,{title:'link child',parentId:parent.id},randomUUID());const other=await resources.createTask(admin,projectId,{title:'link other'},randomUUID());
  await expect(resources.updateTask(admin,projectId,parent.id,{parentId:parent.id},1,randomUUID())).rejects.toMatchObject({code:'INVALID_PARENT'});
  await expect(resources.updateTask(admin,projectId,parent.id,{parentId:other.id},1,randomUUID())).rejects.toMatchObject({code:'INVALID_PARENT'});
  await expect(resources.updateTask(admin,projectId,other.id,{parentId:child.id},1,randomUUID())).rejects.toMatchObject({code:'INVALID_PARENT'});
  await expect(resources.updateTask(admin,projectId,child.id,{parentId:other.id},1,randomUUID())).rejects.toMatchObject({code:'ALREADY_PARENTED'});
  await expect(resources.updateTask(viewer,projectId,other.id,{parentId:parent.id},1,randomUUID())).rejects.toMatchObject({code:'FORBIDDEN'});
  const p=await projects.createProject(admin,{name:'foreign project'},randomUUID());const foreign=await resources.createTask(admin,p.id,{title:'foreign'},randomUUID());
  await expect(resources.updateTask(admin,projectId,other.id,{parentId:foreign.id},1,randomUUID())).rejects.toMatchObject({code:'INVALID_PARENT'});
  await resources.lifecycle(admin,projectId,'task',parent.id,'archive',1,randomUUID());
  await expect(resources.updateTask(admin,projectId,other.id,{parentId:parent.id},1,randomUUID())).rejects.toMatchObject({code:'INVALID_PARENT'});
 });
 it('allows only one concurrent attachment and moves child independently among root tasks',async()=>{
  const p=await projects.createProject(admin,{name:'child move regression'},randomUUID());const a=await resources.createTask(admin,p.id,{title:'A'},randomUUID());const b=await resources.createTask(admin,p.id,{title:'B'},randomUUID());const c=await resources.createTask(admin,p.id,{title:'C'},randomUUID());
  const result=await Promise.allSettled([a,b].map(parent=>resources.updateTask(admin,p.id,c.id,{parentId:parent.id},1,randomUUID())));expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect((result.find(r=>r.status==='rejected') as PromiseRejectedResult).reason.code).toBe('VERSION_CONFLICT');
  const linked=await resources.getResource(admin,p.id,'task',c.id) as any;
  const moved=await resources.moveTask(admin,p.id,c.id,{status:'todo',beforeId:a.id,beforeVersion:a.version,expectedVersion:2},randomUUID());expect(moved.position).toBeLessThan(a.position);expect(moved.parentId).toBe(linked.parentId);
  const done=await resources.moveTask(admin,p.id,c.id,{status:'done',beforeId:null,expectedVersion:3},randomUUID());expect(done.completedAt).toBeTruthy();
  expect(await resources.getResource(admin,p.id,'task',linked.parentId)).toMatchObject({status:'todo',version:1});
  expect((await resources.listTasks(admin,p.id,{status:'done'})).items.map(t=>t.id)).toContain(c.id);
  expect((await resources.listTasks(admin,p.id,{attachTo:a.id})).items.some(t=>t.id===c.id||t.id===a.id||t.id===linked.parentId)).toBe(false);
 });
});

it('paginates project names across all records with status and permission filters', async () => {
  const prefix=`pagination-${randomUUID()}`;
  await db.execute(sql`WITH added AS (
    INSERT INTO projects(id,name,description,creator_id,created_at)
    SELECT gen_random_uuid(),${prefix} || '-' || lpad(n::text,3,'0'),'description only needle',${admin.userId},now() - n * interval '1 minute'
    FROM generate_series(1,211) n RETURNING id
  ) INSERT INTO project_members(project_id,user_id,role) SELECT id,${admin.userId},'admin' FROM added`);
  const first=await projects.listProjectPage(admin,{query:prefix,page:1,pageSize:10});
  const second=await projects.listProjectPage(admin,{query:prefix,page:2,pageSize:10});
  expect(first.total).toBe(211);expect(first.items).toHaveLength(10);
  expect(second.items.some(p=>first.items.some(a=>a.id===p.id))).toBe(false);
  expect((await projects.listProjectPage(admin,{query:prefix+'-211',page:1})).items).toHaveLength(1);
  expect((await projects.listProjectPage(admin,{query:prefix,page:999}))).toMatchObject({page:22,total:211,items:[expect.anything()]});
  expect((await projects.listProjectPage(outsider,{query:prefix})).total).toBe(0);
  const target=first.items[0];
  await resources.lifecycle(admin,target.id,'project',target.id,'archive',target.version,randomUUID());
  expect((await projects.listProjectPage(admin,{query:prefix,status:'active'})).total).toBe(210);
  expect((await projects.listProjectPage(admin,{query:prefix,status:'archived'})).total).toBe(1);
  expect((await projects.listProjectPage(admin,{query:prefix,status:'all'})).total).toBe(211);
  await resources.lifecycle(admin,target.id,'project',target.id,'delete',target.version+1,randomUUID());
  await db.execute(sql`INSERT INTO project_members(project_id,user_id,role) VALUES(${target.id},${member.userId},'member')`);
  expect((await projects.listProjectPage(admin,{query:prefix,status:'deleted'})).total).toBe(1);
  expect((await projects.listProjectPage(member,{query:prefix,status:'deleted'})).total).toBe(0);
  const special=await projects.createProject(admin,{name:prefix+' literal%_name'},randomUUID());
  expect((await projects.listProjectPage(admin,{query:prefix+' literal%_'})).items.map(p=>p.id)).toEqual([special.id]);
  await expect(projects.listProjectPage(admin,{page:0})).rejects.toBeTruthy();
  await expect(projects.listProjectPage(admin,{pageSize:500})).rejects.toBeTruthy();
});


it('paginates system accounts with name/email search and administrator authorization',async()=>{
  const owner:Actor={userId:randomUUID(),source:'web'};const prefix=`system-page-${randomUUID()}`;
  await db.execute(sql`INSERT INTO users(id,name,email,is_admin,identity_source) VALUES(${owner.userId},'System manager',${owner.userId+'@example.test'},true,'invite')`);
  await db.execute(sql`INSERT INTO users(id,name,email,is_admin,disabled,identity_source)
    SELECT gen_random_uuid(),${prefix}||'-'||n,${prefix}||'-'||n||'@example.test',n=1,n%2=0,'invite' FROM generate_series(1,511) n`);
  await expect(adminUserPage(member,{})).rejects.toMatchObject({code:'FORBIDDEN'});
  const first=await adminUserPage(owner,{query:prefix,page:1});const second=await adminUserPage(owner,{query:prefix,page:2});
  expect(first.total).toBe(511);expect(first.items).toHaveLength(10);expect(second.items.some(b=>first.items.some(a=>a.id===b.id))).toBe(false);
  expect((await adminUserPage(owner,{query:prefix+'-511@example.test'})).total).toBe(1);
  expect((await adminUserPage(owner,{query:prefix,role:'admin'})).total).toBe(1);
  expect((await adminUserPage(owner,{query:prefix,role:'user',status:'disabled'})).total).toBe(255);
  expect((await adminUserPage(owner,{query:prefix,page:999}))).toMatchObject({page:52,total:511,items:[expect.anything()]});
  expect((await adminUserPage(owner,{query:prefix+'%'})).total).toBe(0);
  await expect(adminUserPage(owner,{pageSize:10000})).rejects.toBeTruthy();
});
