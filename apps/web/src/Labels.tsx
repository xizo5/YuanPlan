import { useState } from 'react';
import { Button, Group, Modal, Pagination, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { IconPlus, IconSearch } from '@tabler/icons-react';
import type { Project } from '@yuanplan/contracts';
import { api, errorText, useData } from './api';
import { Empty, Failure, Loading } from './ui';

export type ProjectLabel = { id: string; name: string; version: number };

export function Labels({ project }: { project: Project }) {
  const labels = useData<ProjectLabel[]>(`/projects/${project.id}/labels`);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<ProjectLabel | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState('');
  const [remove, setRemove] = useState<ProjectLabel | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const editable = project.role !== 'viewer' && !project.archivedAt;
  const keyword = search.trim().toLocaleLowerCase();
  const filtered = (labels.data ?? []).filter(label => label.name.toLocaleLowerCase().includes(keyword));
  const totalPages = Math.max(1, Math.ceil(filtered.length / 10));
  const currentPage = Math.min(page, totalPages);
  const visible = filtered.slice((currentPage - 1) * 10, currentPage * 10);
  const openCreate = () => { setEditing(null); setName(''); setError(''); setFormOpen(true); };
  const openEdit = (label: ProjectLabel) => { setEditing(label); setName(label.name); setError(''); setFormOpen(true); };
  async function save() {
    setBusy(true); setError('');
    const savedName = name.trim();
    try {
      await api(`/projects/${project.id}/labels${editing ? `/${editing.id}` : ''}`, {
        method: editing ? 'PUT' : 'POST',
        body: editing ? { name: savedName, expectedVersion: editing.version } : { name: savedName },
      });
      setFormOpen(false); setEditing(null); setName(''); setSearch(savedName); setPage(1); labels.reload();
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  }
  return <Stack gap="md">
    <Group justify="space-between" gap="sm" className="page-heading"><div><Title order={3}>项目标签</Title><Text size="sm" c="dimmed">改名会同步相关任务；删除会解除任务关联，历史版本仍保留原标签。</Text></div>{editable && <Button leftSection={<IconPlus size={16}/>} onClick={openCreate}>新增标签</Button>}</Group>
    <TextInput aria-label="搜索项目标签" placeholder="搜索标签名称…" leftSection={<IconSearch size={16}/>} value={search} onChange={event => { setSearch(event.currentTarget.value); setPage(1); }} style={{ maxWidth: 360 }}/>
    <Failure error={labels.error || (!formOpen && !remove ? error : '')}/>
    {labels.loading ? <Loading/> : labels.error ? null : !visible.length ? <Empty title={keyword ? '没有匹配的标签' : '还没有标签'} detail={keyword ? '请尝试其他标签名称。' : editable ? '可以在这里新建，也可以在编辑任务时输入新标签。' : '当前项目暂无标签。'}/> : <div className="project-management-table-scroll"><Table highlightOnHover verticalSpacing="sm" className="project-management-table project-label-table"><Table.Thead><Table.Tr><Table.Th>标签名称</Table.Th><Table.Th>操作</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{visible.map(label => <Table.Tr key={label.id}><Table.Td><Text size="sm" fw={600}>{label.name}</Text></Table.Td><Table.Td>{editable && <Group gap="xs"><Button size="xs" variant="subtle" onClick={() => openEdit(label)}>改名</Button>{project.role === 'admin' && <Button size="xs" variant="subtle" color="red" onClick={() => { setError(''); setRemove(label); }}>删除</Button>}</Group>}</Table.Td></Table.Tr>)}</Table.Tbody></Table></div>}
    {!labels.loading && !labels.error && !!labels.data?.length && <Group justify="space-between" gap="sm"><Text size="sm" c="dimmed">共 {filtered.length} 个标签</Text>{totalPages > 1 && <Pagination total={totalPages} value={currentPage} onChange={setPage} size="sm" getItemProps={value => ({ 'aria-label': `第 ${value} 页` })} getControlProps={control => ({ 'aria-label': ({ first: '首页', previous: '上一页', next: '下一页', last: '末页' })[control] })}/>}</Group>}
    <Modal opened={formOpen} onClose={() => !busy && setFormOpen(false)} title={editing ? '改名标签' : '新增标签'}><form onSubmit={event => { event.preventDefault(); void save(); }}><Stack><Failure error={error}/><TextInput label={editing ? '标签新名称' : '标签名称'} required maxLength={40} autoFocus value={name} onChange={event => setName(event.currentTarget.value)}/><Group justify="flex-end"><Button variant="default" disabled={busy} onClick={() => setFormOpen(false)}>取消</Button><Button type="submit" loading={busy} disabled={!name.trim() || name.trim() === editing?.name}>{editing ? '保存名称' : '创建标签'}</Button></Group></Stack></form></Modal>
    <Modal opened={!!remove} onClose={() => !busy && setRemove(null)} title="删除项目标签" role="alertdialog"><Stack><Text>确认删除“{remove?.name}”？将从本项目全部相关任务（包括归档和回收站中的任务）移除该标签。</Text><Failure error={error}/><Group justify="flex-end"><Button variant="default" disabled={busy} onClick={() => setRemove(null)}>取消</Button><Button color="red" loading={busy} onClick={async () => { if (!remove) return; setBusy(true); setError(''); try { await api(`/projects/${project.id}/labels/${remove.id}`, { method: 'PUT', body: { name: null, expectedVersion: remove.version } }); setRemove(null); labels.reload(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); } }}>确认删除</Button></Group></Stack></Modal>
  </Stack>;
}
