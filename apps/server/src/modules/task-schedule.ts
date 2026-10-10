import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { calendarDateSchema, priorities, statuses, taskFocuses, type ScheduledTask, type TaskSchedulePage } from '@yuanplan/contracts';
import { one, rows } from '../db/index.js';
import { page, paging, read, type Actor } from './core.js';
import { taskQueryScope } from './task-query.js';

const inputSchema = z.object({
  from: calendarDateSchema, to: calendarDateSchema,
  bucket: z.enum(['planned', 'unscheduled']).default('planned'), cursor: z.string().optional(),
  query: z.string().max(200).optional(), status: z.enum(statuses).optional(), priority: z.enum(priorities).optional(),
  assigneeId: z.string().min(1).max(200).optional(), label: z.string().max(40).optional(),
  roots: z.union([z.boolean(), z.enum(['true', 'false'])]).transform(value => value === true || value === 'true').default(false),
  dueFrom: calendarDateSchema.optional(), dueTo: calendarDateSchema.optional(),
  focus: z.enum(taskFocuses).optional(), asOfDate: calendarDateSchema.optional(),
}).refine(value => value.from <= value.to && (Date.parse(value.to) - Date.parse(value.from)) / 86400000 < 120, '日期范围应为 1 至 120 天');

export async function taskSchedule(actor: Actor, projectId: string, input: unknown): Promise<TaskSchedulePage> {
  const options = inputSchema.parse(input);
  const { offset, limit } = paging(options.cursor, 100);
  const scope = taskQueryScope(projectId, options);
  const planned = sql`coalesce(t.start_date,t.due_date) <= ${options.to}::date AND coalesce(t.due_date,t.start_date) >= ${options.from}::date`;
  const unscheduled = sql`t.start_date IS NULL AND t.due_date IS NULL`;
  return read(actor, projectId, async tx => {
    const [counts, items] = await Promise.all([
      one<{ planned: number; unscheduled: number }>(tx, sql`SELECT count(*) FILTER(WHERE ${planned})::int planned,
        count(*) FILTER(WHERE ${unscheduled})::int unscheduled FROM tasks t WHERE ${scope}`),
      rows<ScheduledTask>(tx, sql`SELECT t.id,t.project_id,t.number,t.title,t.status,t.priority,t.assignee_id,t.parent_id,
        t.start_date::text start_date,t.due_date::text due_date,p.number parent_number,p.title parent_title
        FROM tasks t LEFT JOIN tasks p ON p.project_id=t.project_id AND p.id=t.parent_id
        WHERE ${scope} AND (${options.bucket === 'planned' ? planned : unscheduled})
        ORDER BY coalesce(t.start_date,t.due_date) NULLS LAST,t.number,t.id LIMIT ${limit + 1} OFFSET ${offset}`),
    ]);
    return { ...page(items, offset, limit), total: options.bucket === 'planned' ? counts!.planned : counts!.unscheduled, unscheduledTotal: counts!.unscheduled };
  });
}
