import { useState } from 'react';
import { Badge, Button, Group, Modal, Stack, Text, TextInput, Title } from '@mantine/core';
import type { Page, Project, Task } from '@yuanplan/contracts';
import { statusLabels } from '@yuanplan/contracts';
import { api, errorText, useData } from './api';
import { Failure, Loading } from './ui';

export function Subtasks({ project, parent, canEdit, open, changed }: {
  project: Project; parent: Task; canEdit: boolean;
  open: (id: string) => void; changed: () => void;
}) {
  const base = `/projects/${project.id}/tasks`;
  const [cursor, setCursor] = useState<string | null>(null);
  const children = useData<Page<Task>>(`${base}?parentId=${parent.id}${cursor ? `&cursor=${cursor}` : ''}`);
  const [title, setTitle] = useState('');
  const [linkOpen, setLinkOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [candidateCursor, setCandidateCursor] = useState<string | null>(null);
  const candidates = useData<Page<Task>>(linkOpen ? `${base}?attachTo=${parent.id}&query=${encodeURIComponent(search)}${candidateCursor ? `&cursor=${candidateCursor}` : ''}` : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  function refresh() {
    setCursor(null);
    children.reload();
    candidates.reload();
    changed();
  }
  async function link(task: Task, parentId: string | null) {
    if (busy) return;
    setBusy(true); setError('');
    try {
      await api(`${base}/${task.id}`, { method: 'PUT', body: { data: { parentId }, expectedVersion: task.version } });
      setLinkOpen(false); refresh();
    } catch (e) {
      setError(errorText(e)); children.reload(); candidates.reload();
    } finally { setBusy(false); }
  }
  return <Stack gap="xs">
    <Group justify="space-between"><Title order={5}>子任务</Title>{canEdit && <Button size="compact-xs" variant="subtle" disabled={busy} onClick={() => { setError(''); setSearch(''); setCandidateCursor(null); setLinkOpen(true); }}>关联已有任务</Button>}</Group>
    {!linkOpen && <Failure error={error || children.error}/>}
    {children.loading ? <Loading/> : children.data?.items.map(task => <Group key={task.id} justify="space-between" wrap="nowrap">
      <Button variant="subtle" size="compact-sm" onClick={() => open(task.id)} style={{ minWidth: 0, flex: 1 }} justify="start">{task.title}</Button>
      <Badge size="sm" variant="light">{statusLabels[task.status]}</Badge>
      {canEdit && <Button size="compact-xs" variant="subtle" color="gray" disabled={busy} aria-label={`解除关联 ${task.title}`} onClick={() => void link(task, null)}>解除关联</Button>}
    </Group>)}
    {!children.loading && !children.error && !children.data?.items.length && <Text size="xs" c="dimmed">暂无子任务</Text>}
    {(cursor || children.data?.nextCursor) && <Group>{cursor && <Button size="compact-xs" variant="subtle" onClick={() => setCursor(null)}>首批子任务</Button>}{children.data?.nextCursor && <Button size="compact-xs" variant="subtle" onClick={() => setCursor(children.data!.nextCursor)}>更多子任务</Button>}</Group>}
    {canEdit && <Group align="end"><TextInput label="添加子任务" placeholder="子任务标题" value={title} onChange={e => setTitle(e.currentTarget.value)} style={{ flex: 1 }} disabled={busy}/><Button variant="light" disabled={!title.trim()} loading={busy} onClick={async () => {
      if (busy) return;
      setBusy(true); setError('');
      try { await api(base, { body: { title: title.trim(), parentId: parent.id } }); setTitle(''); refresh(); }
      catch (e) { setError(errorText(e)); }
      finally { setBusy(false); }
    }}>添加</Button></Group>}
    <Modal opened={linkOpen} onClose={() => !busy && setLinkOpen(false)} title="关联已有任务">
      <Stack gap="sm"><TextInput label="搜索已有任务" placeholder="任务编号或标题" value={search} onChange={e => { setSearch(e.currentTarget.value); setCandidateCursor(null); }}/><Text size="xs" c="dimmed">选择同项目中尚无父任务、且不含子任务的任务。关联后保留原有内容和状态。</Text><Failure error={error || candidates.error}/>
        {candidates.loading ? <Loading/> : candidates.data?.items.map(task => <Group key={task.id} justify="space-between" wrap="nowrap"><Text size="sm" lineClamp={1}>#{task.number} {task.title}</Text><Button size="compact-xs" variant="light" disabled={busy} aria-label={`关联 ${task.title}`} onClick={() => void link(task, parent.id)}>关联</Button></Group>)}
        {!candidates.loading && !candidates.error && !candidates.data?.items.length && <Text size="sm" c="dimmed">没有可关联的任务</Text>}
        <Group>{candidateCursor && <Button variant="subtle" size="xs" onClick={() => setCandidateCursor(null)}>第一页</Button>}{candidates.data?.nextCursor && <Button variant="subtle" size="xs" onClick={() => setCandidateCursor(candidates.data!.nextCursor)}>下一页</Button>}</Group>
      </Stack>
    </Modal>
  </Stack>;
}
