-- Repair self-assignments made after the notification feature was installed.
-- Earlier task history is intentionally left untouched. This is safe to rerun:
-- operation/event and event/recipient/channel uniqueness prevent duplicates.
WITH created_events AS (
  INSERT INTO notification_events(id,event_type,project_id,task_id,actor_id,source,operation_id,payload)
  SELECT gen_random_uuid(),'task.assigned',a.project_id,t.id,a.actor_id,a.source,a.operation_id,
    jsonb_build_object('actorName','你','taskTitle',v.snapshot->>'title','occurredAt',a.created_at)
  FROM audit_events a
  JOIN resource_versions v ON v.audit_id=a.id
  JOIN tasks t ON t.id::text=a.resource_id
  JOIN projects p ON p.id=a.project_id
  JOIN project_members m ON m.project_id=a.project_id AND m.user_id=a.actor_id
  JOIN users u ON u.id=a.actor_id
  WHERE a.resource_type='task' AND a.operation IN ('create','update')
    AND a.created_at >= (SELECT applied_at FROM schema_migrations WHERE name='0005_notifications.sql')
    AND v.snapshot->>'assigneeId'=a.actor_id
    AND (a.operation='create' OR a.changes ? 'assigneeId')
    AND t.deleted_at IS NULL AND p.deleted_at IS NULL AND NOT u.disabled
    AND NOT EXISTS (
      SELECT 1 FROM notification_events e
      WHERE e.actor_id=a.actor_id AND e.operation_id=a.operation_id
        AND e.task_id=t.id AND e.event_type='task.assigned'
    )
  ON CONFLICT (actor_id,operation_id,event_type,task_id) DO NOTHING
  RETURNING id,actor_id
), created_notifications AS (
  INSERT INTO notifications(id,event_id,recipient_id)
  SELECT gen_random_uuid(),id,actor_id FROM created_events
  ON CONFLICT (event_id,recipient_id) DO NOTHING
  RETURNING id,recipient_id
)
INSERT INTO notification_deliveries(id,notification_id,channel,destination_key,status,delivered_at)
SELECT gen_random_uuid(),id,'in_app',recipient_id,'delivered',clock_timestamp() FROM created_notifications
ON CONFLICT (notification_id,channel,destination_key) DO NOTHING;
