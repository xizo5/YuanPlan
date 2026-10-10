import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { calendarDateSchema, taskFocuses } from '@yuanplan/contracts';
import { taskFocusCondition } from './task-focus.js';

export type TaskQuery = {
  cursor?: string; query?: string; status?: string; assigneeId?: string; priority?: string; label?: string;
  parentId?: string; roots?: boolean; archived?: boolean; deleted?: boolean; dueFrom?: string; dueTo?: string;
  attachTo?: string; focus?: string; asOfDate?: string;
};

export function taskQueryScope(projectId: string, options: TaskQuery) {
  for (const date of [options.dueFrom, options.dueTo]) if (date) calendarDateSchema.parse(date);
  const focus = options.focus ? z.enum(taskFocuses).parse(options.focus) : undefined;
  const asOfDate = focus ? calendarDateSchema.parse(options.asOfDate) : undefined;
  const keyword = options.query?.slice(0, 200).replace(/[\\%_]/g, '\\$&');
  return sql`t.project_id=${projectId}
    AND ${options.deleted ? sql`t.deleted_at IS NOT NULL` : sql`t.deleted_at IS NULL`}
    ${options.archived ? sql`AND t.archived_at IS NOT NULL` : options.deleted ? sql`` : sql`AND t.archived_at IS NULL`}
    ${options.status ? sql`AND t.status=${options.status}` : sql``}
    ${focus ? sql`AND (${taskFocusCondition(focus, asOfDate!)})` : sql``}
    ${options.assigneeId === 'unassigned' ? sql`AND t.assignee_id IS NULL` : options.assigneeId ? sql`AND t.assignee_id=${options.assigneeId}` : sql``}
    ${options.dueFrom ? sql`AND t.due_date>=${options.dueFrom}::date` : sql``}
    ${options.dueTo ? sql`AND t.due_date<=${options.dueTo}::date` : sql``}
    ${options.priority ? sql`AND t.priority=${options.priority}` : sql``}
    ${options.label ? sql`AND t.labels @> ${JSON.stringify([options.label])}::jsonb` : sql``}
    ${options.parentId ? sql`AND t.parent_id=${options.parentId}` : options.roots ? sql`AND t.parent_id IS NULL` : sql``}
    ${options.attachTo ? sql`AND t.id<>${options.attachTo} AND t.parent_id IS NULL AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id=t.id)` : sql``}
    ${options.query ? sql`AND (t.title ILIKE ${'%' + keyword + '%'} OR t.description::text ILIKE ${'%' + keyword + '%'} OR t.number::text=${options.query.replace(/^#/, '')})` : sql``}`;
}
