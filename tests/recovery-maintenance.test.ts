import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, readdir, utimes, unlink, rmdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { auth } from '../apps/server/src/modules/auth';
const mail=vi.fn().mockResolvedValue({});
import { db, pool, one } from '../apps/server/src/db';
import { migrate } from '../apps/server/src/db/migrate';
import { config } from '../apps/server/src/config';
import { issueRecovery, resetPassword, mailTransport, hasApplicationUsers, setUserDisabled } from '../apps/server/src/modules/accounts';
import { issueHostRecovery, requestEmailRecovery } from '../apps/server/src/modules/recovery';
import { cleanOrphanFiles } from '../apps/server/src/modules/file-maintenance';
import { upload, download, storageIO } from '../apps/server/src/modules/files';
import * as resources from '../apps/server/src/modules/resources';
import * as projects from '../apps/server/src/modules/projects';
import * as credentials from '../apps/server/src/modules/credentials';
import type { Actor } from '../apps/server/src/modules/core';
const admin:Actor={userId:randomUUID(),source:'web'};const member:Actor={userId:randomUUID(),source:'web'};
const adminEmail=`${admin.userId}@example.test`;const memberEmail=`${member.userId}@example.test`;let projectId:string;
const folder=resolve('.data',`maintenance-test-${randomUUID()}`);const originalFolder=config.UPLOAD_DIR;
beforeAll(async()=>{
 await migrate(process.env.TEST_DATABASE_URL);await mkdir(folder,{recursive:true});config.UPLOAD_DIR=folder;
 const password='unused-initial-test-hash';
 for(const [actor,email,isAdmin] of [[admin,adminEmail,true],[member,memberEmail,false]] as const){await db.execute(sql`INSERT INTO users(id,name,email,is_admin,identity_source) VALUES(${actor.userId},'Recovery test',${email},${isAdmin},'invite')`);await db.execute(sql`INSERT INTO accounts(id,account_id,provider_id,user_id,password) VALUES(${randomUUID()},${actor.userId},'credential',${actor.userId},${password})`);}
 projectId=(await projects.createProject(admin,{name:'Recovery and files'},randomUUID())).id;
 await db.execute(sql`INSERT INTO project_members(project_id,user_id,role) VALUES(${projectId},${member.userId},'member')`);
});
afterAll(async()=>{
 config.UPLOAD_DIR=originalFolder;vi.useRealTimers();
 try{
  const entries=await readdir(folder).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return null;throw error;});
  if(entries){for(const name of entries)await unlink(resolve(folder,name));await rmdir(folder);}
 }finally{await pool.end();}
});
const recoveryToken=(url:string)=>new URL(url).searchParams.get('token')!;
describe('account recovery and file maintenance',()=>{
 it('excludes the audit-only identity from installation and account enablement',async()=>{
  await db.transaction(async tx=>{await tx.execute(sql`CREATE TEMP TABLE users(id text PRIMARY KEY) ON COMMIT DROP`);await tx.execute(sql`INSERT INTO users(id) VALUES('system:account-recovery')`);expect(await hasApplicationUsers(tx)).toBe(false);await tx.execute(sql`INSERT INTO users(id) VALUES('first-human')`);expect(await hasApplicationUsers(tx)).toBe(true);});
  await expect(setUserDisabled(admin,'system:account-recovery',false,randomUUID())).rejects.toMatchObject({code:'FORBIDDEN'});
 });
 it('allows one recovery consumption and revokes previous sessions and MCP credentials',async()=>{
  const credential=await credentials.createCredential(member,{name:'old key',projectIds:[projectId],scope:'write'},randomUUID());
  await db.execute(sql`INSERT INTO sessions(id,token,user_id,expires_at) VALUES(${randomUUID()},${randomUUID()},${member.userId},now()+interval '1 day')`);
  await expect(issueRecovery(member,admin.userId,randomUUID())).rejects.toMatchObject({code:'FORBIDDEN'});
  const recovery=await issueRecovery(admin,member.userId,randomUUID());const value=recoveryToken(recovery.url);
  const concurrent=await Promise.allSettled([resetPassword(value,'Recovered-password-one'),resetPassword(value,'Recovered-password-two')]);expect(concurrent.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect(await one(db,sql`SELECT id FROM sessions WHERE user_id=${member.userId}`)).toBeUndefined();
  await expect(credentials.credentialActor(credential.token)).rejects.toMatchObject({code:'INVALID_CREDENTIAL'});
  await expect(resetPassword(value,'Replay-password')).rejects.toMatchObject({code:'INVALID_TOKEN'});
  const event=await one(db,sql`SELECT * FROM audit_events WHERE resource_id=${member.userId} AND operation='reset_password'`);expect(event).toBeTruthy();expect(JSON.stringify(event)).not.toContain(value);
 });
 it('reissues links safely and rejects expired or disabled recovery',async()=>{
  const old=await issueRecovery(admin,member.userId,randomUUID());const current=await issueRecovery(admin,member.userId,randomUUID());
  await expect(resetPassword(recoveryToken(old.url),'No-longer-valid')).rejects.toMatchObject({code:'INVALID_TOKEN'});
  await db.execute(sql`UPDATE recovery_tokens SET expires_at=now()-interval '1 minute' WHERE id=${current.id}`);
  await expect(resetPassword(recoveryToken(current.url),'Expired-password')).rejects.toMatchObject({code:'INVALID_TOKEN'});
  const disabled=await issueRecovery(admin,member.userId,randomUUID());await db.execute(sql`UPDATE users SET disabled=true WHERE id=${member.userId}`);
  try{await expect(resetPassword(recoveryToken(disabled.url),'Disabled-password')).rejects.toMatchObject({code:'UNAUTHENTICATED'});}finally{await db.execute(sql`UPDATE users SET disabled=false WHERE id=${member.userId}`);}
 });
 it('attributes host recovery to a system principal and cannot elevate an ordinary account',async()=>{
  await expect(issueHostRecovery(memberEmail,'test ordinary member')).rejects.toMatchObject({code:'NOT_INSTANCE_ADMIN'});
  const link=await issueHostRecovery(adminEmail,'test host recovery workflow');const value=recoveryToken(link.url);
  const event=await one(db,sql`SELECT * FROM audit_events WHERE resource_id=${admin.userId} AND operation='host_recovery_issued' ORDER BY created_at DESC LIMIT 1`);
  expect(event).toMatchObject({actorId:'system:account-recovery',source:'system'});expect(JSON.stringify(event)).not.toContain(value);expect(event?.changes).toHaveProperty('operator');
  await resetPassword(value,'Recovered-host-password');const login=await auth.api.signInEmail({body:{email:adminEmail,password:'Recovered-host-password'}});expect(login.user.id).toBe(admin.userId);
 });
 it('returns generic email responses, uses a mocked transport and handles delivery failure',async()=>{
  const transport=vi.spyOn(mailTransport,'create').mockReturnValue({sendMail:mail} as any);
  const originalHost=config.SMTP_HOST,originalFrom=config.SMTP_FROM;config.SMTP_HOST='mock.invalid';config.SMTP_FROM='noreply@example.test';
  try{
   // Use a fresh password account with no recent recovery requests.
   const id=randomUUID(),email=`${id}@example.test`;await db.execute(sql`INSERT INTO users(id,name,email,email_verified,identity_source) VALUES(${id},'Mail test',${email},true,'email')`);
   const known=await requestEmailRecovery(email);const unknown=await requestEmailRecovery('missing@example.test');expect(known).toEqual(unknown);expect(mail).toHaveBeenCalledTimes(1);
   await requestEmailRecovery(email);expect(mail).toHaveBeenCalledTimes(1);
   const unverified=randomUUID(),unverifiedEmail=`${unverified}@example.test`;await db.execute(sql`INSERT INTO users(id,name,email,identity_source) VALUES(${unverified},'Unverified mail',${unverifiedEmail},'self')`);
   expect(await requestEmailRecovery(unverifiedEmail)).toEqual(unknown);expect(mail).toHaveBeenCalledTimes(1);
   expect(await one(db,sql`SELECT id FROM recovery_tokens WHERE user_id=${unverified}`)).toBeUndefined();
   const other=randomUUID(),otherEmail=`${other}@example.test`;await db.execute(sql`INSERT INTO users(id,name,email,email_verified,identity_source) VALUES(${other},'Mail failure',${otherEmail},true,'email')`);mail.mockRejectedValueOnce(new Error('SMTP secret details'));
   expect(await requestEmailRecovery(otherEmail)).toEqual(unknown);expect(await one(db,sql`SELECT id FROM recovery_tokens WHERE user_id=${other} AND consumed_at IS NULL`)).toBeUndefined();
  }finally{transport.mockRestore();config.SMTP_HOST=originalHost;config.SMTP_FROM=originalFrom;}
 });
 it('rolls back task state and leaves an unregistered file after an audit failure',async()=>{
  const task=await resources.createTask(admin,projectId,{title:'atomic attachment'},randomUUID());const trigger=`test_failure_${randomUUID().replaceAll('-','')}`;
  await db.execute(sql.raw(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.resource_id='${task.id}' THEN RAISE EXCEPTION 'injected audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER ${trigger} BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION ${trigger}()`));
  const beforeFiles=await readdir(folder);
  try{await expect(resources.updateTask(admin,projectId,task.id,{title:'must roll back'},1,randomUUID())).rejects.toThrow();await expect(upload(admin,projectId,'task',task.id,new File(['payload'],'audit.txt'),1,randomUUID())).rejects.toThrow();}finally{await db.execute(sql.raw(`DROP TRIGGER ${trigger} ON audit_events; DROP FUNCTION ${trigger}()`));}
  expect((await resources.getResource(admin,projectId,'task',task.id)).version).toBe(1);expect((await resources.history(admin,projectId,'task',task.id)).items).toHaveLength(1);
  const orphan=(await readdir(folder)).find(name=>!beforeFiles.includes(name))!;expect(orphan).toBeTruthy();expect(await one(db,sql`SELECT id FROM files WHERE storage_key=${orphan}`)).toBeUndefined();
 });
 it('rejects disk write failure before metadata and version commit',async()=>{
  const task=await resources.createTask(admin,projectId,{title:'disk failure'},randomUUID());const failure=vi.spyOn(storageIO,'writeFile').mockRejectedValueOnce(new Error('disk full'));
  try{await expect(upload(admin,projectId,'task',task.id,new File(['x'],'disk.txt'),1,randomUUID())).rejects.toThrow('disk full');}finally{failure.mockRestore();}
  expect((await resources.getResource(admin,projectId,'task',task.id)).version).toBe(1);expect((await resources.history(admin,projectId,'task',task.id)).items).toHaveLength(1);
 });
 it('previews cleanup then deletes only old unregistered files, preserving historical attachments',async()=>{
  const task=await resources.createTask(admin,projectId,{title:'history attachment'},randomUUID());const file=await upload(admin,projectId,'task',task.id,new File(['keep historical bytes'],'history.txt'),1,randomUUID());
  await resources.lifecycle(admin,projectId,'task',task.id,'delete',2,randomUUID());
  const old=randomUUID(),recent=randomUUID();await writeFile(resolve(folder,old),'orphan');await writeFile(resolve(folder,recent),'recent');await writeFile(resolve(folder,'README.txt'),'leave alone');
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(Date.now()+25*3600000);await utimes(resolve(folder,recent),new Date(),new Date());
  try{
   const preview=await cleanOrphanFiles();expect(preview.removed).toHaveLength(0);expect(preview.orphanFiles).toContain(old);expect(preview.orphanFiles).not.toContain(file.file.id);expect(preview.orphanFiles).not.toContain(recent);
   expect(await readFile(resolve(folder,old),'utf8')).toBe('orphan');const applied=await cleanOrphanFiles({apply:true});expect(applied.removed).toContain(old);expect((await download(admin,file.file.id)).bytes.toString()).toBe('keep historical bytes');expect(await readFile(resolve(folder,'README.txt'),'utf8')).toBe('leave alone');
   await expect(cleanOrphanFiles({olderThanHours:0})).rejects.toThrow('24');
  }finally{vi.useRealTimers();}
 });
 it('rolls back recovery token consumption and session revocation when audit insertion fails',async()=>{
  const recovery=await issueRecovery(admin,member.userId,randomUUID());const value=recoveryToken(recovery.url);const sessionId=randomUUID();await db.execute(sql`INSERT INTO sessions(id,token,user_id,expires_at) VALUES(${sessionId},${randomUUID()},${member.userId},now()+interval '1 day')`);
  const before=await one<{password:string}>(db,sql`SELECT password FROM accounts WHERE user_id=${member.userId}`);const trigger=`test_reset_${randomUUID().replaceAll('-','')}`;
  await db.execute(sql.raw(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.resource_id='${member.userId}' AND NEW.operation='reset_password' THEN RAISE EXCEPTION 'injected audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER ${trigger} BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION ${trigger}()`));
  try{await expect(resetPassword(value,'Should-not-commit-password')).rejects.toThrow();}finally{await db.execute(sql.raw(`DROP TRIGGER ${trigger} ON audit_events; DROP FUNCTION ${trigger}()`));}
  expect((await one<{password:string}>(db,sql`SELECT password FROM accounts WHERE user_id=${member.userId}`))?.password).toBe(before?.password);expect(await one(db,sql`SELECT id FROM sessions WHERE id=${sessionId}`)).toBeTruthy();expect(await one(db,sql`SELECT id FROM recovery_tokens WHERE id=${recovery.id} AND consumed_at IS NULL`)).toBeTruthy();
 });
 it('makes cleanup wait for an in-flight upload until its metadata is committed',async()=>{
  const task=await resources.createTask(admin,projectId,{title:'maintenance concurrency'},randomUUID());let release!:()=>void;let entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});const gate=new Promise<void>(resolve=>{release=resolve;});const original=storageIO.writeFile;
  const writer=vi.spyOn(storageIO,'writeFile').mockImplementationOnce(async(...args)=>{await original(...args);entered();await gate;});
  const uploading=upload(admin,projectId,'task',task.id,new File(['in flight'],'race.txt'),1,randomUUID());await ready;const cleanup=cleanOrphanFiles();
  try{await vi.waitFor(async()=>{expect(await one(db,sql`SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=591339 AND mode='ExclusiveLock' AND NOT granted`)).toBeTruthy();});}
  finally{release();writer.mockRestore();}
  const [file,report]=await Promise.all([uploading,cleanup]);expect(report.orphanFiles).not.toContain(file.file.id);expect((await download(admin,file.file.id)).bytes.toString()).toBe('in flight');
 });

});
