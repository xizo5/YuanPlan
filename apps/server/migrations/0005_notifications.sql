-- Domain events, personal inbox, and channel delivery state have independent lifecycles.
CREATE TABLE notification_events (
  id uuid PRIMARY KEY,
  event_type text NOT NULL,
  schema_version integer NOT NULL DEFAULT 1 CHECK(schema_version > 0),
  project_id uuid NOT NULL REFERENCES projects(id),
  task_id uuid NOT NULL REFERENCES tasks(id),
  comment_id uuid REFERENCES comments(id),
  actor_id text NOT NULL REFERENCES users(id),
  source text NOT NULL CHECK(source IN ('web','mcp','system')),
  operation_id uuid NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(actor_id,operation_id,event_type,task_id)
);
CREATE TABLE notifications (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES notification_events(id),
  recipient_id text NOT NULL REFERENCES users(id),
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(event_id,recipient_id)
);
CREATE INDEX notifications_recipient_page_idx ON notifications(recipient_id,created_at DESC,id DESC);
CREATE INDEX notifications_unread_idx ON notifications(recipient_id,created_at DESC) WHERE read_at IS NULL;
CREATE TABLE notification_deliveries (
  id uuid PRIMARY KEY,
  notification_id uuid NOT NULL REFERENCES notifications(id),
  channel text NOT NULL,
  destination_key text NOT NULL,
  status text NOT NULL CHECK(status IN ('pending','processing','delivered','failed','cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  next_attempt_at timestamptz,
  lease_until timestamptz,
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(notification_id,channel,destination_key)
);
CREATE INDEX notification_deliveries_pending_idx ON notification_deliveries(next_attempt_at,id) WHERE status IN ('pending','processing');
