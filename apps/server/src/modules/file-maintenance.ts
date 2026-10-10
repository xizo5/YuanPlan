import { opendir, lstat, realpath, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { sql } from 'drizzle-orm';
import { db, one } from '../db/index.js';
import { config } from '../config.js';
import { FILE_MAINTENANCE_LOCK } from './files.js';

type Options={apply?:boolean;olderThanHours?:number};
export async function cleanOrphanFiles({apply=false,olderThanHours=24}:Options={}){
 if(!Number.isFinite(olderThanHours)||olderThanHours<24)throw new Error('孤立文件保留期至少为 24 小时');
 const root=await realpath(resolve(config.UPLOAD_DIR));
 const report={mode:apply?'apply':'preview',root,scanned:0,registered:0,recent:0,skipped:0,orphanFiles:[] as string[],removed:[] as string[]};
 return db.transaction(async tx=>{
  // Upload holds the shared form of this transaction lock until metadata commits.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${FILE_MAINTENANCE_LOCK})`);
  const directory=await opendir(root);const cutoff=Date.now()-olderThanHours*3600000;
  for await(const entry of directory){
   report.scanned++;
   if(!entry.isFile()||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry.name)){report.skipped++;continue;}
   const path=resolve(root,entry.name);if(dirname(path)!==root)throw new Error('附件路径超出存储目录');
   const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()){report.skipped++;continue;}
   // Preserve every registered object, including deleted resources and all history.
   if(await one(tx,sql`SELECT id FROM files WHERE storage_key=${entry.name}`)){report.registered++;continue;}
   if(stat.mtimeMs>cutoff||stat.ctimeMs>cutoff){report.recent++;continue;}
   report.orphanFiles.push(entry.name);
   if(apply){
    const current=await lstat(path);
    if(!current.isFile()||current.isSymbolicLink()||current.ino!==stat.ino||current.mtimeMs!==stat.mtimeMs||current.size!==stat.size){report.skipped++;continue;}
    await unlink(path);report.removed.push(entry.name);
   }
  }
  return report;
 });
}
