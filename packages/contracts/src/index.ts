import { z } from 'zod';

export const statuses = ['todo', 'in_progress', 'in_review', 'done'] as const;
export const statusLabels: Record<TaskStatus, string> = { todo: '待办', in_progress: '进行中', in_review: '待验收', done: '已完成' };
export type TaskStatus = (typeof statuses)[number];
export const priorities = ['low', 'normal', 'high', 'urgent'] as const;
export const priorityLabels = { low: '低', normal: '普通', high: '高', urgent: '紧急' };
export const roles = ['admin', 'member', 'viewer'] as const;
export type Role = (typeof roles)[number];
export const roleLabels: Record<Role, string> = { admin: '管理员', member: '成员', viewer: '只读' };
export const idSchema = z.string().uuid();
export const titleSchema = z.string().trim().min(1, '请输入标题').max(200, '标题最多 200 字');
export const calendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s, '日期无效');
const date = calendarDateSchema.nullable();
export const taskInput = z.object({
  title: titleSchema, description: z.unknown().optional(),
  status: z.enum(statuses).default('todo'), priority: z.enum(priorities).default('normal'),
  assigneeId: z.string().min(1).nullable().default(null), parentId: idSchema.nullable().default(null),
  startDate: date.default(null), dueDate: date.default(null),
  labels: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  position: z.number().finite().min(-1e12).max(1e12).optional(),
}).strict().refine(t => !t.startDate || !t.dueDate || t.startDate <= t.dueDate, '开始日期不能晚于截止日期');
export const documentInput = z.object({ title: titleSchema, content: z.unknown(), parentId: idSchema.nullable().default(null), position: z.number().finite().optional() }).strict();
export const projectInput = z.object({ name: titleSchema, description: z.string().max(2000).default(''), teamId: idSchema.nullable().default(null) }).strict();
export const versionSchema = z.number().int().positive();
export const operationKeySchema = z.string().uuid();
export type TaskInput = z.input<typeof taskInput>;
export type DocumentInput = z.input<typeof documentInput>;
export type JsonDoc = { type: string; content?: JsonDoc[]; text?: string; attrs?: Record<string, unknown>; marks?: { type: string; attrs?: Record<string, unknown> }[] };
export type User = { id: string; name: string; email: string; isAdmin: boolean; disabled: boolean };
export type Project = { id: string; name: string; description: string; teamId: string | null; role: Role; version: number; archivedAt: string | null; deletedAt: string | null; createdAt: string; taskCount?: number; completedCount?: number };
export type Task = { id: string; projectId: string; number: number; title: string; description: JsonDoc; status: TaskStatus; priority: (typeof priorities)[number]; assigneeId: string | null; parentId: string | null; creatorId: string; startDate: string | null; dueDate: string | null; labels: string[]; position: number; version: number; createdAt: string; updatedAt: string; archivedAt: string | null; deletedAt: string | null; completedAt: string | null; parentNumber?: number | null; parentTitle?: string | null; childCount?: number; childDone?: number; projectName?: string };
export type Document = { id: string; projectId: string; title: string; content: JsonDoc; parentId: string | null; version: number; position: number; updatedAt: string; deletedAt: string | null };
export type Member = { userId: string; name: string; email: string; role: Role; disabled: boolean };
export type AuditEvent = { id: string; resourceId: string; resourceType: string; operation: string; actorId: string; actorName: string; source: string; createdAt: string; beforeVersion: number | null; afterVersion: number | null; changes: Record<string, { before: unknown; after: unknown }>; snapshot?: unknown };
export type Page<T> = { items: T[]; nextCursor: string | null };
export type ScheduledTask = Pick<Task, 'id' | 'projectId' | 'number' | 'title' | 'status' | 'priority' | 'assigneeId' | 'parentId' | 'startDate' | 'dueDate' | 'parentNumber' | 'parentTitle'>;
export type TaskSchedulePage = Page<ScheduledTask> & { total: number; unscheduledTotal: number };
export const overviewWidgetKinds = ['status', 'priority', 'assignees', 'attention', 'upcoming', 'unassigned'] as const;
export type OverviewWidgetKind = (typeof overviewWidgetKinds)[number];
export const overviewLayoutSchema = z.object({
  columns: z.union([z.literal(1), z.literal(2)]),
  widgets: z.array(z.object({ kind: z.enum(overviewWidgetKinds), width: z.enum(['half', 'full']) }).strict()).min(1).max(6),
}).strict().refine(layout => new Set(layout.widgets.map(widget => widget.kind)).size === layout.widgets.length, '同一个模块只能添加一次');
export type OverviewLayout = z.infer<typeof overviewLayoutSchema>;
export const defaultOverviewLayout: OverviewLayout = {
  columns: 2, widgets: overviewWidgetKinds.slice(0, 4).map(kind => ({ kind, width: 'half' })),
};
export const taskFocuses = ['unfinished', 'overdue', 'upcoming', 'attention'] as const;
export type TaskFocus = (typeof taskFocuses)[number];
export type OverviewTask = Pick<Task, 'id' | 'number' | 'title' | 'status' | 'priority' | 'dueDate'> & { assigneeName: string | null };
export type ProjectOverview = {
  layout: OverviewLayout; version: number; asOf: string; today: string; upcomingTo: string;
  summary: { total: number; completed: number; unfinished: number; overdue: number; upcoming: number; attention: number; unassigned: number };
  statuses: { status: TaskStatus; count: number }[];
  priorities: { priority: Task['priority']; count: number }[];
  assignees: { assigneeId: string | null; name: string; count: number; overdue: number }[];
  attention: OverviewTask[]; upcoming: OverviewTask[]; unassigned: OverviewTask[];
};
export type NotificationItem = {
  id: string; eventType: 'task.assigned' | 'task.commented';
  projectId: string; taskId: string; actorName: string; taskTitle: string; projectName: string;
  createdAt: string; readAt: string | null;
};
export type NotificationPage = {
  items: NotificationItem[]; total: number; page: number; pageSize: number; unreadCount: number; asOf: string;
};
