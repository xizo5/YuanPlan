import { useEffect, useRef, useState } from 'react';
import { ActionIcon, Badge, Button, Card, Group, Modal, Select, Stack, Text, Title } from '@mantine/core';
import {
  IconAlertCircle, IconArrowDown, IconArrowUp, IconArrowUpRight, IconCalendarDue, IconChartBar,
  IconChartDonut, IconCheck, IconChecklist, IconClock, IconPlus, IconRefresh,
  IconSettings, IconTrash, IconUserQuestion, IconUsers,
} from '@tabler/icons-react';
import {
  defaultOverviewLayout, overviewWidgetKinds, priorityLabels, statusLabels,
  type OverviewLayout, type OverviewTask, type OverviewWidgetKind, type Project, type ProjectOverview as OverviewData, type Task,
} from '@yuanplan/contracts';
import { ApiError, api, confirmNavigation, errorText, navigate, registerDirty, useData } from './api';
import { Empty, Failure, Loading } from './ui';

const statusColors = { todo: '#89959c', in_progress: '#3989c6', in_review: '#c18a30', done: '#3b8568' };
const priorityColors = { low: '#89959c', normal: '#3989c6', high: '#c18a30', urgent: '#cf5555' };
const widgetInfo = {
  status: { title: '任务状态分布', description: '主任务在各阶段的数量', icon: IconChartDonut },
  priority: { title: '未完成任务优先级', description: '关注当前仍待处理的工作', icon: IconChartBar },
  assignees: { title: '人员待办分布', description: '任务数量不代表工作量或绩效', icon: IconUsers },
  attention: { title: '需要关注的任务', description: '逾期、未来 7 天到期及高 / 紧急任务', icon: IconAlertCircle },
  upcoming: { title: '未来 7 天到期', description: '包含今天，展示尚未完成的任务', icon: IconCalendarDue },
  unassigned: { title: '未分配任务', description: '尚未指定执行人的未完成任务', icon: IconUserQuestion },
};
type Selection = { status?: Task['status']; priority?: Task['priority']; assigneeId?: string; focus?: 'unfinished' | 'overdue' | 'upcoming' | 'attention' };
type Go = (selection?: Selection, taskId?: string) => void;

export function ProjectOverview({ project }: { project: Project }) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const q = useData<OverviewData>(`/projects/${project.id}/overview?${new URLSearchParams({ timeZone })}`);
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState('');
  if (q.loading) return <Loading/>;
  if (!q.data) return <Stack><Failure error={q.error}/><Button variant="default" onClick={q.reload}>重新加载概览</Button></Stack>;
  const data = q.data;
  const editable = project.role === 'admin' && !project.archivedAt;
  const go: Go = (selection = {}, taskId) => {
    const params = new URLSearchParams({ view: 'tasks', roots: 'true', ...selection });
    if (selection.focus) params.set('asOfDate', data.today);
    if (taskId) params.set('task', taskId);
    navigate(`/projects/${project.id}?${params}`);
  };
  const completedPercent = data.summary.total ? Math.round(data.summary.completed / data.summary.total * 100) : 0;
  const metrics = [
    { title: '主任务总数', value: data.summary.total, caption: '当前未归档的主任务', icon: IconChecklist, color: 'neutral', selection: {} },
    { title: '已完成', value: data.summary.completed, caption: `任务完成率 ${completedPercent}%`, icon: IconCheck, color: 'green', selection: { status: 'done' } },
    { title: '未完成', value: data.summary.unfinished, caption: '待办 · 进行中 · 待验收', icon: IconClock, color: 'blue', selection: { focus: 'unfinished' } },
    { title: '逾期任务', value: data.summary.overdue, caption: '截止日期已过，尚未完成', icon: IconAlertCircle, color: 'red', selection: { focus: 'overdue' } },
  ] as const;
  return <Stack gap="md" className="project-overview">
    <Group justify="space-between" align="flex-start" className="overview-toolbar">
      <div><Title order={2} size="h3">项目概览</Title><Text size="xs" c="dimmed" mt={4}>统计未归档主任务，子任务不重复计数</Text></div>
      <Group gap="xs"><Text size="xs" c="dimmed">更新于 {new Date(data.asOf).toLocaleTimeString('zh-CN')}</Text><Button variant="default" size="xs" leftSection={<IconRefresh size={14}/>} onClick={() => { setNotice(''); q.reload(); }}>刷新</Button>{editable && <Button variant="light" size="xs" leftSection={<IconSettings size={14}/>} onClick={() => { setNotice(''); setEditing(true); }}>配置概览</Button>}</Group>
    </Group>
    {notice && <Text size="sm" c="forest" role="status">{notice}</Text>}
    <div className="overview-metrics">{metrics.map(metric => <button key={metric.title} type="button" className={`overview-metric overview-metric-${metric.color}`} onClick={() => go(metric.selection)} aria-label={`查看${metric.title}：${metric.value} 项`}>
      <span className="overview-metric-heading"><span>{metric.title}</span><metric.icon size={18} aria-hidden="true"/></span>
      <strong>{metric.value}</strong><span className="overview-metric-caption">{metric.caption}<IconArrowUpRight size={13} aria-hidden="true"/></span>
    </button>)}</div>
    <div className={`overview-grid overview-grid-${data.layout.columns}`}>{data.layout.widgets.map(widget => {
      const info = widgetInfo[widget.kind];
      return <Card key={widget.kind} withBorder padding="lg" radius="md" className={`overview-widget ${widget.width === 'full' ? 'overview-widget-full' : ''}`} component="section" aria-label={info.title}>
        <Group gap="xs" mb={4}><span className="overview-widget-icon"><info.icon size={17} aria-hidden="true"/></span><Title order={3} size="sm">{info.title}</Title></Group>
        <Text size="xs" c="dimmed" mb="lg">{info.description}</Text>
        {widget.kind === 'status' ? <StatusChart data={data} go={go}/> : widget.kind === 'priority' ? <PriorityChart data={data} go={go}/> : widget.kind === 'assignees' ? <AssigneeChart data={data} go={go}/> : <TaskWidget kind={widget.kind} data={data} go={go}/>}
      </Card>;
    })}</div>
    <Text size="xs" c="dimmed" className="overview-footnote">统计日期：{data.today} · 任务完成率按数量计算 · 点击数字、图表或任务查看详情</Text>
    {editing && <LayoutEditor projectId={project.id} initial={data.layout} version={data.version} close={() => { if (confirmNavigation()) setEditing(false); }} saved={() => { setEditing(false); setNotice('布局已保存，项目成员共用此概览。'); q.reload(); }} reload={() => { if (confirmNavigation()) { setEditing(false); q.reload(); } }}/ >}
  </Stack>;
}

function StatusChart({ data, go }: { data: OverviewData; go: Go }) {
  const total = data.summary.total;
  const percentage = total ? Math.round(data.summary.completed / total * 100) : 0;
  let end = 0;
  const stops = data.statuses.map(item => { const start = end; end += total ? item.count / total * 100 : 0; return `${statusColors[item.status]} ${start}% ${end}%`; });
  return <div className="overview-status-chart">
    <button type="button" className="overview-donut" style={{ background: total ? `conic-gradient(${stops.join(',')})` : '#edf0ee' }} onClick={() => go()} aria-label={`查看全部 ${total} 项主任务，任务完成率 ${percentage}%`}>
      <span><strong>{percentage}<small>%</small></strong><span>任务完成率</span></span>
    </button>
    <div className="overview-status-legend">{data.statuses.map(item => <button key={item.status} type="button" onClick={() => go({ status: item.status })} aria-label={`查看${statusLabels[item.status]}任务：${item.count} 项`}>
      <span><i style={{ background: statusColors[item.status] }} aria-hidden="true"/>{statusLabels[item.status]}</span><strong>{item.count}</strong><small>{total ? Math.round(item.count / total * 100) : 0}%</small>
    </button>)}</div>
  </div>;
}

function PriorityChart({ data, go }: { data: OverviewData; go: Go }) {
  if (!data.summary.unfinished) return <Empty title="暂无未完成任务" detail="新增任务后将在这里展示优先级分布。"/>;
  return <div className="overview-bars">{[...data.priorities].reverse().map(item => <button type="button" key={item.priority} className="overview-bar-row" onClick={() => go({ focus: 'unfinished', priority: item.priority })} aria-label={`查看未完成的${priorityLabels[item.priority]}优先级任务：${item.count} 项`}>
    <span className="overview-bar-label">{priorityLabels[item.priority]}</span><span className="overview-bar-track" aria-hidden="true"><span style={{ width: `${item.count / data.summary.unfinished * 100}%`, background: priorityColors[item.priority] }}/></span><strong>{item.count}</strong><small>{Math.round(item.count / data.summary.unfinished * 100)}%</small>
  </button>)}</div>;
}

function AssigneeChart({ data, go }: { data: OverviewData; go: Go }) {
  const [expanded, setExpanded] = useState(false);
  if (!data.assignees.length) return <Empty title="暂无待办任务" detail="人员待办分布包含未分配任务。"/>;
  const max = data.assignees[0].count;
  return <><div className="overview-bars overview-assignee-bars">{(expanded ? data.assignees : data.assignees.slice(0, 8)).map(item => <button type="button" key={item.assigneeId ?? 'unassigned'} className="overview-bar-row" onClick={() => go({ focus: 'unfinished', assigneeId: item.assigneeId ?? 'unassigned' })} aria-label={`查看${item.name}的未完成任务：${item.count} 项，其中逾期 ${item.overdue} 项`}>
    <span className="overview-bar-label" title={item.name}>{item.name}</span><span className="overview-bar-track" aria-hidden="true"><span style={{ width: `${item.count / max * 100}%`, background: item.assigneeId ? '#5b9379' : '#89959c' }}/></span><strong>{item.count}</strong><small className={item.overdue ? 'overview-overdue' : ''}>{item.overdue ? `逾期 ${item.overdue}` : '—'}</small>
  </button>)}</div>{data.assignees.length > 8 && <Button mt="sm" size="compact-xs" variant="subtle" onClick={() => setExpanded(value => !value)}>{expanded ? '收起' : `查看全部 ${data.assignees.length} 个分组`}</Button>}</>;
}

function TaskWidget({ kind, data, go }: { kind: 'attention' | 'upcoming' | 'unassigned'; data: OverviewData; go: Go }) {
  const items = data[kind];
  const total = data.summary[kind];
  const selection: Selection = kind === 'unassigned' ? { focus: 'unfinished', assigneeId: 'unassigned' } : { focus: kind };
  const emptyTitles = { attention: '暂无需要关注的任务', upcoming: '未来 7 天暂无到期任务', unassigned: '暂无未分配任务' };
  const reason = (task: OverviewTask) => task.dueDate && task.dueDate < data.today ? '逾期' : task.priority === 'urgent' ? '紧急' : task.priority === 'high' ? '高优先级' : '即将到期';
  return <><div className="overview-task-list">{items.length ? items.map(task => <button type="button" key={task.id} className="overview-task-item" onClick={() => go(selection, task.id)}>
    <span className="overview-task-identity"><span className="overview-task-number">#{String(task.number).padStart(3, '0')}</span><span className="overview-task-title">{task.title}</span><Badge size="xs" variant="light" color={task.dueDate && task.dueDate < data.today ? 'red' : task.priority === 'urgent' ? 'red' : task.priority === 'high' ? 'orange' : 'gray'}>{kind === 'unassigned' ? priorityLabels[task.priority] : reason(task)}</Badge></span>
    <span className="overview-task-meta"><span>{statusLabels[task.status]} · {task.assigneeName ?? '未分配'}</span><span className={task.dueDate && task.dueDate < data.today ? 'overview-overdue' : ''}>{task.dueDate ? `截止 ${task.dueDate}` : '未设截止日期'}</span></span>
  </button>) : <Empty title={emptyTitles[kind]} detail="这里只展示当前未完成的主任务。"/>}</div><Group justify="space-between" mt="sm"><Text size="xs" c="dimmed">共 {total} 项{total > items.length ? `，展示前 ${items.length} 项` : ''}</Text><Button size="compact-xs" variant="subtle" rightSection={<IconArrowUpRight size={13}/>} onClick={() => go(selection)}>查看全部</Button></Group></>;
}

function LayoutEditor({ projectId, initial, version, close, saved, reload }: { projectId: string; initial: OverviewLayout; version: number; close: () => void; saved: () => void; reload: () => void }) {
  const [draft, setDraft] = useState<OverviewLayout>(() => structuredClone(initial));
  const [adding, setAdding] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const pending = useRef<{ signature: string; operationId: string } | null>(null);
  const changed = JSON.stringify(draft) !== JSON.stringify(initial);
  useEffect(() => registerDirty(() => changed), [changed]);
  function move(index: number, delta: number) {
    setDraft(current => { const widgets = [...current.widgets]; [widgets[index], widgets[index + delta]] = [widgets[index + delta], widgets[index]]; return { ...current, widgets }; });
  }
  const available = overviewWidgetKinds.filter(kind => !draft.widgets.some(widget => widget.kind === kind));
  return <Modal opened onClose={busy ? () => {} : close} title="配置项目概览" size="lg" closeOnClickOutside={!busy} closeOnEscape={!busy} withCloseButton={!busy}>
    <Stack gap="md"><Text size="sm" c="dimmed">项目成员共用此布局，保存后生效。最多添加 6 个模块。</Text><Failure error={error}/>{conflict && <Button variant="default" onClick={reload}>读取最新布局</Button>}
      <Group grow align="flex-start"><Select label="页面列数" data={[{ value: '1', label: '单列' }, { value: '2', label: '双列' }]} value={String(draft.columns)} disabled={busy} onChange={value => setDraft(current => ({ ...current, columns: value === '1' ? 1 : 2 }))}/><Select label="布局模板" placeholder="选择模板" value={null} disabled={busy} data={[1, 2, 4, 6].map(count => ({ value: String(count), label: `${count} 个模块` }))} onChange={value => { if (value) { const count = Number(value); setDraft({ columns: count === 1 ? 1 : 2, widgets: overviewWidgetKinds.slice(0, count).map(kind => ({ kind, width: 'half' })) }); } }}/></Group>
      <ol className="overview-layout-items">{draft.widgets.map((widget, index) => <li key={widget.kind}><div className="overview-layout-item-title"><span>{index + 1}</span><Text size="sm" fw={600}>{widgetInfo[widget.kind].title}</Text></div><div className="overview-layout-item-actions"><Select aria-label={`${widgetInfo[widget.kind].title}宽度`} size="xs" data={[{ value: 'half', label: '单列宽度' }, { value: 'full', label: '占满一行' }]} value={widget.width} disabled={busy || draft.columns === 1} onChange={value => setDraft(current => ({ ...current, widgets: current.widgets.map(item => item.kind === widget.kind ? { ...item, width: value === 'full' ? 'full' : 'half' } : item) }))}/><ActionIcon variant="default" aria-label={`上移${widgetInfo[widget.kind].title}`} disabled={busy || index === 0} onClick={() => move(index, -1)}><IconArrowUp size={15}/></ActionIcon><ActionIcon variant="default" aria-label={`下移${widgetInfo[widget.kind].title}`} disabled={busy || index === draft.widgets.length - 1} onClick={() => move(index, 1)}><IconArrowDown size={15}/></ActionIcon><ActionIcon color="red" variant="subtle" aria-label={`移除${widgetInfo[widget.kind].title}`} disabled={busy || draft.widgets.length === 1} onClick={() => setDraft(current => ({ ...current, widgets: current.widgets.filter(item => item.kind !== widget.kind) }))}><IconTrash size={15}/></ActionIcon></div></li>)}</ol>
      <Group align="flex-end" wrap="nowrap"><Select label="添加模块" placeholder={available.length ? '选择需要的模块' : '已添加全部模块'} data={available.map(kind => ({ value: kind, label: widgetInfo[kind].title }))} value={adding} onChange={setAdding} disabled={busy || !available.length} className="overview-add-select"/><Button variant="default" leftSection={<IconPlus size={14}/>} disabled={busy || !adding || !available.includes(adding as OverviewWidgetKind)} onClick={() => { if (adding && available.includes(adding as OverviewWidgetKind)) setDraft(current => ({ ...current, widgets: [...current.widgets, { kind: adding as OverviewWidgetKind, width: 'half' }] })); setAdding(null); }}>添加</Button></Group>
      <Text size="xs" c="dimmed">至少保留一个模块。双列布局支持 3 个或 5 个模块；手机始终按单列显示。</Text>
      <Group justify="space-between" mt="xs"><Button variant="subtle" color="gray" disabled={busy} onClick={() => { setDraft(structuredClone(defaultOverviewLayout)); setAdding(null); }}>恢复默认</Button><Group gap="xs"><Button variant="default" disabled={busy} onClick={close}>取消</Button><Button disabled={!changed || conflict} loading={busy} onClick={async () => {
        setBusy(true); setError('');
        const body = { layout: draft, expectedVersion: version }; const signature = JSON.stringify(body);
        if (!pending.current || pending.current.signature !== signature) pending.current = { signature, operationId: crypto.randomUUID() };
        try { await api(`/projects/${projectId}/overview/layout`, { method: 'PUT', body, operationId: pending.current.operationId }); saved(); }
        catch (error) { setError(errorText(error)); setConflict(error instanceof ApiError && error.code === 'VERSION_CONFLICT'); }
        finally { setBusy(false); }
      }}>保存布局</Button></Group></Group>
    </Stack>
  </Modal>;
}
