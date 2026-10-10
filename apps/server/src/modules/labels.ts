import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Task } from '@yuanplan/contracts';
import { rows, one } from '../db/index.js';
import { read, mutate, audit, checkVersion, type Actor, type Context } from './core.js';
import { assert } from '../lib/errors.js';
type Label={id:string;projectId:string;name:string;version:number;deletedAt:string|null};
const nameSchema=z.string().trim().min(1).max(40);
export async function listLabels(actor:Actor,projectId:string){return read(actor,projectId,tx=>rows<Label>(tx,sql`SELECT * FROM project_labels WHERE project_id=${projectId} AND deleted_at IS NULL ORDER BY name,id`));}
// Called inside the same project transaction as task saves, preserving the string-based MCP contract.
export async function ensureLabels(ctx:Context,names:string[]){
 for(const name of new Set(names)){
  const existing=await one<Label>(ctx.tx,sql`SELECT * FROM project_labels WHERE project_id=${ctx.projectId} AND name=${name}`);
  assert(!existing?.deletedAt,409,'LABEL_DELETED','标签已删除，请刷新并重新选择');
  if(!existing){const label={id:randomUUID(),name,version:1};await ctx.tx.execute(sql`INSERT INTO project_labels(id,project_id,name) VALUES(${label.id},${ctx.projectId},${name})`);await audit(ctx,'label',label.id,'create',null,label);}
 }
}
export async function createLabel(actor:Actor,projectId:string,input:string,op:string){const name=nameSchema.parse(input);return mutate(actor,projectId,'write',op,{action:'create_label',name},async ctx=>{await ensureLabels(ctx,[name]);return (await one<Label>(ctx.tx,sql`SELECT * FROM project_labels WHERE project_id=${projectId} AND name=${name}`))!;});}
export async function changeLabel(actor:Actor,projectId:string,id:string,name:string|null,version:number,op:string){
 if(name!==null)name=nameSchema.parse(name);
 return mutate(actor,projectId,name===null?'admin':'write',op,{action:'change_label',id,name,version},async ctx=>{
  const before=await one<Label>(ctx.tx,sql`SELECT * FROM project_labels WHERE id=${id} AND project_id=${projectId} AND deleted_at IS NULL`);checkVersion(before,version);
  if(name!==null&&name!==before!.name)assert(!await one(ctx.tx,sql`SELECT id FROM project_labels WHERE project_id=${projectId} AND name=${name}`),409,'LABEL_EXISTS','此标签名称已存在或已停用，请使用其他名称');
  const affected=name===before!.name?[]:await rows<Task>(ctx.tx,sql`SELECT * FROM tasks WHERE project_id=${projectId} AND labels @> ${JSON.stringify([before!.name])}::jsonb ORDER BY id`);
  for(const task of affected){const labels=task.labels.flatMap(value=>value===before!.name?(name===null?[]:[name]):[value]);const after=(await one<Task>(ctx.tx,sql`UPDATE tasks SET labels=${JSON.stringify([...new Set(labels)])}::jsonb,version=version+1,updated_at=now() WHERE id=${task.id} RETURNING *`))!;await audit(ctx,'task',task.id,name===null?'label_deleted':'label_renamed',task,after,true);}
  const after=(await one<Label>(ctx.tx,sql`UPDATE project_labels SET name=${name??before!.name},deleted_at=${name===null?new Date():null},version=version+1 WHERE id=${id} RETURNING *`))!;await audit(ctx,'label',id,name===null?'delete':'rename',before!,after);return {...after,affectedTasks:affected.length};
 });
}
