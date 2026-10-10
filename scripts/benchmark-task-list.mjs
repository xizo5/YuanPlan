import 'dotenv/config';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {deepStrictEqual} from 'node:assert';
const url=process.env.TEST_DATABASE_URL;
if(!url||!new URL(url).pathname.endsWith('_test'))throw new Error('A separate *_test database is required');
const client=new pg.Client({connectionString:url});
// Matches the first board page in listTasks; compare only the child-count predicates.
function query(scoped){const scope=scoped?'c.project_id=t.project_id AND ':'';return `SELECT t.*,
 (SELECT count(*)::int FROM tasks c WHERE ${scope}c.parent_id=t.id AND c.deleted_at IS NULL) child_count,
 (SELECT count(*)::int FROM tasks c WHERE ${scope}c.parent_id=t.id AND c.deleted_at IS NULL AND c.status='done') child_done
 FROM tasks t WHERE t.project_id=$1 AND t.deleted_at IS NULL AND t.archived_at IS NULL AND t.status='todo' AND t.parent_id IS NULL
 ORDER BY t.position,t.created_at,t.id LIMIT 31 OFFSET 0`;}
function summarize(values){const sorted=[...values].sort((a,b)=>a-b);return {samples:values.length,p50Ms:+sorted[Math.ceil(sorted.length*.5)-1].toFixed(3),p95Ms:+sorted[Math.ceil(sorted.length*.95)-1].toFixed(3)};}
await client.connect();
try{
 await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='30s'");
 const user=randomUUID(),project=randomUUID();
 await client.query("INSERT INTO users(id,name,email,identity_source) VALUES($1,'Performance fixture',$2,'invite')",[user,`${user}@example.test`]);
 await client.query("INSERT INTO projects(id,name,creator_id) VALUES($1,'Rollback-only performance fixture',$2)",[project,user]);
 await client.query(`INSERT INTO tasks(id,project_id,number,title,description,creator_id,position)
 SELECT gen_random_uuid(),$1,n,'Task '||n,'{"type":"doc","content":[{"type":"paragraph"}]}'::jsonb,$2,n*1024 FROM generate_series(1,4000) n`,[project,user]);
 await client.query(`INSERT INTO tasks(id,project_id,number,title,description,creator_id,parent_id,position,status)
 SELECT gen_random_uuid(),$1,4000+n,'Child '||n,'{"type":"doc","content":[{"type":"paragraph"}]}'::jsonb,$2,t.id,n*1024,CASE WHEN n%2=0 THEN 'done' ELSE 'todo' END
 FROM generate_series(1,16000) n JOIN tasks t ON t.project_id=$1 AND t.number=1+((n-1)%4000)`,[project,user]);
 const old=query(false),next=query(true);deepStrictEqual((await client.query(old,[project])).rows,(await client.query(next,[project])).rows);
 const before=[],after=[];for(let i=0;i<33;i++){for(const [statement,times] of (i%2?[[next,after],[old,before]]:[[old,before],[next,after]])){const started=performance.now();await client.query(statement,[project]);if(i>=3)times.push(performance.now()-started);}}
 const plans={};for(const [name,statement] of [['before',old],['after',next]]){const r=await client.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${statement}`,[project]);const plan=r.rows[0]['QUERY PLAN'][0];plans[name]={executionMs:plan['Execution Time'],sharedHitBlocks:plan.Plan['Shared Hit Blocks'],sharedReadBlocks:plan.Plan['Shared Read Blocks']};}
 console.log(JSON.stringify({database:(await client.query('SHOW server_version')).rows[0].server_version,fixture:{tasks:20000,roots:4000,children:16000,pageSize:31},scope:'single-connection warm SQL query; excludes HTTP/auth/concurrency; fixture rolled back',before:summarize(before),after:summarize(after),plans},null,2));
}finally{await client.query('ROLLBACK');await client.end();}
