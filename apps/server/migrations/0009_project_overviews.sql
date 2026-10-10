CREATE TABLE project_overviews (
 project_id uuid PRIMARY KEY REFERENCES projects(id),
 layout jsonb NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version > 0),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK (jsonb_typeof(layout) = 'object')
);
CREATE INDEX tasks_overview_idx ON tasks(project_id,due_date)
 WHERE parent_id IS NULL AND deleted_at IS NULL AND archived_at IS NULL;
