import { randomUUID } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import type { User } from '@yuanplan/contracts';
import { db, one } from '../db/index.js';
import { config } from '../config.js';
import { token, digest } from '../lib/crypto.js';
import { assert } from '../lib/errors.js';
import { audit } from './core.js';
import { sendMail } from './accounts.js';
const systemId='system:account-recovery';
const emailSchema=z.email().transform(v=>v.trim().toLowerCase());
const generic={ok:true,message:'如果该邮箱对应可恢复账号，恢复邮件将会发送。请查收邮箱，或联系实例管理员。'};

async function issue(email:string,mode:'email'|'host',reason?:string){
 const value=token();
 const result=await db.transaction(async tx=>{
  const target=await one<User & {emailVerified:boolean}>(tx,sql`SELECT * FROM users WHERE email=${email} AND NOT disabled FOR UPDATE`);
  if(!target){if(mode==='host')assert(false,404,'NOT_FOUND','未找到可用账号');return null;}
  if(mode==='host')assert(target.isAdmin,403,'NOT_INSTANCE_ADMIN','主机紧急恢复仅面向已有实例管理员');
  if(mode==='email' && !target.emailVerified)return null;
  if(mode==='email'){
   const recent=await one(tx,sql`SELECT id FROM recovery_tokens WHERE user_id=${target.id} AND created_at>now()-interval '5 minutes' LIMIT 1`);
   if(recent)return null;
  }
  const system=await one<User>(tx,sql`SELECT * FROM users WHERE id=${systemId}`);assert(system,503,'MIGRATION_REQUIRED','请先完成数据库迁移');
  const id=randomUUID();
  await tx.execute(sql`UPDATE recovery_tokens SET consumed_at=now() WHERE user_id=${target.id} AND consumed_at IS NULL`);
  await tx.execute(sql`INSERT INTO recovery_tokens(id,user_id,token_hash,expires_at) VALUES(${id},${target.id},${digest(value)},now()+interval '30 minutes')`);
  await audit({tx,actor:{userId:systemId,source:'system'},user:system,projectId:null,operationId:randomUUID()},'user',target.id,mode==='host'?'host_recovery_issued':'email_recovery_requested',null,{recoveryId:id,...(mode==='host'?{operator:userInfo().username,host:hostname(),reason}:{delivery:'email'})});
  return {id,email:target.email};
 });
 return result?{...result,url:`${config.APP_URL}/recover?token=${value}`}:null;
}
export async function requestEmailRecovery(input:unknown){
 const email=emailSchema.parse(input);
 if(!config.SMTP_HOST||!config.SMTP_FROM)return generic;
 const issued=await issue(email,'email');
 if(issued){
  try{await sendMail(issued.email,'重置 YuanPlan 密码',issued.url);}
  catch{
   // Do not expose SMTP diagnostics or account existence through the public endpoint.
   await db.execute(sql`UPDATE recovery_tokens SET consumed_at=now() WHERE id=${issued.id} AND consumed_at IS NULL`);
   console.error(JSON.stringify({event:'recovery_mail_failed',recoveryId:issued.id}));
  }
 }
 return generic;
}
// Host-only service. There is deliberately no HTTP route to this function.
export async function issueHostRecovery(email:string,reason:string){
 return (await issue(emailSchema.parse(email),'host',z.string().trim().min(5).max(500).parse(reason)))!;
}
