import { useState } from 'react';
import { Button, Group, Pagination, Select, Stack, Text, TextInput, Title } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconSearch } from '@tabler/icons-react';
import { priorityLabels, statusLabels, type Task } from '@yuanplan/contracts';
import { navigate, useData } from './api';
import { Empty, Failure, Loading } from './ui';

type TaskPage = { items: Task[]; total: number; page: number; pageSize: number };
const statusOptions = Object.entries(statusLabels).map(([value, label]) => ({ value, label }));
const priorityOptions = Object.entries(priorityLabels).map(([value, label]) => ({ value, label }));

export function MyTasks() {
  const [search, setSearch] = useState('');
  const [query] = useDebouncedValue(search.trim(), 250);
  const [status, setStatus] = useState<string | null>(null);
  const [priority, setPriority] = useState<string | null>(null);
  const [pageSize, setPageSize] = useState('10');
  const [selection, setSelection] = useState({ key: '', page: 1 });
  const params = new URLSearchParams({ query, pageSize });
  if (status) params.set('status', status);
  if (priority) params.set('priority', priority);
  const filterKey = params.toString();
  params.set('page', String(selection.key === filterKey ? selection.page : 1));
  const tasks = useData<TaskPage>(`/my-tasks?${params}`);
  const filtered = Boolean(search || status || priority);
  function reset() {
    setSearch(''); setStatus(null); setPriority(null); setSelection({ key: '', page: 1 });
  }
  // Reset the saved page immediately, including before the search debounce completes.
  function filtersChanged() { setSelection({ key: '', page: 1 }); }

  return <Stack>
    <Title order={1}>我的任务</Title>
    <Group align="end" gap="sm" className="my-tasks-filters">
      <TextInput label="任务名称" placeholder="搜索任务名称" aria-label="搜索任务名称" maxLength={200}
        leftSection={<IconSearch size={16}/>} value={search}
        onChange={event => { setSearch(event.currentTarget.value); filtersChanged(); }}
        style={{ flex: '0 1 280px', minWidth: 0, maxWidth: '100%' }}/>
      <Select label="状态" aria-label="任务状态" placeholder="全部状态" clearable
        data={statusOptions} value={status} onChange={value => { setStatus(value); filtersChanged(); }} w={140}/>
      <Select label="优先级" aria-label="任务优先级" placeholder="全部优先级" clearable
        data={priorityOptions} value={priority} onChange={value => { setPriority(value); filtersChanged(); }} w={140}/>
      <Button variant="subtle" disabled={!filtered} onClick={reset}>清空筛选</Button>
    </Group>
    <Failure error={tasks.error}/>
    {tasks.error ? <Button variant="light" onClick={tasks.reload} style={{ alignSelf: 'flex-start' }}>重新加载</Button>
      : tasks.loading ? <Loading/>
      : tasks.data?.items.length ? <div className="task-list-scroll"><div className="personal-task-list">
        <div className="personal-task-row list-heading" aria-hidden="true">
          <span>编号</span><span>任务名称</span><span>项目</span><span>状态</span><span>优先级</span><span>截止日期</span>
        </div>
        {tasks.data.items.map(task => <button className="personal-task-row" key={task.id} type="button"
          onClick={() => navigate(`/projects/${task.projectId}?task=${task.id}`)}>
          <span className="muted">#{String(task.number).padStart(3, '0')}</span>
          <span className="row-title">{task.title}</span>
          <span className="muted row-title">{task.projectName}</span>
          <span>{statusLabels[task.status]}</span><span className="muted">{priorityLabels[task.priority]}</span>
          <span className="muted" data-empty={!task.dueDate || undefined}>{task.dueDate || '—'}</span>
        </button>)}
      </div></div>
      : <Empty title={filtered ? '没有匹配的任务' : '当前没有分配给你的任务'}
        detail={filtered ? '请调整任务名称、状态或优先级，或清空筛选。' : undefined}/>}
    {!tasks.loading && !tasks.error && tasks.data && <Group justify="space-between" gap="sm">
      <Text size="sm" c="dimmed" role="status">共 {tasks.data.total} 个任务</Text>
      <Group gap="sm">
        <Select w={105} aria-label="每页任务数" allowDeselect={false} value={pageSize}
          onChange={value => { setPageSize(value ?? '10'); filtersChanged(); }}
          data={['10', '20', '50'].map(value => ({ value, label: `${value} 条/页` }))}/>
        {tasks.data.total > 0 && <Pagination total={Math.ceil(tasks.data.total / tasks.data.pageSize)}
          value={tasks.data.page} onChange={page => setSelection({ key: filterKey, page })} size="sm" siblings={0}
          getItemProps={value => ({ 'aria-label': `第 ${value} 页` })}
          getControlProps={control => ({ 'aria-label': ({ first: '首页', previous: '上一页', next: '下一页', last: '末页' })[control] })}/>}
      </Group>
    </Group>}
  </Stack>;
}
