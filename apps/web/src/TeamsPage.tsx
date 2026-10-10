import { useState } from 'react';
import { Badge, Button, Group, Modal, Pagination, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { IconArrowLeft, IconPlus, IconSearch } from '@tabler/icons-react';
import { roleLabels, type Member, type Role } from '@yuanplan/contracts';
import { api, errorText, useData } from './api';
import { Empty, Failure, Loading } from './ui';

type Team = { id: string; name: string; memberCount: number; role: 'admin' | 'member'; version: number };
type Invite = { id: string; email: string; role: Role; acceptedAt: string | null; revokedAt: string | null; expiresAt: string };
const pageSize = 10;

function TeamInvitation({ teamId }: { teamId: string }) {
  const invitations = useData<Invite[]>(`/invitations/team/${teamId}`);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revoke, setRevoke] = useState<string | null>(null);
  return <Stack>
    <form onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError('');
      try {
        const result = await api<{ url: string }>(`/invitations/team/${teamId}`, { body: { email, role } });
        setUrl(result.url); invitations.reload();
      } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
    }}>
      <Stack>
        <Text size="sm" c="dimmed">邀请链接绑定受邀邮箱，7 天内有效。</Text>
        <Failure error={error || invitations.error}/>
        <TextInput label="受邀邮箱" type="email" required value={email} onChange={event => setEmail(event.currentTarget.value)}/>
        <Select label="邀请角色" allowDeselect={false} value={role} data={[{ value: 'member', label: '成员' }, { value: 'admin', label: '管理员' }]} onChange={value => setRole(value as 'admin' | 'member')}/>
        <Button type="submit" loading={busy}>生成邀请链接</Button>
        {url && <TextInput label="邀请链接" readOnly value={url} onFocus={event => event.currentTarget.select()}/>}
      </Stack>
    </form>
    {!!invitations.data?.length && <><Title order={4} size="sm">邀请记录</Title>{invitations.data.map(invite => <Group key={invite.id} justify="space-between" gap="xs" className="team-invite-row"><div><Text size="sm">{invite.email}</Text><Text size="xs" c="dimmed">{roleLabels[invite.role]}</Text></div>{invite.acceptedAt ? <Badge>已接受</Badge> : invite.revokedAt ? <Badge color="gray">已撤销</Badge> : new Date(invite.expiresAt) < new Date() ? <Badge color="gray">已过期</Badge> : <Button size="xs" variant="subtle" color="red" onClick={() => setRevoke(invite.id)}>撤销</Button>}</Group>)}</>}
    <Modal opened={!!revoke} onClose={() => !busy && setRevoke(null)} title="撤销邀请" role="alertdialog"><Stack><Text>确认撤销此邀请？原链接将失效。</Text><Failure error={error}/><Button color="red" loading={busy} onClick={async () => { setBusy(true); setError(''); try { await api(`/invitations/${revoke}/revoke`, { body: {} }); setRevoke(null); setUrl(''); invitations.reload(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); } }}>确认撤销</Button></Stack></Modal>
  </Stack>;
}

export function TeamsPage() {
  const teams = useData<Team[]>('/teams');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [name, setName] = useState('');
  const [rename, setRename] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<{ type: 'delete' | 'remove_member'; member?: Member } | null>(null);
  const members = useData<Member[]>(selectedId ? `/teams/${selectedId}/members` : null);
  const team = teams.data?.find(item => item.id === selectedId);
  const admin = team?.role === 'admin';
  const filtered = (teams.data ?? []).filter(item => item.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visible = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const refresh = () => { teams.reload(); members.reload(); };
  const openTeam = (item: Team) => { setSelectedId(item.id); setRename(item.name); setError(''); };
  const back = () => { setSelectedId(null); setError(''); };

  return <Stack gap="md">
    {team ? <>
      <Group justify="space-between" gap="sm" className="page-heading">
        <Group gap="sm"><Button variant="subtle" color="gray" leftSection={<IconArrowLeft size={16}/>} onClick={back}>返回团队列表</Button><Title order={1}>{team.name}</Title></Group>
        {admin && <Group gap="xs"><Button variant="light" onClick={() => { setError(''); setInviteOpen(true); }}>邀请成员</Button><Button variant="subtle" color="gray" onClick={() => { setRename(team.name); setError(''); setRenameOpen(true); }}>编辑团队</Button></Group>}
      </Group>
      <Text size="sm" c="dimmed">{team.memberCount} 位成员 · 项目权限需单独分配</Text>
      <Failure error={error || members.error || teams.error}/>
      {members.loading ? <Loading/> : members.error ? null : !members.data?.length ? <Empty title="暂无成员" detail="邀请成员加入这个团队。"/> : <div className="team-table-scroll"><Table striped={false} highlightOnHover verticalSpacing="sm" className="team-table"><Table.Thead><Table.Tr><Table.Th>成员</Table.Th><Table.Th>团队角色</Table.Th><Table.Th>操作</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{members.data.map(member => <Table.Tr key={member.userId}><Table.Td><Text size="sm" fw={600}>{member.name}</Text><Text size="xs" c="dimmed">{member.email}</Text></Table.Td><Table.Td>{admin ? <Select aria-label={`${member.name}的团队角色`} disabled={busy} w={120} allowDeselect={false} data={[{ value: 'admin', label: '管理员' }, { value: 'member', label: '成员' }]} value={member.role} onChange={async role => { if (!role || role === member.role) return; setBusy(true); setError(''); try { await api(`/teams/${team.id}/members/${member.userId}`, { method: 'PUT', body: { role, expectedRole: member.role } }); refresh(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); } }}/> : <Badge variant="light">{roleLabels[member.role]}</Badge>}</Table.Td><Table.Td>{admin && <Button size="xs" variant="subtle" color="red" onClick={() => { setError(''); setAction({ type: 'remove_member', member }); }}>移出团队</Button>}</Table.Td></Table.Tr>)}</Table.Tbody></Table></div>}
    </> : <>
      <Group justify="space-between" gap="sm" className="page-heading"><div><Title order={1}>团队</Title><Text size="sm" c="dimmed">集中管理协作成员；项目权限需单独分配。</Text></div><Button leftSection={<IconPlus size={16}/>} onClick={() => { setName(''); setError(''); setCreateOpen(true); }}>新增团队</Button></Group>
      <TextInput aria-label="搜索团队名称" placeholder="搜索团队名称…" leftSection={<IconSearch size={16}/>} value={search} onChange={event => { setSearch(event.currentTarget.value); setPage(1); }} style={{ maxWidth: 360 }}/>
      <Failure error={teams.error}/>
      {teams.loading ? <Loading/> : teams.error ? null : !visible.length ? <Empty title={search ? '没有匹配的团队' : '还没有团队'} detail={search ? '请尝试其他名称。' : '点击右上角“新增团队”开始创建。'}/> : <div className="team-table-scroll"><Table highlightOnHover verticalSpacing="sm" className="team-table"><Table.Thead><Table.Tr><Table.Th>团队名称</Table.Th><Table.Th>成员数</Table.Th><Table.Th>我的角色</Table.Th><Table.Th>操作</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{visible.map(item => <Table.Tr key={item.id}><Table.Td><Button variant="subtle" size="compact-sm" className="team-name-button" onClick={() => openTeam(item)}>{item.name}</Button></Table.Td><Table.Td>{item.memberCount} 人</Table.Td><Table.Td><Badge variant="light" color={item.role === 'admin' ? 'forest' : 'gray'}>{roleLabels[item.role]}</Badge></Table.Td><Table.Td><Button variant="subtle" size="xs" onClick={() => openTeam(item)}>查看成员</Button></Table.Td></Table.Tr>)}</Table.Tbody></Table></div>}
      {!teams.loading && !teams.error && !!teams.data?.length && <Group justify="space-between" gap="sm"><Text size="sm" c="dimmed">共 {filtered.length} 个团队</Text>{pageCount > 1 && <Pagination total={pageCount} value={currentPage} onChange={setPage} size="sm" getItemProps={value => ({ 'aria-label': `第 ${value} 页` })} getControlProps={control => ({ 'aria-label': ({ first: '首页', previous: '上一页', next: '下一页', last: '末页' })[control] })}/>}</Group>}
    </>}
    <Modal opened={createOpen} onClose={() => !busy && setCreateOpen(false)} title="新增团队"><form onSubmit={async event => { event.preventDefault(); setBusy(true); setError(''); try { const created = await api<Team>('/teams', { body: { name: name.trim() } }); setCreateOpen(false); setName(''); setSelectedId(created.id); teams.reload(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); } }}><Stack><Failure error={error}/><TextInput label="团队名称" required maxLength={100} autoFocus value={name} onChange={event => setName(event.currentTarget.value)}/><Button type="submit" loading={busy} disabled={!name.trim()}>创建团队</Button></Stack></form></Modal>
    <Modal opened={renameOpen && !!team} onClose={() => !busy && setRenameOpen(false)} title="编辑团队"><Stack><Failure error={error}/><form onSubmit={async event => { event.preventDefault(); if (!team) return; setBusy(true); setError(''); try { await api(`/teams/${team.id}`, { method: 'PUT', body: { name: rename.trim(), expectedVersion: team.version } }); setRenameOpen(false); teams.reload(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); } }}><Stack><TextInput label="团队名称" required maxLength={100} value={rename} onChange={event => setRename(event.currentTarget.value)}/><Button type="submit" loading={busy} disabled={!rename.trim() || rename.trim() === team?.name}>保存名称</Button></Stack></form><Button color="red" variant="subtle" onClick={() => { setRenameOpen(false); setError(''); setAction({ type: 'delete' }); }}>删除团队</Button></Stack></Modal>
    <Modal opened={inviteOpen && !!team} onClose={() => setInviteOpen(false)} title={`邀请成员加入${team?.name ?? ''}`} size="lg">{team && <TeamInvitation key={team.id} teamId={team.id}/>}</Modal>
    <Modal opened={!!action && !!team} onClose={() => !busy && setAction(null)} title={action?.type === 'delete' ? '删除团队' : '移出团队'} role="alertdialog"><Stack><Text>{action?.type === 'delete' ? `确认删除团队“${team?.name}”？关联项目会保留，并解除团队关联。` : `确认将 ${action?.member?.name} 移出团队？已有项目成员资格不变。`}</Text><Failure error={error}/><Button color="red" loading={busy} onClick={async () => { if (!team || !action) return; setBusy(true); setError(''); try { await api(`/teams/${team.id}/manage`, { body: { action: action.type, userId: action.member?.userId ?? null, expectedVersion: team.version } }); if (action.type === 'delete') setSelectedId(null); setAction(null); refresh(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); } }}>确认操作</Button></Stack></Modal>
  </Stack>;
}
