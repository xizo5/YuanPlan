ALTER TABLE teams ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);
CREATE TABLE project_labels (
 id uuid PRIMARY KEY,
 project_id uuid NOT NULL REFERENCES projects(id),
 name text NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
 version integer NOT NULL DEFAULT 1 CHECK (version > 0),
 deleted_at timestamptz,
 UNIQUE (project_id,name)
);
INSERT INTO project_labels(id,project_id,name)
 SELECT gen_random_uuid(),project_id,name FROM
 (SELECT DISTINCT t.project_id,jsonb_array_elements_text(t.labels) AS name FROM tasks t) existing;
