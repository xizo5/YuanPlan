import { sql } from 'drizzle-orm';
import type { TaskFocus } from '@yuanplan/contracts';

export function shiftDate(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

// Both overview counts and the task list use this predicate, with task alias t.
export function taskFocusCondition(focus: TaskFocus, today: string) {
  const unfinished = sql`t.status <> 'done'`;
  if (focus === 'unfinished') return unfinished;
  if (focus === 'overdue') return sql`${unfinished} AND t.due_date < ${today}::date`;
  if (focus === 'upcoming') return sql`${unfinished} AND t.due_date BETWEEN ${today}::date AND ${shiftDate(today, 7)}::date`;
  return sql`${unfinished} AND (t.due_date <= ${shiftDate(today, 7)}::date OR t.priority IN ('high', 'urgent'))`;
}
