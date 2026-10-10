import { useState } from 'react';
import { Badge, Button, Group, Modal, MultiSelect, Pagination, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { IconPlus, IconSearch } from '@tabler/icons-react';
import { roleLabels, roles, type Member, type Project, type Role } from '@yuanplan/contracts';
import { api, errorText, useData } from './api';
import { Empty, Failure, Loading } from './ui';

type Invite = { id: string; email: string; role: Role; acceptedAt: string | null; revokedAt: string | null; expiresAt: string };

function AddFromTeam({ project, close, reload }: { project: Project; close: () => void; reload: () => void }) {
  const teams = useData<{ id: string; name: string }[]>('/teams');
  const [teamId, setTeamId] = useState<string | null>(null);
  const teamMembers = useData<Member[]>(teamId ? `/teams/${teamId}/members` : null);
  const [selected, setSelected] = useState<string[]>([]);
  const [role, setRole] = useState<Role>('member');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return <Stack>
    <Text size="sm" c="dimmed">只向选中的人员授予项目权限；已有项目成员保留原角色。</Text>
    <Failure error={error || teams.error || teamMembers.error}/>
    <Select label="选择团队" searchable data={(teams.data ?? []).map(team => ({ value: team.id, label: team.name }))} value={teamId} onChange={value => { setTeamId(value); setSelected([]); }}/>
    <MultiSelect label="选择团队人员" disabled={!teamId || teamMembers.loading} searchable data={(teamMembers.data ?? []).filter(member => !member.disabled).map(member => ({ value: member.userId, label: `${member.name} (${member.email})` }))} value={selected} onChange={setSelected}/>
    <Select label="加入项目后的角色" allowDeselect={false} data={roles.map(value => ({ value, label: roleLabels[value] }))} value={role} onChange={value => setRole(value as Role)}/>
    <Group justify="flex-end"><Button variant="default" disabled={busy} onClick={close}>取消</Button><Button disabled={!teamId || !selected.length} loading={busy} onClick={async () => { setBusy(true); setError(''); try { await api(`/projects/${project.id}/members/from-team`, { body: { teamId, userIds: selected, role } }); reload(); close(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); } }}>加入选中成员</Button></Group>
  </Stack>;
}

function InviteMember({ projectId }: { projectId: string }) {
  const invitations = useData<Invite[]>(`/invitations/project/${projectId}`);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revoke, setRevoke] = useState<string | null>(null);
  return <Stack>
    <form onSubmit={async event => { event.preventDefault(); setBusy(true); setError(''); try { const result = await api<{ url: string }>(`/invitations/project/${projectId}`, { body: { email, role } }); setUrl(result.url); invitations.reload(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); } }}><Stack>
      <Text size="sm" c="dimmed">邀请链接绑定受邀邮箱，7 天内有效。</Text><Failure error={error || invitations.error}/>
      <TextInput label="受邀邮箱" type="email" required value={email} onChange={event => setEmail(event.currentTarget.value)}/>
      <Select label="邀请角色" allowDeselect={false} value={role} data={roles.map(value => ({ value, label: roleLabels[value] }))} onChange={value => setRole(value as Role)}/>
      <Button type="submit" loading={busy}>生成邀请链接</Button>
      {url && <TextInput label="邀请链接" readOnly value={url} onFocus={event => event.currentTarget.select()}/>}
    </Stack></form>
    {!!invitations.data?.length && <><Title order={4} size="sm">邀请记录</Title>{invitations.data.map(invite => <Group key={invite.id} justify="space-between" gap="xs" className="team-invite-row"><div><Text size="sm">{invite.email}</Text><Text size="xs" c="dimmed">{roleLabels[invite.role]}</Text></div>{invite.acceptedAt ? <Badge>已接受</Badge> : invite.revokedAt ? <Badge color="gray">已撤销</Badge> : new Date(invite.expiresAt) < new Date() ? <Badge color="gray">已过期</Badge> : <Button size="xs" color="red" variant="subtle" onClick={() => setRevoke(invite.id)}>撤销</Button>}</Group>)}</>}
    <Modal opened={!!revoke} onClose={() => !busy && setRevoke(null)} title="撤销邀请" role="alertdialog"><Stack><Text>确认撤销此邀请？原链接将失效。</Text><Failure error={error}/><Button color="red" loading={busy} onClick={async () => { setBusy(true); setError(''); try { await api(`/invitations/${revoke}/revoke`, { body: {} }); setRevoke(null); setUrl(''); invitations.reload(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); } }}>确认撤销</Button></Stack></Modal>
  </Stack>;
}

export function Members({ project, members, reload }: { project: Project; members: Member[]; reload: () => void }) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [teamOpen, setTeamOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [remove, setRemove] = useState<Member | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const admin = project.role === 'admin' && !project.archivedAt;
  const keyword = search.trim().toLocaleLowerCase();
  const filtered = members.filter(member => member.name.toLocaleLowerCase().includes(keyword) || member.email.toLocaleLowerCase().includes(keyword));
  const totalPages = Math.max(1, Math.ceil(filtered.length / 10));
  const currentPage = Math.min(page, totalPages);
  const visible = filtered.slice((currentPage - 1) * 10, currentPage * 10);
  return <Stack gap="md">
    <Group justify="space-between" gap="sm" className="page-heading"><div><Title order={3}>项目成员</Title><Text size="sm" c="dimmed">管理项目成员及其角色。</Text></div>{admin && <Group gap="xs"><Button variant="light" onClick={() => setTeamOpen(true)}>从团队添加</Button><Button leftSection={<IconPlus size={16}/>} onClick={() => setInviteOpen(true)}>邀请成员</Button></Group>}</Group>
    <TextInput aria-label="搜索项目成员" placeholder="搜索姓名或邮箱…" leftSection={<IconSearch size={16}/>} value={search} onChange={event => { setSearch(event.currentTarget.value); setPage(1); }} style={{ maxWidth: 360 }}/>
    <Failure error={error}/>
    {!visible.length ? <Empty title={keyword ? '没有匹配的成员' : '暂无项目成员'} detail={keyword ? '请尝试其他姓名或邮箱。' : admin ? '可以邀请成员加入项目。' : '项目管理员可以邀请成员加入。'}/> : <div className="project-management-table-scroll"><Table highlightOnHover verticalSpacing="sm" className="project-management-table project-member-table"><Table.Thead><Table.Tr><Table.Th>成员</Table.Th><Table.Th>项目角色</Table.Th><Table.Th>操作</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{visible.map(member => <Table.Tr key={member.userId}><Table.Td><Text fw={600} size="sm">{member.name}</Text><Text size="xs" c="dimmed">{member.email}{member.disabled ? ' · 已停用' : ''}</Text></Table.Td><Table.Td>{admin ? <Select className="project-member-role-select" aria-label={`${member.name}的角色`} disabled={busy} allowDeselect={false} value={member.role} data={roles.map(value => ({ value, label: roleLabels[value] }))} onChange={async role => { if (!role || role === member.role) return; setBusy(true); setError(''); try { await api(`/projects/${project.id}/members/${member.userId}`, { method: 'PUT', body: { role } }); reload(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); } }}/> : <Badge variant="light">{roleLabels[member.role]}</Badge>}</Table.Td><Table.Td>{admin && <Button size="xs" color="red" variant="subtle" onClick={() => { setError(''); setRemove(member); }}>移除成员</Button>}</Table.Td></Table.Tr>)}</Table.Tbody></Table></div>}
    {!!members.length && <Group justify="space-between" gap="sm"><Text size="sm" c="dimmed">共 {filtered.length} 名成员</Text>{totalPages > 1 && <Pagination total={totalPages} value={currentPage} onChange={setPage} size="sm" getItemProps={value => ({ 'aria-label': `第 ${value} 页` })} getControlProps={control => ({ 'aria-label': ({ first: '首页', previous: '上一页', next: '下一页', last: '末页' })[control] })}/>}</Group>}
    <Modal opened={teamOpen} onClose={() => setTeamOpen(false)} title="从团队添加成员" size="lg"><AddFromTeam project={project} close={() => setTeamOpen(false)} reload={reload}/></Modal>
    <Modal opened={inviteOpen} onClose={() => setInviteOpen(false)} title="邀请项目成员" size="lg"><InviteMember projectId={project.id}/></Modal>
    <Modal opened={!!remove} onClose={() => !busy && setRemove(null)} title="移除项目成员" role="alertdialog"><Stack><Text>确认移除 {remove?.name}？其未归档任务将改为未分配，历史身份仍保留。</Text><Failure error={error}/><Button color="red" loading={busy} onClick={async () => { if (!remove) return; setBusy(true); setError(''); try { await api(`/projects/${project.id}/members/${remove.userId}`, { method: 'PUT', body: { role: null } }); setRemove(null); reload(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); } }}>确认移除</Button></Stack></Modal>
  </Stack>;
}
