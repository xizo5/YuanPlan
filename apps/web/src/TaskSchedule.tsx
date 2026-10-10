import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ActionIcon, Badge, Button, Collapse, Group, Modal, Stack, Text, TextInput, Title } from '@mantine/core';
import { IconChevronDown, IconChevronLeft, IconChevronRight, IconRefresh } from '@tabler/icons-react';
import { calendarDateSchema, statusLabels, priorityLabels, statuses, type Member, type ScheduledTask, type TaskSchedulePage } from '@yuanplan/contracts';
import { api, errorText, useData } from './api';
import { Empty, Failure, Loading } from './ui';
import { addDays, calendarRange, dayNumber, datesBetween, localToday, orderTimelineTasks, shiftMonth, taskInterval, tasksOnDay, timelinePosition, timelineRange, weekSegments } from './schedule-layout';

type Mode = 'calendar' | 'timeline';
type Scale = 'day' | 'week';
type Props = {
  projectId: string; query: string; mode: Mode; anchor: string; scale: Scale; revision: number; members: Member[];
  setAnchor: (date: string) => void; setScale: (scale: Scale) => void; open: (id: string) => void; refresh: () => void;
};
const statusColors = { todo: '#a5adb6', in_progress: '#428bce', in_review: '#d49c43', done: '#388367' };
function scheduleLabel(task: ScheduledTask) {
  if (task.startDate && task.dueDate) return `${task.startDate} 至 ${task.dueDate}`;
  return task.startDate ? `开始 ${task.startDate}（未设截止）` : task.dueDate ? `截止 ${task.dueDate}（未设开始）` : '未排期';
}
function taskLabel(task: ScheduledTask) { return `#${task.number} ${task.title} · ${statusLabels[task.status]} · ${priorityLabels[task.priority]} · ${scheduleLabel(task)}${task.parentId ? ` · 子任务，父任务 #${task.parentNumber ?? ''} ${task.parentTitle ?? ''}` : ''}`; }
function taskStyle(task: ScheduledTask): CSSProperties { return { '--schedule-color': statusColors[task.status] } as CSSProperties; }

export default function TaskSchedule(props: Props) {
  const { mode, anchor, scale, setAnchor, setScale, refresh } = props;
  const range = mode === 'calendar' ? calendarRange(anchor) : timelineRange(anchor, scale);
  const path = `/projects/${props.projectId}/task-schedule?${props.query}&${new URLSearchParams(range)}`;
  const previous = () => setAnchor(mode === 'calendar' ? shiftMonth(anchor, -1) : addDays(anchor, scale === 'day' ? -42 : -84));
  const next = () => setAnchor(mode === 'calendar' ? shiftMonth(anchor, 1) : addDays(anchor, scale === 'day' ? 42 : 84));
  return <Stack gap="sm" className="task-schedule">
    <Group justify="space-between" className="schedule-toolbar"><Group gap="sm"><Title order={2} size="sm">{mode === 'calendar' ? '任务日历' : '任务时间线'}</Title><Text size="sm" c="dimmed">{mode === 'calendar' ? `${Number(anchor.slice(0, 4))}年${Number(anchor.slice(5, 7))}月` : `${range.from} — ${range.to}`}</Text></Group><Group gap="xs">
      {mode === 'timeline' && <Button.Group><Button size="compact-xs" aria-pressed={scale === 'day'} variant={scale === 'day' ? 'light' : 'default'} onClick={() => setScale('day')}>日刻度</Button><Button size="compact-xs" aria-pressed={scale === 'week'} variant={scale === 'week' ? 'light' : 'default'} onClick={() => setScale('week')}>周刻度</Button></Button.Group>}
      <ActionIcon variant="default" aria-label={mode === 'calendar' ? '上个月' : '上一段时间'} onClick={previous}><IconChevronLeft size={15}/></ActionIcon>
      {mode === 'timeline' && <TextInput type="date" size="xs" aria-label="时间线定位日期" className="schedule-date-input" value={anchor} onChange={event => { const date = event.currentTarget.value; if (calendarDateSchema.safeParse(date).success) setAnchor(date); }}/ >}
      <Button size="compact-xs" variant="default" onClick={() => setAnchor(localToday())}>今天</Button><ActionIcon variant="default" aria-label={mode === 'calendar' ? '下个月' : '下一段时间'} onClick={next}><IconChevronRight size={15}/></ActionIcon><ActionIcon variant="subtle" aria-label="刷新排期" onClick={refresh}><IconRefresh size={15}/></ActionIcon>
    </Group></Group>
    <ScheduledContent key={`${path}-${mode}-${props.revision}`} {...props} path={path} from={range.from} to={range.to}/>
    <Group gap="md" className="schedule-legend">{statuses.map(status => <Text size="xs" key={status}><span className={`status-dot ${status}`}/>{statusLabels[status]}</Text>)}<Text size="xs" c="dimmed">点击任务进入详情修改日期，保存后更新排期</Text></Group>
  </Stack>;
}

function useSchedulePage(path: string) {
  const q = useData<TaskSchedulePage>(path);
  const [extra, setExtra] = useState<ScheduledTask[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const next = cursor === undefined ? q.data?.nextCursor : cursor;
  const items = [...(q.data?.items ?? []), ...extra];
  async function more() {
    if (!next || busy) return;
    setBusy(true); setError(''); controller.current = new AbortController();
    try { const result = await api<TaskSchedulePage>(`${path}&cursor=${next}`, { signal: controller.current.signal }); setExtra(current => [...current, ...result.items]); setCursor(result.nextCursor); }
    catch (error) { if (!(error instanceof Error && error.name === 'AbortError')) setError(errorText(error)); }
    finally { setBusy(false); }
  }
  return { ...q, items, next, busy, more, pageError: error };
}

function ScheduledContent(props: Props & { path: string; from: string; to: string }) {
  const q = useSchedulePage(props.path);
  const [unplanned, setUnplanned] = useState(false);
  if (q.loading) return <Loading/>;
  if (!q.data) return <Stack><Failure error={q.error}/><Button variant="default" onClick={q.reload}>重新加载排期</Button></Stack>;
  return <>
    <Group justify="space-between"><Text size="xs" c="dimmed">当前日期范围共 {q.data.total} 项任务{q.next ? ` · 已加载 ${q.items.length} 项，加载更多以查看完整排期` : ''}</Text><Button size="compact-xs" variant="subtle" rightSection={<IconChevronDown size={13}/>} aria-expanded={unplanned} aria-controls="unscheduled-tasks" onClick={() => setUnplanned(value => !value)}>未排期任务 · {q.data.unscheduledTotal}</Button></Group>
    <Failure error={q.pageError}/>
    {props.mode === 'calendar' ? <Calendar tasks={q.items} anchor={props.anchor} from={props.from} to={props.to} open={props.open} members={props.members} partial={!!q.next}/> : q.items.length ? <Timeline tasks={q.items} from={props.from} to={props.to} scale={props.scale} open={props.open} members={props.members}/> : <Empty title="这段时间暂无已排期任务" detail="可以切换日期范围，或在下方未排期任务的详情中设置开始、截止日期。"/>}
    {q.next && <Button variant="default" loading={q.busy} onClick={q.more}>加载更多已排期任务（{q.items.length}/{q.data.total}）</Button>}
    <Collapse expanded={unplanned} transitionDuration={0}><section id="unscheduled-tasks" className="schedule-unscheduled"><Title order={3} size="sm" mb="sm">未排期任务</Title>{unplanned && <Unscheduled key={props.path} path={`${props.path}&bucket=unscheduled`} open={props.open} members={props.members}/>}</section></Collapse>
  </>;
}

function Calendar({ tasks, anchor, from, to, open, members, partial }: { tasks: ScheduledTask[]; anchor: string; from: string; to: string; open: (id: string) => void; members: Member[]; partial: boolean }) {
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const days = datesBetween(from, to);
  const today = localToday();
  const weeks = Array.from({ length: days.length / 7 }, (_, index) => days.slice(index * 7, index * 7 + 7));
  return <><div className="task-calendar" aria-label={`${anchor.slice(0, 7)}任务月历`}><div className="calendar-weekdays">{['周一', '周二', '周三', '周四', '周五', '周六', '周日'].map(day => <span key={day}>{day}</span>)}</div>{weeks.map(week => {
    const segments = weekSegments(tasks, week[0]);
    return <div className="calendar-week" key={week[0]}><div className="calendar-days">{week.map((date, index) => {
      const dayTasks = tasksOnDay(tasks, date);
      const overflow = segments.filter(segment => segment.lane >= 3 && segment.column <= index && segment.column + segment.span > index).length;
      return <div key={date} className={`calendar-day ${date.slice(0, 7) !== anchor.slice(0, 7) ? 'calendar-day-outside' : ''} ${index >= 5 ? 'calendar-day-weekend' : ''}`}><button type="button" className={`calendar-day-number ${date === today ? 'calendar-day-today' : ''}`} aria-label={`查看${date}的任务，已加载 ${dayTasks.length} 项`} onClick={() => setSelectedDay(date)}>{Number(date.slice(-2))}</button>{overflow > 0 && <button type="button" className="calendar-overflow" onClick={() => setSelectedDay(date)}>还有 {overflow} 项</button>}{dayTasks.length > 0 && <button type="button" className="calendar-mobile-count" aria-label={`${date}共有 ${dayTasks.length} 项已加载任务`} onClick={() => setSelectedDay(date)}><span>{[...new Set(dayTasks.map(task => task.status))].map(status => <i key={status} style={{ background: statusColors[status] }}/>)}</span>{dayTasks.length} 项</button>}</div>;
    })}</div><div className="calendar-events">{segments.filter(segment => segment.lane < 3).map(segment => <button type="button" key={segment.task.id} className={`calendar-event ${segment.before ? 'calendar-event-before' : ''} ${segment.after ? 'calendar-event-after' : ''} ${taskInterval(segment.task)?.point ? 'calendar-event-point' : ''}`} style={{ ...taskStyle(segment.task), gridColumn: `${segment.column + 1} / span ${segment.span}`, gridRow: segment.lane + 1 }} title={taskLabel(segment.task)} aria-label={taskLabel(segment.task)} onClick={() => open(segment.task.id)}><span>{segment.before ? '‹ ' : ''}{segment.task.parentId ? '↳ ' : ''}{taskInterval(segment.task)?.point ? `${segment.task.startDate ? '开始' : '截止'} · ` : ''}{segment.task.title}{segment.after ? ' ›' : ''}</span></button>)}</div></div>;
  })}</div><Modal opened={!!selectedDay} onClose={() => setSelectedDay(null)} title={selectedDay ? `${selectedDay}的任务` : '当天任务'} size="lg"><Stack gap="xs">{partial && <Text size="xs" c="dimmed">当前展示已加载任务，可返回月历加载更多。</Text>}{selectedDay && tasksOnDay(tasks, selectedDay).map(task => <ScheduleTaskRow key={task.id} task={task} members={members} open={id => { setSelectedDay(null); open(id); }}/ >)}{selectedDay && !tasksOnDay(tasks, selectedDay).length && <Empty title="这天暂无已加载的排期任务"/>}</Stack></Modal></>;
}

function Timeline({ tasks, from, to, scale, open, members }: { tasks: ScheduledTask[]; from: string; to: string; scale: Scale; open: (id: string) => void; members: Member[] }) {
  const days = datesBetween(from, to);
  const tickDays = scale === 'day' ? days : days.filter((_, index) => index % 7 === 0);
  const cell = scale === 'day' ? 34 : 120;
  const width = tickDays.length * cell;
  const today = localToday();
  const todayLeft = today >= from && today <= to ? (dayNumber(today) - dayNumber(from) + .5) / days.length * 100 : null;
  const style = { '--timeline-width': `${width}px`, '--timeline-cell': `${cell}px`, '--timeline-day': `${width / days.length}px` } as CSSProperties;
  return <div className="task-timeline-scroll" tabIndex={0} role="region" aria-label="任务时间线，可横向滚动"><div className="task-timeline" style={style}><div className="timeline-heading"><div className="timeline-task-heading">任务与排期</div><div className="timeline-ticks">{tickDays.map(date => <div key={date} className={`timeline-tick ${scale === 'day' && date === today ? 'timeline-tick-today' : ''}`}><small>{date.slice(5, 7)}月</small><span>{scale === 'day' ? Number(date.slice(-2)) : `${date.slice(5)} — ${addDays(date, 6).slice(5)}`}</span></div>)}</div></div>{orderTimelineTasks(tasks).map(task => {
    const position = timelinePosition(task, from, to)!;
    return <div className="timeline-row" key={task.id}><button type="button" className={`timeline-task-info ${task.parentId ? 'timeline-task-child' : ''}`} title={taskLabel(task)} onClick={() => open(task.id)}><span className="timeline-task-title"><span className={`status-dot ${task.status}`}/><span>#{task.number} {task.title}</span></span><span className="timeline-task-caption">{scheduleLabel(task)} · {members.find(member => member.userId === task.assigneeId)?.name ?? '未分配'}</span>{task.parentId && <span className="timeline-parent-caption">↳ #{task.parentNumber ?? ''} {task.parentTitle}</span>}</button><div className="timeline-track">{todayLeft !== null && <span className="timeline-today-line" style={{ left: `${todayLeft}%` }} aria-hidden="true"/>}<button type="button" title={taskLabel(task)} aria-label={taskLabel(task)} className={`timeline-task-bar ${position.point ? 'timeline-task-point' : ''} ${position.before ? 'timeline-bar-before' : ''} ${position.after ? 'timeline-bar-after' : ''}`} style={{ ...taskStyle(task), left: `${position.left}%`, width: position.point ? undefined : `${position.width}%` }} onClick={() => open(task.id)}>{position.point ? <span aria-hidden="true">◆</span> : <span>{position.before ? '‹ ' : ''}{task.title}{position.after ? ' ›' : ''}</span>}</button></div></div>;
  })}</div></div>;
}

function ScheduleTaskRow({ task, members, open }: { task: ScheduledTask; members: Member[]; open: (id: string) => void }) {
  return <button type="button" className="schedule-task-row" onClick={() => open(task.id)}><span className="schedule-task-row-title"><span className={`status-dot ${task.status}`}/><span>#{task.number} {task.parentId ? '↳ ' : ''}{task.title}</span><Badge size="xs" color={task.priority === 'urgent' ? 'red' : task.priority === 'high' ? 'orange' : 'gray'} variant="light">{priorityLabels[task.priority]}</Badge></span><span className="schedule-task-row-meta">{statusLabels[task.status]} · {members.find(member => member.userId === task.assigneeId)?.name ?? '未分配'} · {scheduleLabel(task)}</span>{task.parentId && <span className="schedule-task-row-meta">父任务 #{task.parentNumber ?? ''} {task.parentTitle}</span>}</button>;
}
function Unscheduled({ path, members, open }: { path: string; members: Member[]; open: (id: string) => void }) {
  const q = useSchedulePage(path);
  if (q.loading) return <Loading/>;
  if (!q.data) return <Stack><Failure error={q.error}/><Button variant="default" onClick={q.reload}>重试未排期任务</Button></Stack>;
  return <Stack gap="xs"><Text size="xs" c="dimmed">符合当前筛选条件、未设置开始和截止日期的任务 · 共 {q.data.total} 项</Text><Failure error={q.pageError}/>{q.items.map(task => <ScheduleTaskRow key={task.id} task={task} members={members} open={open}/>)}{!q.items.length && <Empty title="暂无未排期任务"/>}{q.next && <Button variant="default" loading={q.busy} onClick={q.more}>加载更多未排期任务（{q.items.length}/{q.data.total}）</Button>}</Stack>;
}
