import { useContext, useEffect, useRef, useState } from 'react';
import { ActionIcon, Alert, Badge, Button, Card, Group, Menu, Modal, Pagination, Radio, Select, Stack, Table, Tabs, Text, TextInput, Title } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconDots, IconSearch } from '@tabler/icons-react';
import { api, confirmNavigation, errorText, registerDirty, useData } from './api';
import { UserContext } from './drafts';
import { Failure, Loading } from './ui';

type Settings = { registrationMode:'invite'|'open'|'open_unverified'; emailEnabled:boolean };
type Account = { id:string;name:string;email:string;emailVerified:boolean;identitySource:string;isAdmin:boolean;disabled:boolean;createdAt:string };
export function SystemManagement(){
  const settings=useData<Settings>('/instance/settings');const [tab,setTab]=useState<string|null>('settings');
  if(settings.loading)return <Loading/>;
  if(!settings.data)return <Failure error={settings.error}/>;
  return <Stack><Title order={1}>系统管理</Title><Text size="sm" c="dimmed">管理整个系统的注册方式和账号。仅系统管理员可操作。</Text>
    <Tabs value={tab} onChange={value=>{if(confirmNavigation())setTab(value);}}><Tabs.List><Tabs.Tab value="settings">系统设置</Tabs.Tab><Tabs.Tab value="members">成员管理</Tabs.Tab></Tabs.List></Tabs>
    {tab==='settings'?<RegistrationSettings settings={settings.data} saved={registrationMode=>settings.setData({...settings.data!,registrationMode})}/>:<SystemMembers/>}
  </Stack>;
}
function RegistrationSettings({settings,saved}:{settings:Settings;saved:(mode:Settings['registrationMode'])=>void}){
  const [mode,setMode]=useState(settings.registrationMode);const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [notice,setNotice]=useState('');
  const dirty=useRef(false);dirty.current=busy||mode!==settings.registrationMode;
  useEffect(()=>registerDirty(()=>dirty.current),[]);
  return <Card withBorder maw={680}><form onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');setNotice('');try{await api('/instance/settings',{method:'PUT',body:{registrationMode:mode}});saved(mode);setNotice('系统设置已保存');}catch(e){setError(errorText(e));}finally{setBusy(false);}}}><Stack>
    <Title order={2} size="h4">注册设置</Title><Group><Text size="sm">邮件服务</Text><Badge color={settings.emailEnabled?'forest':'gray'}>{settings.emailEnabled?'已配置':'未配置'}</Badge></Group>
    <Radio.Group label="注册方式" value={mode} onChange={value=>{setMode(value as Settings['registrationMode']);setNotice('');}}><Stack gap="xs" mt="xs"><Radio value="invite" label="仅限邀请" disabled={busy}/><Radio value="open" label="开放注册（邮件验证）" disabled={busy||!settings.emailEnabled}/><Radio value="open_unverified" label="开放注册（无需邮箱验证）" disabled={busy}/></Stack></Radio.Group>
    <Text size="sm" c="dimmed">{mode==='invite'?'用户通过邀请加入系统。':mode==='open'?'用户自行注册，验证邮箱后才能登录。':'用户自行注册后即可登录；邮箱仅作登录标识，未验证归属。'}</Text>
    {!settings.emailEnabled&&<Alert color="gray">未配置邮件服务。可使用无需邮箱验证的开放注册；邮件找回密码不可用，管理员可手工签发重置链接。</Alert>}
    <Failure error={error}/>{notice&&<Text size="sm" c="forest" role="status">{notice}</Text>}<Button type="submit" loading={busy} disabled={mode===settings.registrationMode}>保存设置</Button>
  </Stack></form></Card>;
}
function SystemMembers(){
  const me=useContext(UserContext);const [search,setSearch]=useState('');const [keyword]=useDebouncedValue(search.trim(),250);const [role,setRole]=useState('all');const [status,setStatus]=useState('all');const [page,setPage]=useState(1);const [pageSize,setPageSize]=useState('10');
  const q=useData<{items:Account[];total:number;page:number;pageSize:number}>(`/instance/users?${new URLSearchParams({query:keyword,role,status,page:String(page),pageSize})}`);
  const [selected,setSelected]=useState<{user:Account;action:'recovery'|'toggle'}|null>(null);const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [url,setUrl]=useState('');const [copied,setCopied]=useState(false);
  const [creating,setCreating]=useState(false);const [newName,setNewName]=useState('');const [newEmail,setNewEmail]=useState('');const [createdUrl,setCreatedUrl]=useState('');const [createError,setCreateError]=useState('');const [createBusy,setCreateBusy]=useState(false);const [createdCopied,setCreatedCopied]=useState(false);
  function closeCreate(){if(createBusy)return;setCreating(false);setNewName('');setNewEmail('');setCreatedUrl('');setCreateError('');setCreatedCopied(false);}
  function open(user:Account,action:'recovery'|'toggle'){setSelected({user,action});setError('');setUrl('');setCopied(false);}
  async function perform(){if(!selected)return;setBusy(true);setError('');try{
    if(selected.action==='recovery')setUrl((await api<{url:string}>(`/instance/users/${selected.user.id}/recovery`,{body:{}})).url);
    else{await api(`/instance/users/${selected.user.id}/disabled`,{body:{disabled:!selected.user.disabled}});setSelected(null);q.reload();}
  }catch(e){setError(errorText(e));}finally{setBusy(false);}}
  const actionTitle=selected?.action==='recovery'?'重置密码':selected?.user.disabled?'启用账号':'停用账号';
  return <Stack><Text size="sm" c="dimmed">管理全系统账号；项目成员及项目角色请在具体项目中设置。</Text>
    <Group gap="xs"><TextInput aria-label="搜索成员" placeholder="搜索姓名或邮箱…" maxLength={200} value={search} onChange={e=>{setSearch(e.currentTarget.value);setPage(1);}} leftSection={<IconSearch size={15}/>} style={{flex:'1 1 220px',maxWidth:360}}/>{search&&<Button variant="subtle" size="xs" onClick={()=>{setSearch('');setPage(1);}}>清空搜索</Button>}
      <Select aria-label="系统角色" w={160} allowDeselect={false} value={role} onChange={value=>{setRole(value??'all');setPage(1);}} data={[{value:'all',label:'全部角色'},{value:'admin',label:'系统管理员'},{value:'user',label:'普通用户'}]}/>
      <Select aria-label="账号状态" w={140} allowDeselect={false} value={status} onChange={value=>{setStatus(value??'all');setPage(1);}} data={[{value:'all',label:'全部状态'},{value:'active',label:'正常'},{value:'disabled',label:'已停用'}]}/>
      <Button onClick={()=>setCreating(true)}>添加用户</Button>
    </Group><Failure error={q.error}/>{q.loading?<Loading/>:q.data&&<>
      <Table.ScrollContainer minWidth={760}><Table verticalSpacing="sm" highlightOnHover withTableBorder><Table.Thead><Table.Tr><Table.Th>姓名</Table.Th><Table.Th>邮箱</Table.Th><Table.Th>系统角色</Table.Th><Table.Th>账号状态</Table.Th><Table.Th>注册时间</Table.Th><Table.Th>操作</Table.Th></Table.Tr></Table.Thead><Table.Tbody>
        {q.data.items.map(user=><Table.Tr key={user.id}><Table.Td><Group gap="xs"><Text size="sm">{user.name}</Text>{user.id===me&&<Badge size="xs" variant="light">我</Badge>}</Group></Table.Td><Table.Td><Stack gap={2}><Text size="sm">{user.email}</Text>{user.emailVerified?<Badge size="xs" variant="light" color="forest" w="fit-content">已验证</Badge>:<Badge size="xs" variant="light" color="gray" w="fit-content">未验证</Badge>}</Stack></Table.Td><Table.Td>{user.isAdmin?'系统管理员':'普通用户'}</Table.Td><Table.Td><Badge color={user.disabled?'gray':'forest'} variant="light">{user.disabled?'已停用':'正常'}</Badge></Table.Td><Table.Td>{new Date(user.createdAt).toLocaleDateString('zh-CN')}</Table.Td><Table.Td>
          <Menu position="bottom-end" withinPortal><Menu.Target><ActionIcon variant="subtle" color="gray" aria-label={`账号操作 ${user.name}`}><IconDots size={18}/></ActionIcon></Menu.Target><Menu.Dropdown><Menu.Item disabled={user.disabled} onClick={()=>open(user,'recovery')}>重置密码</Menu.Item><Menu.Item color={user.disabled?undefined:'red'} disabled={user.id===me} title={user.id===me?'不能停用当前登录账号':undefined} onClick={()=>open(user,'toggle')}>{user.disabled?'启用账号':'停用账号'}</Menu.Item></Menu.Dropdown></Menu>
        </Table.Td></Table.Tr>)}
        {!q.data.items.length&&<Table.Tr><Table.Td colSpan={6}><Text ta="center" c="dimmed" py="lg">没有符合条件的成员，请调整搜索或筛选条件。</Text></Table.Td></Table.Tr>}
      </Table.Tbody></Table></Table.ScrollContainer>
      <Group justify="space-between"><Text size="sm" c="dimmed" role="status">共 {q.data.total} 名成员</Text><Group><Select w={110} aria-label="每页成员数" allowDeselect={false} value={pageSize} onChange={value=>{setPageSize(value??'10');setPage(1);}} data={['10','20','50'].map(value=>({value,label:`${value} 条/页`}))}/>{q.data.total>0&&<Pagination size="sm" siblings={0} total={Math.ceil(q.data.total/q.data.pageSize)} value={q.data.page} onChange={setPage} getItemProps={value=>({'aria-label':`第 ${value} 页`})} getControlProps={control=>({'aria-label':({first:'首页',previous:'上一页',next:'下一页',last:'末页'})[control]})}/>}</Group></Group>
    </>}
    <Modal opened={creating} onClose={closeCreate} closeOnEscape={!createBusy} closeOnClickOutside={!createBusy} withCloseButton={!createBusy} title="添加用户"><form onSubmit={async e=>{e.preventDefault();if(createdUrl)return;setCreateBusy(true);setCreateError('');try{const result=await api<{url:string}>('/instance/users',{body:{name:newName,email:newEmail}});setCreatedUrl(result.url);q.reload();}catch(error){setCreateError(errorText(error));}finally{setCreateBusy(false);}}}><Stack>
      {createdUrl?<><Text size="sm">账号已创建。请通过受控渠道将一次性设置密码链接交给用户；链接 30 分钟内有效。</Text><TextInput label="设置密码链接" readOnly value={createdUrl} onFocus={e=>e.currentTarget.select()}/><Button type="button" variant="light" onClick={async()=>{try{await navigator.clipboard.writeText(createdUrl);setCreatedCopied(true);}catch{setCreateError('复制失败，请手动选择并复制链接');}}}>{createdCopied?'已复制':'复制链接'}</Button></>:<><Text size="sm" c="dimmed">创建普通用户，不自动加入项目或团队。邮箱只作为登录标识，不验证归属。</Text><TextInput label="姓名" required maxLength={80} value={newName} onChange={e=>setNewName(e.currentTarget.value)}/><TextInput label="邮箱" type="email" required value={newEmail} onChange={e=>setNewEmail(e.currentTarget.value)}/></>}
      <Failure error={createError}/><Group justify="flex-end"><Button type="button" variant="default" disabled={createBusy} onClick={closeCreate}>{createdUrl?'关闭':'取消'}</Button>{!createdUrl&&<Button type="submit" loading={createBusy}>创建用户</Button>}</Group>
    </Stack></form></Modal>
    <Modal opened={!!selected} onClose={()=>{if(!busy)setSelected(null);}} closeOnEscape={!busy} closeOnClickOutside={!busy} withCloseButton={!busy} title={actionTitle}><Stack>
      <Text fw={600}>{selected?.user.name}</Text><Text size="sm" c="dimmed">{selected?.user.email}</Text>
      <Text size="sm">{selected?.action==='recovery'?'生成密码重置链接后，请将链接交给账号本人。链接 30 分钟内有效，生成新链接会使旧链接失效。':selected?.user.disabled?'启用后，该账号可重新使用系统。':'停用后，该账号将无法使用整个系统，历史内容保留。如果该账号是某个项目唯一的管理员，需要先交接项目。'}</Text>
      <Failure error={error}/>{url&&<><TextInput label="密码重置链接（30 分钟内有效）" readOnly value={url} onFocus={e=>e.currentTarget.select()}/><Button variant="light" onClick={async()=>{try{await navigator.clipboard.writeText(url);setCopied(true);}catch{setError('复制失败，请手动选择并复制链接');}}}>{copied?'已复制':'复制链接'}</Button></>}
      <Group justify="flex-end"><Button variant="default" disabled={busy} onClick={()=>setSelected(null)}>{url?'关闭':'取消'}</Button>{!url&&<Button loading={busy} color={selected?.action==='toggle'&&!selected.user.disabled?'red':undefined} onClick={()=>void perform()}>{selected?.action==='recovery'?'生成重置链接':`确认${actionTitle}`}</Button>}</Group>
    </Stack></Modal>
  </Stack>;
}
