import { sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  defaultOverviewLayout, overviewLayoutSchema, priorities, statuses, taskInput,
  type OverviewLayout, type OverviewTask, type ProjectOverview, type Task,
} from '@yuanplan/contracts';
import { one, rows } from '../db/index.js';
import { audit, checkVersion, mutate, read, type Actor } from './core.js';
import { shiftDate, taskFocusCondition } from './task-focus.js';

const querySchema = z.object({
  timeZone: z.string().min(1).max(100).default('UTC').refine(value => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
  }, '时区无效'),
});
const saveSchema = z.object({ layout: overviewLayoutSchema, expectedVersion: z.number().int().min(0) }).strict();
type LayoutRecord = { layout: OverviewLayout; version: number };
type Group = {
  status: Task['status']; priority: Task['priority']; assigneeId: string | null; name: string;
  count: number; overdue: number; upcoming: number; attention: number;
};

export async function projectOverview(actor: Actor, projectId: string, input: unknown = {}): Promise<ProjectOverview> {
  const { timeZone } = querySchema.parse(input);
  return read(actor, projectId, async tx => {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    const part = (type: string) => parts.find(value => value.type === type)!.value;
    const today = `${part('year')}-${part('month')}-${part('day')}`;
    const upcomingTo = shiftDate(today, 7);
    const scope = sql`t.project_id=${projectId} AND t.parent_id IS NULL AND t.deleted_at IS NULL AND t.archived_at IS NULL`;
    const [saved, groups] = await Promise.all([
      one<LayoutRecord>(tx, sql`SELECT layout,version FROM project_overviews WHERE project_id=${projectId}`),
      rows<Group>(tx, sql`SELECT t.status,t.priority,t.assignee_id,coalesce(u.name,'未分配') name,
        count(*)::int count,
        count(*) FILTER(WHERE ${taskFocusCondition('overdue', today)})::int overdue,
        count(*) FILTER(WHERE ${taskFocusCondition('upcoming', today)})::int upcoming,
        count(*) FILTER(WHERE ${taskFocusCondition('attention', today)})::int attention
        FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id WHERE ${scope}
        GROUP BY t.status,t.priority,t.assignee_id,u.name`),
    ]);
    const layout = saved?.layout ?? defaultOverviewLayout;
    const summary = { total: 0, completed: 0, unfinished: 0, overdue: 0, upcoming: 0, attention: 0, unassigned: 0 };
    const statusCounts = new Map(statuses.map(status => [status, 0]));
    const priorityCounts = new Map(priorities.map(priority => [priority, 0]));
    const assigneeCounts = new Map<string | null, ProjectOverview['assignees'][number]>();
    for (const group of groups) {
      summary.total += group.count;
      statusCounts.set(group.status, statusCounts.get(group.status)! + group.count);
      summary.overdue += group.overdue; summary.upcoming += group.upcoming; summary.attention += group.attention;
      if (group.status === 'done') { summary.completed += group.count; continue; }
      summary.unfinished += group.count;
      if (!group.assigneeId) summary.unassigned += group.count;
      priorityCounts.set(group.priority, priorityCounts.get(group.priority)! + group.count);
      const value = assigneeCounts.get(group.assigneeId) ?? { assigneeId: group.assigneeId, name: group.name, count: 0, overdue: 0 };
      value.count += group.count; value.overdue += group.overdue;
      assigneeCounts.set(group.assigneeId, value);
    }
    const taskList = (kind: 'attention' | 'upcoming' | 'unassigned') => {
      if (!layout.widgets.some(widget => widget.kind === kind)) return Promise.resolve([] as OverviewTask[]);
      const condition = kind === 'unassigned' ? sql`t.status <> 'done' AND t.assignee_id IS NULL` : taskFocusCondition(kind, today);
      return rows<OverviewTask>(tx, sql`SELECT t.id,t.number,t.title,t.status,t.priority,t.due_date::text due_date,u.name assignee_name
        FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id WHERE ${scope} AND ${condition}
        ORDER BY CASE WHEN t.due_date < ${today}::date THEN 0 ELSE 1 END,
        CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
        t.due_date NULLS LAST,t.number LIMIT 8`);
    };
    const [attention, upcoming, unassigned] = await Promise.all([taskList('attention'), taskList('upcoming'), taskList('unassigned')]);
    return {
      layout, version: saved?.version ?? 0, asOf: now.toISOString(), today, upcomingTo, summary,
      statuses: statuses.map(status => ({ status, count: statusCounts.get(status)! })),
      priorities: priorities.map(priority => ({ priority, count: priorityCounts.get(priority)! })),
      assignees: [...assigneeCounts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name) || (a.assigneeId ?? '').localeCompare(b.assigneeId ?? '')),
      attention, upcoming, unassigned,
    };
  });
}

export async function saveOverviewLayout(actor: Actor, projectId: string, input: unknown, operationId: string): Promise<LayoutRecord> {
  const data = saveSchema.parse(input);
  return mutate(actor, projectId, 'admin', operationId, { action: 'configure_overview', ...data }, async ctx => {
    const stored = await one<LayoutRecord>(ctx.tx, sql`SELECT layout,version FROM project_overviews WHERE project_id=${projectId} FOR UPDATE`);
    const before = stored ?? { layout: defaultOverviewLayout, version: 0 };
    checkVersion(before, data.expectedVersion);
    const after = (await one<LayoutRecord>(ctx.tx, sql`INSERT INTO project_overviews(project_id,layout)
      VALUES(${projectId},${JSON.stringify(data.layout)}::jsonb)
      ON CONFLICT(project_id) DO UPDATE SET layout=excluded.layout,version=project_overviews.version+1,updated_at=now()
      RETURNING layout,version`))!;
    await audit(ctx, 'project_overview', projectId, 'configure', before, after);
    return after;
  });
}
