import { lazy, Suspense, useContext, useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, Group, Modal, Select, Stack, Text, TextInput, Title, SimpleGrid } from '@mantine/core';
import type { AuditEvent, Document, Page, Project } from '@yuanplan/contracts';
import { api, ApiError, errorText, useData, confirmNavigation, registerDirty, navigate } from './api';
import { Empty, Failure, Loading, time } from './ui';
import { LifecycleActions } from './Lifecycle';
import { UserContext, draftKey, readDraft, type DocumentDraft } from './drafts';
const Editor=lazy(()=>import('./Editor'));
const blank={type:'doc',content:[{type:'paragraph'}]};
export function Wiki({project}:{project:Project}) {
  const [startEditing,setStartEditing]=useState(false);
  const [editorRevision,setEditorRevision]=useState(0);const [query,setQuery]=useState('');const [cursor,setCursor]=useState<string|null>(null);const [extra,setExtra]=useState<Document[]>([]);
  const q=useData<Page<Document>>(`/projects/${project.id}/documents?query=${encodeURIComponent(query)}`);
  const [selected,setSelected]=useState<string|null>(new URLSearchParams(location.search).get('document'));const [name,setName]=useState('');const [parent,setParent]=useState<string|null>(null);const [create,setCreate]=useState(false);const [error,setError]=useState('');const [busy,setBusy]=useState(false);const canEdit=project.role!=='viewer'&&!project.archivedAt;
  const docs=[...(q.data?.items??[]),...extra];const next=cursor===null?q.data?.nextCursor:cursor||null;
  function reload(){setExtra([]);setCursor(null);q.reload();}
  function open(id:string,edit=false){if(confirmNavigation()){setStartEditing(edit);if(id===selected)setEditorRevision(v=>v+1);setSelected(id);history.replaceState(null,'',`/projects/${project.id}?document=${id}`);}}
  async function move(d:Document,neighbor:Document,direction:'up'|'down'){
    if(!confirmNavigation())return;setBusy(true);setError('');
    try{await api(`/projects/${project.id}/documents/${d.id}/move`,{body:{direction,expectedVersion:d.version,neighborId:neighbor.id,neighborVersion:neighbor.version}});reload();if(selected===d.id)setEditorRevision(v=>v+1);}catch(e){setError(errorText(e));reload();}finally{setBusy(false);}
  }
  function tree(parentId:string|null,depth=0):React.ReactNode {
    const siblings=docs.filter(d=>d.parentId===parentId||(!parentId&&d.parentId&&!docs.some(p=>p.id===d.parentId)));
    return siblings.map((d,index)=><div key={d.id}><Group gap={0} wrap="nowrap" style={{paddingLeft:depth*14}}><Button style={{flex:1,minWidth:0}} justify="start" variant={selected===d.id?'light':'subtle'} color={selected===d.id?'forest':'gray'} onClick={()=>open(d.id)}>{d.title}</Button>{canEdit&&!query&&<Group gap={0} wrap="nowrap">{index>0&&siblings[index-1].parentId===d.parentId&&<Button size="compact-xs" variant="subtle" disabled={busy} aria-label={`上移文档 ${d.title}`} onClick={()=>void move(d,siblings[index-1],'up')}>↑</Button>}{index<siblings.length-1&&siblings[index+1].parentId===d.parentId&&<Button size="compact-xs" variant="subtle" disabled={busy} aria-label={`下移文档 ${d.title}`} onClick={()=>void move(d,siblings[index+1],'down')}>↓</Button>}</Group>}</Group>{depth<5&&tree(d.id,depth+1)}</div>);
  }

  return <><Failure error={error||q.error}/><div className="wiki-layout"><aside className="wiki-tree"><Group justify="space-between" mb="md"><Text fw={600} size="sm">项目文档</Text>{canEdit&&<Button size="compact-xs" variant="subtle" onClick={()=>setCreate(true)}>新建</Button>}</Group><TextInput aria-label="搜索文档" placeholder="搜索文档…" mb="sm" value={query} onChange={e=>{setQuery(e.currentTarget.value);setExtra([]);setCursor(null);}}/>{q.loading?<Loading/>:tree(null)}{!q.loading&&!docs.length&&<Text size="sm" c="dimmed">没有符合条件的文档</Text>}{next&&<Button loading={busy} variant="subtle" onClick={async()=>{setBusy(true);try{const p=await api<Page<Document>>(`/projects/${project.id}/documents?query=${encodeURIComponent(query)}&cursor=${next}`);setExtra(v=>[...v,...p.items]);setCursor(p.nextCursor??'');}catch(e){setError(errorText(e));}finally{setBusy(false);}}}>加载更多文档</Button>}</aside><div className="wiki-content">{selected?<DocumentLoader key={`${selected}-${editorRevision}`} id={selected} startEditing={startEditing} project={project} docs={docs} updated={reload}/>:<Empty title="选择文档" detail="从左侧打开或新建文档。"/>}</div></div><Modal opened={create} onClose={()=>setCreate(false)} title="新建项目文档"><form onSubmit={async e=>{e.preventDefault();setBusy(true);try{const d=await api<Document>(`/projects/${project.id}/documents`,{body:{title:name,parentId:parent,content:blank}});open(d.id,true);setCreate(false);setName('');reload();}catch(e){setError(errorText(e));}finally{setBusy(false);}}}><Stack><TextInput required label="文档标题" value={name} onChange={e=>setName(e.currentTarget.value)}/><Select label="上级文档" clearable searchable value={parent} onChange={setParent} data={docs.map(d=>({value:d.id,label:d.title}))}/><Button type="submit" loading={busy}>创建文档</Button></Stack></form></Modal></>;
}
function DocumentLoader({id,project,docs,updated,startEditing}:{id:string;startEditing:boolean;project:Project;docs:Document[];updated:()=>void}) {const q=useData<Document>(`/projects/${project.id}/documents/${id}`);return q.loading?<Loading/>:q.data?<DocumentEditor initial={q.data} startEditing={startEditing} project={project} docs={docs} updated={updated}/>:<Failure error={q.error}/>;}
const values=(d:Document)=>({title:d.title,content:d.content,parentId:d.parentId});
function DocumentEditor({initial,project,docs,updated,startEditing}:{initial:Document;startEditing:boolean;project:Project;docs:Document[];updated:()=>void}) {
  const [editMode,setEditMode]=useState(startEditing);const [finishing,setFinishing]=useState(false);
  const user=useContext(UserContext);const key=draftKey(user,project.id,initial.id);
  const [draft,setDraft]=useState(initial);const latest=useRef(initial);const [version,setVersion]=useState(initial.version);const currentVersion=useRef(initial.version);const saved=useRef(JSON.stringify(values(initial)));
  const [state,setState]=useState('已保存');const [error,setError]=useState('');const [storageError,setStorageError]=useState('');const blocked=useRef(false);const validationError=useRef(false);const pending=useRef(false);const composing=useRef(false);const mounted=useRef(true);
  const [busy,setBusy]=useState(false);const [uploading,setUploading]=useState(false);const [history,setHistory]=useState(false);const [recovered,setRecovered]=useState(()=>readDraft(key));const recoveryPending=useRef(!!recovered);const [remote,setRemote]=useState<Document|null>(null);
  const retry=useRef<DocumentDraft['attempt']>(null);const base=`/projects/${project.id}/documents/${initial.id}`;const canEdit=project.role!=='viewer'&&!project.archivedAt;
  const editing=editMode&&canEdit;
  const links=useData<{id:string;title:string}[]>(`${base}/tasks`);
  function persist(){try{localStorage.setItem(key,JSON.stringify({schema:1,version:currentVersion.current,data:values(latest.current),attempt:retry.current}));setStorageError('');}catch{setStorageError('浏览器无法保存本地草稿，请保留当前页面并复制重要内容。');}}
  function clear(){try{localStorage.removeItem(key);}catch{setStorageError('无法清理本地草稿。');}}
  useEffect(()=>registerDirty(()=>JSON.stringify(values(latest.current))!==saved.current||pending.current),[]);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  function edit(patch:Partial<Document>){const next={...latest.current,...patch};latest.current=next;setDraft(next);if(validationError.current){validationError.current=false;blocked.current=false;setError('');}setState('尚未保存');persist();}
  async function save(manual=false):Promise<boolean>{
    if(pending.current||!editing||composing.current||recoveryPending.current||remote||(blocked.current&&!manual))return false;
    const data=values(latest.current);const encoded=JSON.stringify(data);if(encoded===saved.current&&!retry.current)return true;
    if(!data.title.trim()){if(manual){validationError.current=true;setError('请输入标题');}setState('尚未保存');return false;}
    // A draft saved by an older client may still contain a rejected empty-title attempt.
    if(retry.current&&!String(retry.current.body?.data?.title??'').trim())retry.current=null;
    pending.current=true;setBusy(true);setState('正在保存…');setError('');
    const attempt=retry.current??{operationId:crypto.randomUUID(),body:{data,expectedVersion:currentVersion.current},encoded};retry.current=attempt;persist();
    try{const result=await api<Document>(base,{method:'PUT',body:attempt.body,operationId:attempt.operationId});currentVersion.current=result.version;saved.current=attempt.encoded;retry.current=null;blocked.current=false;
      if(mounted.current){setVersion(result.version);const clean=JSON.stringify(values(latest.current))===saved.current;setState(clean?'已保存':'尚未保存');if(clean)clear();else persist();updated();}return true;
    }catch(e){const invalidInput=e instanceof ApiError&&e.code==='INVALID_INPUT';if(invalidInput){retry.current=null;validationError.current=true;}blocked.current=!invalidInput||JSON.stringify(values(latest.current))===attempt.encoded;if(mounted.current){if(invalidInput&&!blocked.current){validationError.current=false;setError('');setState('尚未保存');}else{setError(errorText(e));setState('保存失败');}persist();if(e instanceof ApiError&&e.code==='VERSION_CONFLICT'){try{setRemote(await api<Document>(base));}catch(loadError){setError(errorText(loadError));}}}return false;
    }finally{pending.current=false;if(mounted.current)setBusy(false);}
  }
  async function finishEditing(){
    setFinishing(true);
    try {
      if(!(await save(true)))return;
      if(JSON.stringify(values(latest.current))!==saved.current&&!(await save(true)))return;
      if(mounted.current)setEditMode(false);
    }finally{if(mounted.current)setFinishing(false);}
  }
  const saveRef=useRef(save);saveRef.current=save;
  useEffect(()=>{const timer=window.setInterval(()=>void saveRef.current(),2000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{const prevent=(e:BeforeUnloadEvent)=>{if(JSON.stringify(values(latest.current))!==saved.current||pending.current){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',prevent);return()=>window.removeEventListener('beforeunload',prevent);},[]);
  function accept(d:Document){latest.current=d;setDraft(d);currentVersion.current=d.version;setVersion(d.version);saved.current=JSON.stringify(values(d));retry.current=null;blocked.current=false;validationError.current=false;setError('');setState('已保存');clear();}
  async function upload(file:File){
    if(pending.current||remote||recoveryPending.current)throw new Error('请先处理保存或版本冲突');
    setUploading(true);
    try{
      if(!(await save()))throw new Error('请先成功保存文档');
      if(JSON.stringify(values(latest.current))!==saved.current&&!(await save()))throw new Error('请先保存最新修改');
      pending.current=true;setBusy(true);
      const form=new FormData();form.set('file',file);form.set('expectedVersion',String(currentVersion.current));
      const result=await api<{file:{url:string;mimeType:string};resource:Document}>(`${base}/files`,{body:form});accept(result.resource);updated();
      if(!result.file.mimeType.startsWith('image/'))throw new Error('请选择 PNG、JPEG 或 WebP 图片');return result.file.url;
    }finally{pending.current=false;setBusy(false);setUploading(false);}
  }

  return <Stack><Group justify="space-between"><Group gap="xs">{editing&&<Badge variant="light" color={error?'red':'gray'}>{state}</Badge>}<Text size="xs" c="dimmed">版本 {version}</Text></Group><Group><Button variant="subtle" size="xs" onClick={()=>setHistory(true)}>版本记录</Button>{canEdit&&(editing?<><Button size="xs" variant="light" loading={busy&&!finishing} disabled={finishing||!!remote||!!recovered||uploading} onClick={()=>void save(true)}>保存</Button><Button size="xs" loading={finishing} disabled={busy||!!remote||!!recovered||uploading} onClick={()=>void finishEditing()}>完成编辑</Button></>:<Button size="xs" disabled={!!recovered} onClick={()=>setEditMode(true)}>编辑</Button>)}</Group></Group><Failure error={error||storageError}/>
    {recovered&&<Alert color="yellow" title="发现此账号的本地草稿"><Text size="sm">草稿基于版本 {recovered.version}，服务器当前版本 {initial.version}。选择后才会继续保存。</Text><Group mt="sm"><Button disabled={!canEdit} onClick={()=>{setEditMode(true);currentVersion.current=recovered.version;retry.current=recovered.attempt;latest.current={...initial,...recovered.data};setDraft(latest.current);recoveryPending.current=false;setRecovered(null);setState('草稿已恢复');persist();if(recovered.version!==initial.version&&!recovered.attempt){blocked.current=true;setRemote(initial);}}}>恢复本地草稿</Button><Button variant="subtle" onClick={()=>{clear();setRecovered(null);recoveryPending.current=false;}}>丢弃本地草稿</Button></Group></Alert>}
    {remote&&<Alert color="yellow" title={`版本冲突：服务器已更新至版本 ${remote.version}`}><SimpleGrid cols={{base:1,md:2}}><div><Text fw={600}>我的内容</Text><Text>{draft.title}</Text><Suspense fallback={<Loading/>}><Editor value={draft.content} readOnly onChange={()=>{}}/></Suspense></div><div><Text fw={600}>服务器内容</Text><Text>{remote.title}</Text><Suspense fallback={<Loading/>}><Editor value={remote.content} readOnly onChange={()=>{}}/></Suspense></div></SimpleGrid><Text size="sm" mt="sm">核对后保留本地内容继续编辑，再点击保存；保存时仍会检查服务器版本。</Text><Group mt="sm"><Button onClick={()=>{currentVersion.current=remote.version;setVersion(remote.version);saved.current=JSON.stringify(values(remote));retry.current=null;blocked.current=true;setRemote(null);setError('');setState('请核对并保存');persist();}}>保留本地内容继续编辑</Button><Button variant="subtle" onClick={()=>{if(window.confirm('放弃本地修改并使用服务器版本？')){accept(remote);setRemote(null);}}}>使用服务器版本</Button></Group></Alert>}
    {editing?<><TextInput size="xl" variant="unstyled" aria-label="文档标题" value={draft.title} readOnly={!!recovered||uploading||finishing} onChange={e=>edit({title:e.currentTarget.value})}/><Select label="上级文档" searchable clearable disabled={!!recovered||uploading||finishing} value={draft.parentId} data={docs.filter(d=>d.id!==initial.id).map(d=>({value:d.id,label:d.title}))} onChange={parentId=>edit({parentId})}/></>:<Title order={2}>{draft.title}</Title>}
    <Suspense fallback={<Loading/>}><Editor value={draft.content} showPreviewToggle={false} readOnly={!editing||!!recovered||uploading||finishing} onChange={v=>edit({content:v})} onCompositionChange={v=>{composing.current=v;}} uploadImage={editing&&!busy&&!remote&&!recovered&&!finishing?upload:undefined}/></Suspense>{editing&&<Text size="xs" c="dimmed">编辑时自动保存；点击“完成编辑”保存并返回阅读。断网时草稿保留在当前浏览器。</Text>}
    {!!links.data?.length&&<><Title order={5}>关联任务</Title>{links.data.map(t=><Button key={t.id} variant="subtle" onClick={()=>navigate(`/projects/${project.id}?task=${t.id}`)}>{t.title}</Button>)}</>}
    <>{editing&&project.role==='admin'&&<LifecycleActions projectId={project.id} kind="document" resource={{...initial,version}} changed={()=>window.location.assign(`/projects/${project.id}?document=`)}/>}</><Modal opened={history} onClose={()=>setHistory(false)} title="文档版本记录" size="xl"><History base={base} restore={editing&&!busy&&!finishing?async v=>{if(!confirmNavigation())return;setBusy(true);pending.current=true;try{const d=await api<Document>(`${base}/restore-version`,{body:{version:v,expectedVersion:currentVersion.current}});accept(d);setHistory(false);updated();}catch(e){setError(errorText(e));}finally{pending.current=false;setBusy(false);}}:undefined}/></Modal></Stack>;
}
export function History({base,restore}:{base:string;restore?:(version:number)=>Promise<void>}) {
 const [cursor,setCursor]=useState<string|null>(null);const [filters,setFilters]=useState({source:'',actor:'',from:'',to:''});const query=new URLSearchParams(Object.entries(filters).filter(([,v])=>v));if(cursor)query.set('cursor',cursor);
 const q=useData<Page<AuditEvent>>(`${base}/history?${query}`);const [snapshot,setSnapshot]=useState<any>();const [previous,setPrevious]=useState<any>();const [error,setError]=useState('');const [busy,setBusy]=useState(false);
 const labels:Record<string,string>={title:'标题',content:'正文',description:'描述',status:'状态',priority:'优先级',assigneeId:'执行人',parentId:'上级',position:'排序',labels:'标签',dueDate:'截止日期',startDate:'开始日期',deletedAt:'删除时间',archivedAt:'归档时间',attachments:'附件'};
 function change(key:string,value:string|null){setFilters(f=>({...f,[key]:value??''}));setCursor(null);}
 return <Stack><SimpleGrid cols={{base:2,md:4}}><Select label="操作来源" clearable value={filters.source||null} onChange={v=>change('source',v)} data={[{value:'web',label:'网页'},{value:'mcp',label:'MCP'},{value:'system',label:'系统'}]}/><TextInput label="操作人" value={filters.actor} onChange={e=>change('actor',e.currentTarget.value)}/><TextInput type="date" label="起始日期（UTC）" value={filters.from} onChange={e=>change('from',e.currentTarget.value)}/><TextInput type="date" label="结束日期（UTC）" value={filters.to} onChange={e=>change('to',e.currentTarget.value)}/></SimpleGrid><Failure error={error||q.error}/>{q.loading?<Loading/>:q.data?.items.map(h=><Card withBorder key={h.id}><Group justify="space-between"><div><Text fw={600} size="sm">{h.actorName} · {h.operation}</Text><Text c="dimmed" size="xs">{time(h.createdAt)} · {h.source} · {h.afterVersion?`版本 ${h.afterVersion}`:'操作记录'}</Text></div>{h.afterVersion&&<Group><Button size="xs" variant="subtle" disabled={busy} onClick={async()=>{setBusy(true);try{const [after,before]=await Promise.all([api(`${base}/versions/${h.afterVersion}`),h.beforeVersion?api(`${base}/versions/${h.beforeVersion}`):Promise.resolve(null)]);setSnapshot(after.snapshot);setPrevious(before?.snapshot??null);}catch(e){setError(errorText(e));}finally{setBusy(false);}}}>比较版本</Button>{restore&&<Button size="xs" variant="light" disabled={busy} onClick={async()=>{setBusy(true);try{await restore(h.afterVersion!);}finally{setBusy(false);}}}>恢复此版本</Button>}</Group>}</Group><details><summary>查看字段变动</summary>{Object.entries(h.changes).map(([field,values])=><div key={field}><Text fw={600} size="sm">{labels[field]??field}</Text><SimpleGrid cols={2}><Text size="sm" style={{overflowWrap:'anywhere'}}>{formatValue(values.before)}</Text><Text size="sm" style={{overflowWrap:'anywhere'}}>{formatValue(values.after)}</Text></SimpleGrid></div>)}</details></Card>)}<Group>{cursor&&<Button variant="subtle" onClick={()=>setCursor(null)}>最新记录</Button>}{q.data?.nextCursor&&<Button variant="subtle" onClick={()=>setCursor(q.data!.nextCursor)}>下一页</Button>}</Group>{snapshot&&<><Title order={5}>版本内容比较</Title><SimpleGrid cols={{base:1,md:2}}>{[previous,snapshot].map((d,i)=><div key={i}><Text fw={600}>{i?'此次保存后':'此次保存前'}{d?` · 版本 ${d.version}`:''}</Text><Text>{d?.title??'尚未创建'}</Text>{d&&(d.content||d.description)&&<Suspense fallback={<Loading/>}><Editor value={d.content??d.description} readOnly onChange={()=>{}}/></Suspense>}</div>)}</SimpleGrid></>}</Stack>;
}
function formatValue(value:unknown):string{if(value===null||value===undefined)return '无';if(typeof value==='object'&&'type' in value)return '富文本内容（点击比较版本查看）';return typeof value==='object'?JSON.stringify(value):String(value);}
