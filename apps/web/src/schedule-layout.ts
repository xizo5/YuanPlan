import type { ScheduledTask } from '@yuanplan/contracts';

const DAY = 86400000;
export const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / DAY;
export const dateFromDay = (day: number) => new Date(day * DAY).toISOString().slice(0, 10);
export const addDays = (date: string, days: number) => dateFromDay(dayNumber(date) + days);
export function localToday() { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`; }
export function shiftMonth(date: string, months: number) { const value = new Date(`${date}T00:00:00Z`); return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + months, 1)).toISOString().slice(0, 10); }
export function monday(date: string) { return addDays(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7)); }
export function calendarRange(date: string) { const first = `${date.slice(0, 7)}-01`; return { from: monday(first), to: addDays(monday(addDays(shiftMonth(first, 1), -1)), 6) }; }
export function timelineRange(date: string, scale: 'day' | 'week') { const from = addDays(monday(date), -7); return { from, to: addDays(from, scale === 'day' ? 41 : 83) }; }
export function datesBetween(from: string, to: string) { return Array.from({ length: dayNumber(to) - dayNumber(from) + 1 }, (_, index) => addDays(from, index)); }
export function taskInterval(task: Pick<ScheduledTask, 'startDate' | 'dueDate'>) {
  const start = task.startDate ?? task.dueDate;
  const end = task.dueDate ?? task.startDate;
  return start && end ? { start, end, point: !(task.startDate && task.dueDate) } : null;
}
export function tasksOnDay(tasks: ScheduledTask[], date: string) { return tasks.filter(task => { const range = taskInterval(task); return range && range.start <= date && range.end >= date; }); }
export type CalendarSegment = { task: ScheduledTask; column: number; span: number; lane: number; before: boolean; after: boolean };
export function weekSegments(tasks: ScheduledTask[], from: string): CalendarSegment[] {
  const to = addDays(from, 6);
  const candidates = tasks.flatMap(task => { const range = taskInterval(task); if (!range || range.start > to || range.end < from) return []; const start = range.start < from ? from : range.start; const end = range.end > to ? to : range.end; return [{ task, column: dayNumber(start) - dayNumber(from), span: dayNumber(end) - dayNumber(start) + 1, before: range.start < from, after: range.end > to }]; });
  candidates.sort((a, b) => a.column - b.column || b.span - a.span || a.task.number - b.task.number);
  const lanes: number[] = [];
  return candidates.map(segment => { let lane = lanes.findIndex(end => end < segment.column); if (lane === -1) lane = lanes.length; lanes[lane] = segment.column + segment.span - 1; return { ...segment, lane }; });
}
export function orderTimelineTasks(tasks: ScheduledTask[]) { return [...tasks].sort((a, b) => (a.parentNumber ?? a.number) - (b.parentNumber ?? b.number) || Number(!!a.parentId) - Number(!!b.parentId) || a.number - b.number); }
export function timelinePosition(task: ScheduledTask, from: string, to: string) {
  const interval = taskInterval(task);
  if (!interval || interval.start > to || interval.end < from) return null;
  const days = dayNumber(to) - dayNumber(from) + 1;
  const start = dayNumber(interval.start < from ? from : interval.start) - dayNumber(from);
  const end = dayNumber(interval.end > to ? to : interval.end) - dayNumber(from);
  return { left: (start + (interval.point ? .5 : 0)) / days * 100, width: (end - start + 1) / days * 100, point: interval.point, before: interval.start < from, after: interval.end > to };
}
