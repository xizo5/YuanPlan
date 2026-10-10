import { parseArgs } from 'node:util';
import { pool } from './db/index.js';
import { issueHostRecovery } from './modules/recovery.js';
import { cleanOrphanFiles } from './modules/file-maintenance.js';
import { backup, restore, maintenance } from './modules/backup.js';
import { config } from './config.js';

const help=`YuanPlan 主机运维命令
  recover --email <实例管理员邮箱> --reason <恢复原因>
  files-clean [--older-than-hours 24] [--apply]
  maintenance --state <on|off>
  backup --output <新备份目录>
  restore --input <备份目录>

recover 只签发已有、未停用实例管理员的 30 分钟一次性链接，不修改角色或直接设置密码。
链接是敏感凭据，请仅交给账号本人，不写入工单、共享日志或聊天。
files-clean 默认只预览；--apply 只删除超过保留期且数据库未登记的普通文件。
所有路径来自本实例 UPLOAD_DIR，不递归处理目录或符号链接。
backup 要求先开启维护模式；完成或失败后维护模式保持开启，由操作者明确关闭。
restore 使用 RESTORE_DATABASE_URL，只允许空数据库与空 UPLOAD_DIR；AUTH_SECRET 必须与源实例相同。
备份不包含配置密钥，请单独保管。`;

try{
 const {values,positionals}=parseArgs({allowPositionals:true,options:{email:{type:'string'},reason:{type:'string'},'older-than-hours':{type:'string'},apply:{type:'boolean'},state:{type:'string'},output:{type:'string'},input:{type:'string'},help:{type:'boolean'}}});
 const command=positionals[0];
 const allowed:Record<string,string[]>={recover:['email','reason'],'files-clean':['older-than-hours','apply'],maintenance:['state'],backup:['output'],restore:['input']};
 if(command&&!values.help&&Object.keys(values).some(key=>!(allowed[command]??[]).includes(key)))throw new Error('该命令包含不适用的参数');
 const databaseUrl=process.env.MAINTENANCE_DATABASE_URL??process.env.MIGRATION_DATABASE_URL??config.DATABASE_URL;
 if(values.help||!command){console.log(help);}
 else if(command==='recover'&&positionals.length===1){
  if(!values.email||!values.reason||values.apply||values['older-than-hours'])throw new Error('recover 需要 --email 和 --reason');
  const result=await issueHostRecovery(values.email,values.reason);console.log(`一次性恢复链接（30 分钟内有效）：\n${result.url}`);
 }else if(command==='files-clean'&&positionals.length===1){
  if(values.email||values.reason)throw new Error('files-clean 不接受账号参数');
  console.log(JSON.stringify(await cleanOrphanFiles({apply:values.apply,olderThanHours:values['older-than-hours']?Number(values['older-than-hours']):24}),null,2));
 }else if(command==='maintenance'&&positionals.length===1&&['on','off'].includes(values.state??'')){
  console.log(JSON.stringify(await maintenance({databaseUrl,enabled:values.state==='on'}),null,2));
 }else if(command==='backup'&&positionals.length===1&&values.output){
  console.log(JSON.stringify(await backup({databaseUrl,uploadDir:config.UPLOAD_DIR,authSecret:config.AUTH_SECRET,output:values.output}),null,2));
 }else if(command==='restore'&&positionals.length===1&&values.input){
  if(!process.env.RESTORE_DATABASE_URL)throw new Error('restore 必须设置 RESTORE_DATABASE_URL');
  console.log(JSON.stringify(await restore({databaseUrl:process.env.RESTORE_DATABASE_URL,uploadDir:config.UPLOAD_DIR,authSecret:config.AUTH_SECRET,input:values.input}),null,2));
 }else throw new Error('未知命令或缺少必填参数，请使用 --help');
}catch(error){
 // Driver errors may embed connection details; do not dump stacks or query parameters.
 console.error(error instanceof Error&&!(error as any).cause?error.message:'运维操作失败，请检查数据库与文件系统状态');process.exitCode=1;
}finally{await pool.end();}
