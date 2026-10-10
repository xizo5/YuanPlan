import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, one, rows } from '../db/index.js';
import { liveUser, mutate, type Actor, type Context } from './core.js';
import { assert } from '../lib/errors.js';
import type { NotificationItem } from '@yuanplan/contracts';

type TaskEvent = {
  type: 'task.assigned' | 'task.commented'; taskId: string; taskTitle: string;
  recipientId: string | null; commentId?: string;
};

// Called inside the business transaction. Retries reuse its operation receipt;
// the unique event/recipient/delivery keys additionally prevent duplicate fan-out.
export async function publishTaskNotification(ctx: Context, event: TaskEvent) {
  if (!event.recipientId || (event.type === 'task.commented' && event.recipientId === ctx.actor.userId)) return;
  const recipient = await one(ctx.tx, sql`SELECT u.id FROM users u JOIN project_members m ON m.user_id=u.id
    WHERE u.id=${event.recipientId} AND NOT u.disabled AND m.project_id=${ctx.projectId}`);
  if (!recipient) return;
  const eventId = randomUUID();
  await ctx.tx.execute(sql`INSERT INTO notification_events(id,event_type,project_id,task_id,comment_id,actor_id,source,operation_id,payload)
    VALUES(${eventId},${event.type},${ctx.projectId},${event.taskId},${event.commentId ?? null},${ctx.actor.userId},${ctx.actor.source},${ctx.operationId},
      ${JSON.stringify({ actorName: event.recipientId === ctx.actor.userId ? '你' : ctx.user.name, taskTitle: event.taskTitle })}::jsonb)`);
  const notificationId = randomUUID();
  await ctx.tx.execute(sql`INSERT INTO notifications(id,event_id,recipient_id) VALUES(${notificationId},${eventId},${event.recipientId})`);
  // In-app delivery is immediate and atomic. Future channels enqueue pending
  // deliveries here via a channel policy; network I/O must run in a worker.
  await ctx.tx.execute(sql`INSERT INTO notification_deliveries(id,notification_id,channel,destination_key,status,delivered_at)
    VALUES(${randomUUID()},${notificationId},'in_app',${event.recipientId},'delivered',clock_timestamp())`);
}

function visible(actor: Actor) {
  return sql`n.recipient_id=${actor.userId} AND p.deleted_at IS NULL AND t.deleted_at IS NULL
    AND EXISTS(SELECT 1 FROM project_members m WHERE m.project_id=e.project_id AND m.user_id=${actor.userId})
    AND (e.comment_id IS NULL OR EXISTS(SELECT 1 FROM comments c WHERE c.id=e.comment_id AND c.deleted_at IS NULL))`;
}
const joined = sql`FROM notifications n JOIN notification_events e ON e.id=n.event_id
  JOIN projects p ON p.id=e.project_id JOIN tasks t ON t.id=e.task_id`;
const pageInput = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  status: z.enum(['all', 'unread']).default('all'),
});
async function authorize(actor: Actor) {
  await liveUser(db, actor);
  assert(!actor.credentialId, 403, 'CREDENTIAL_SCOPE', '消息仅限账号本人查看');
}

export async function unreadNotifications(actor: Actor) {
  await authorize(actor);
  return (await one<{ unreadCount: number }>(db, sql`SELECT count(*)::int AS unread_count ${joined}
    WHERE ${visible(actor)} AND n.read_at IS NULL`))!;
}

export async function listNotifications(actor: Actor, input: unknown = {}) {
  const options = pageInput.parse(input);
  await authorize(actor);
  return db.transaction(async tx => {
    const asOf = (await one<{ asOf: string }>(tx, sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS as_of`))!.asOf;
    const scope = visible(actor);
    const counts = (await one<{ total: number; unreadCount: number }>(tx, sql`SELECT count(*)::int AS total,
      count(*) FILTER(WHERE n.read_at IS NULL)::int AS unread_count ${joined} WHERE ${scope}`))!;
    const total = options.status === 'unread' ? counts.unreadCount : counts.total;
    const pageSize = 20;
    const page = Math.min(options.page, Math.max(1, Math.ceil(total / pageSize)));
    const items = await rows<NotificationItem>(tx, sql`SELECT n.id,n.read_at,n.created_at,e.event_type,e.project_id,e.task_id,
      e.payload->>'actorName' AS actor_name,e.payload->>'taskTitle' AS task_title,p.name AS project_name
      ${joined} WHERE ${scope} ${options.status === 'unread' ? sql`AND n.read_at IS NULL` : sql``}
      ORDER BY n.created_at DESC,n.id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`);
    return { items, total, page, pageSize, unreadCount: counts.unreadCount, asOf };
  }, { isolationLevel: 'repeatable read' });
}

export async function markNotificationRead(actor: Actor, id: string, operationId: string) {
  return mutate(actor, null, 'write', operationId, { action: 'notification_read', id }, async ctx => {
    const item = await one(ctx.tx, sql`SELECT n.id ${joined} WHERE n.id=${id} AND ${visible(actor)}`);
    assert(item, 404, 'NOT_FOUND', '消息不存在或无权访问');
    await ctx.tx.execute(sql`UPDATE notifications SET read_at=COALESCE(read_at,clock_timestamp()) WHERE id=${id} AND recipient_id=${actor.userId}`);
    return { ok: true };
  });
}

export async function markAllNotificationsRead(actor: Actor, input: unknown, operationId: string) {
  const { asOf } = z.object({ asOf: z.iso.datetime() }).parse(input);
  assert(new Date(asOf).getTime() <= Date.now() + 5000, 400, 'INVALID_INPUT', '消息时间无效，请刷新后重试');
  return mutate(actor, null, 'write', operationId, { action: 'notifications_read_all', asOf }, async ctx => {
    await ctx.tx.execute(sql`UPDATE notifications SET read_at=clock_timestamp() WHERE id IN
      (SELECT n.id ${joined} WHERE ${visible(actor)} AND n.read_at IS NULL AND n.created_at<=${asOf}::timestamptz)`);
    return { ok: true };
  });
}
