import { useState } from 'react';
import { Alert, Badge, Button, Card, Checkbox, Group, Modal, MultiSelect, Pagination, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { IconPlus, IconSearch } from '@tabler/icons-react';
import type { Project } from '@yuanplan/contracts';
import { api, errorText, useData } from './api';
import { Empty, Failure, Loading } from './ui';

type Credential = { id: string; name: string; prefix: string; scope: 'read' | 'write'; allProjects: boolean; projectIds: string[]; createdAt: string; expiresAt: string | null; revokedAt: string | null };
type CredentialStatus = 'active' | 'expired' | 'revoked';
const pageSize = 10;
const statusText = { active: '有效', expired: '已过期', revoked: '已撤销' };
function credentialStatus(item: Credential): CredentialStatus {
  if (item.revokedAt) return 'revoked';
  if (item.expiresAt && new Date(item.expiresAt).getTime() <= Date.now()) return 'expired';
  return 'active';
}

export function IntegrationsPage() {
  const credentials = useData<Credential[]>('/credentials');
  const projects = useData<Project[]>('/projects');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [allProjects, setAllProjects] = useState(false);
  const [scope, setScope] = useState<'read' | 'write'>('read');
  const [expiry, setExpiry] = useState('');
  const [token, setToken] = useState('');
  const [revoke, setRevoke] = useState<Credential | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [connectionCopied, setConnectionCopied] = useState(false);
  const endpoint = `${location.origin}/api/mcp`;
  const keyword = search.trim().toLocaleLowerCase();
  const filtered = (credentials.data ?? []).filter(item =>
    (!keyword || item.name.toLocaleLowerCase().includes(keyword) || item.prefix.toLocaleLowerCase().includes(keyword)) &&
    (status === 'all' || credentialStatus(item) === status)
  );
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const visible = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const closeCreate = () => { if (busy) return; setCreateOpen(false); setToken(''); setName(''); setProjectIds([]); setAllProjects(false); setScope('read'); setExpiry(''); setError(''); setCopied(false); };
  async function copy(value: string, connection = false) {
    try { await navigator.clipboard.writeText(value); if (connection) setConnectionCopied(true); else setCopied(true); }
    catch { setError('复制失败，请手动选择并复制。'); }
  }

  return <Stack gap="md">
    <Group justify="space-between" gap="sm" className="page-heading"><div><Title order={1}>AI 与集成</Title><Text size="sm" c="dimmed">创建项目范围凭据，供 AI 客户端安全连接；需要时可覆盖全部项目。</Text></div><Button leftSection={<IconPlus size={16}/>} onClick={() => { setError(''); setCreateOpen(true); }}>新增凭据</Button></Group>
    <Card withBorder className="integration-endpoint"><Group justify="space-between" gap="sm" align="flex-end"><div className="integration-endpoint-info"><Text fw={600} size="sm">MCP 连接地址</Text><Text size="sm" className="integration-endpoint-url">{endpoint}</Text><Text size="xs" c="dimmed">Streamable HTTP · 请求头使用 Authorization: Bearer &lt;凭据&gt;</Text></div><Button size="xs" variant="light" onClick={() => void copy(endpoint, true)}>{connectionCopied ? '已复制' : '复制地址'}</Button></Group></Card>
    <Group gap="xs"><TextInput aria-label="搜索凭据名称" placeholder="搜索凭据名称或前缀…" leftSection={<IconSearch size={16}/>} value={search} onChange={event => { setSearch(event.currentTarget.value); setPage(1); }} style={{ flex: '1 1 220px', maxWidth: 360 }}/><Select aria-label="凭据状态" w={140} allowDeselect={false} value={status} onChange={value => { setStatus(value ?? 'all'); setPage(1); }} data={[{ value: 'all', label: '全部状态' }, { value: 'active', label: '有效' }, { value: 'expired', label: '已过期' }, { value: 'revoked', label: '已撤销' }]}/></Group>
    <Failure error={credentials.error || (!createOpen && !revoke ? error : '')}/>
    {credentials.loading ? <Loading/> : credentials.error ? null : !visible.length ? <Empty title={keyword || status !== 'all' ? '没有匹配的凭据' : '还没有访问凭据'} detail={keyword || status !== 'all' ? '请调整搜索词或状态筛选。' : '点击右上角“新增凭据”创建第一个连接。'}/> : <div className="integration-table-scroll"><Table highlightOnHover verticalSpacing="sm" className="integration-table"><Table.Thead><Table.Tr><Table.Th>凭据名称</Table.Th><Table.Th>项目范围</Table.Th><Table.Th>权限</Table.Th><Table.Th>状态</Table.Th><Table.Th>创建时间</Table.Th><Table.Th>操作</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{visible.map(item => { const state = credentialStatus(item); return <Table.Tr key={item.id}><Table.Td><Text size="sm" fw={600}>{item.name}</Text><Text size="xs" c="dimmed">{item.prefix}…</Text></Table.Td><Table.Td>{item.allProjects ? '全部项目' : `${item.projectIds.length} 个项目`}</Table.Td><Table.Td><Badge variant="light" color={item.scope === 'write' ? 'orange' : 'forest'}>{item.scope === 'write' ? '读写' : '只读'}</Badge></Table.Td><Table.Td><Badge variant="light" color={state === 'active' ? 'forest' : 'gray'}>{statusText[state]}</Badge>{item.expiresAt && <Text size="xs" c="dimmed">到期：{new Date(item.expiresAt).toLocaleDateString('zh-CN')}</Text>}</Table.Td><Table.Td>{new Date(item.createdAt).toLocaleDateString('zh-CN')}</Table.Td><Table.Td>{state === 'active' && <Button size="xs" variant="subtle" color="red" onClick={() => { setError(''); setRevoke(item); }}>撤销</Button>}</Table.Td></Table.Tr>; })}</Table.Tbody></Table></div>}
    {!credentials.loading && !credentials.error && !!credentials.data?.length && <Group justify="space-between" gap="sm"><Text size="sm" c="dimmed">共 {filtered.length} 个凭据</Text>{totalPages > 1 && <Pagination total={totalPages} value={currentPage} onChange={setPage} size="sm" getItemProps={value => ({ 'aria-label': `第 ${value} 页` })} getControlProps={control => ({ 'aria-label': ({ first: '首页', previous: '上一页', next: '下一页', last: '末页' })[control] })}/>}</Group>}
    <Modal opened={createOpen} onClose={closeCreate} title={token ? '保存新凭据' : '新增访问凭据'} size="lg" closeOnEscape={!busy} closeOnClickOutside={!busy}>
      {token ? <Stack><Alert color="orange" title="请立即保存">凭据仅在创建时显示一次。关闭后将无法再次查看。</Alert><TextInput label="新凭据" readOnly value={token} onFocus={event => event.currentTarget.select()}/><Failure error={error}/><Group justify="flex-end"><Button variant="light" onClick={() => void copy(token)}>{copied ? '已复制' : '复制凭据'}</Button><Button onClick={closeCreate}>我已保存，关闭</Button></Group></Stack> : <form onSubmit={async event => { event.preventDefault(); setBusy(true); setError(''); try { const created = await api<{ token: string }>('/credentials', { body: { name: name.trim(), projectIds, allProjects, scope, expiresAt: expiry ? new Date(`${expiry}T23:59:59`).toISOString() : null } }); setToken(created.token); credentials.reload(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); } }}><Stack><Failure error={error || projects.error}/><TextInput label="名称" required maxLength={100} autoFocus value={name} onChange={event => setName(event.currentTarget.value)}/><MultiSelect label="允许访问的项目" required={!allProjects} disabled={allProjects} searchable data={(projects.data ?? []).filter(project => scope === 'read' || project.role !== 'viewer').map(project => ({ value: project.id, label: project.name }))} value={projectIds} onChange={setProjectIds}/><Checkbox label="覆盖全部项目" description="包含以后新建的项目；仍受你在该项目的成员身份限制，且不能执行项目级管理操作。" checked={allProjects} onChange={event => setAllProjects(event.currentTarget.checked)}/><Group grow><Select label="权限" allowDeselect={false} value={scope} data={[{ value: 'read', label: '只读' }, { value: 'write', label: '读写' }]} onChange={value => { setScope(value as 'read' | 'write'); if (value === 'write') setProjectIds(ids => ids.filter(id => projects.data?.some(project => project.id === id && project.role !== 'viewer'))); }}/><TextInput label="到期日期（可选）" type="date" min={new Date().toISOString().slice(0, 10)} value={expiry} onChange={event => setExpiry(event.currentTarget.value)}/></Group><Group justify="flex-end"><Button variant="default" onClick={closeCreate}>取消</Button><Button type="submit" loading={busy} disabled={!name.trim() || (!allProjects && !projectIds.length) || !!projects.error}>创建凭据</Button></Group></Stack></form>}
    </Modal>
    <Modal opened={!!revoke} onClose={() => !busy && setRevoke(null)} title="撤销访问凭据" role="alertdialog"><Stack><Text>确认撤销“{revoke?.name}”？使用此凭据的客户端将立即无法访问。</Text><Failure error={error}/><Group justify="flex-end"><Button variant="default" disabled={busy} onClick={() => setRevoke(null)}>取消</Button><Button color="red" loading={busy} onClick={async () => { if (!revoke) return; setBusy(true); setError(''); try { await api(`/credentials/${revoke.id}/revoke`, { body: {} }); setRevoke(null); credentials.reload(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); } }}>确认撤销</Button></Group></Stack></Modal>
  </Stack>;
}
