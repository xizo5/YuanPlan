CREATE TABLE users (
 id text PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE,
 email_verified boolean NOT NULL DEFAULT false, image text,
 is_admin boolean NOT NULL DEFAULT false, disabled boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (id text PRIMARY KEY, token text NOT NULL UNIQUE, user_id text NOT NULL REFERENCES users(id), expires_at timestamptz NOT NULL, ip_address text, user_agent text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE TABLE accounts (id text PRIMARY KEY, account_id text NOT NULL, provider_id text NOT NULL, user_id text NOT NULL REFERENCES users(id), access_token text, refresh_token text, id_token text, access_token_expires_at timestamptz, refresh_token_expires_at timestamptz, scope text, password text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(provider_id,account_id));
CREATE TABLE verifications (id text PRIMARY KEY, identifier text NOT NULL, value text NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX verifications_identifier_idx ON verifications(identifier);
CREATE TABLE instance_settings (id integer PRIMARY KEY DEFAULT 1 CHECK(id=1), registration_mode text NOT NULL DEFAULT 'invite' CHECK(registration_mode IN ('invite','open')), maintenance boolean NOT NULL DEFAULT false);
INSERT INTO instance_settings(id) VALUES (1);
CREATE TABLE teams (id uuid PRIMARY KEY, name text NOT NULL, creator_id text NOT NULL REFERENCES users(id), deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE team_members (team_id uuid NOT NULL REFERENCES teams(id), user_id text NOT NULL REFERENCES users(id), role text NOT NULL CHECK(role IN ('admin','member')), PRIMARY KEY(team_id,user_id));
CREATE TABLE projects (id uuid PRIMARY KEY, name text NOT NULL, description text NOT NULL DEFAULT '', team_id uuid REFERENCES teams(id), creator_id text NOT NULL REFERENCES users(id), version integer NOT NULL DEFAULT 1, last_task_number integer NOT NULL DEFAULT 0, archived_at timestamptz, deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE project_members (project_id uuid NOT NULL REFERENCES projects(id), user_id text NOT NULL REFERENCES users(id), role text NOT NULL CHECK(role IN ('admin','member','viewer')), created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(project_id,user_id));
CREATE INDEX project_members_user_idx ON project_members(user_id);
CREATE TABLE invitations (id uuid PRIMARY KEY, target_type text NOT NULL CHECK(target_type IN ('project','team')), project_id uuid REFERENCES projects(id), team_id uuid REFERENCES teams(id), email text NOT NULL, role text NOT NULL CHECK(role IN ('admin','member','viewer')), inviter_id text NOT NULL REFERENCES users(id), token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL, accepted_at timestamptz, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), CHECK ((target_type='project' AND project_id IS NOT NULL AND team_id IS NULL) OR (target_type='team' AND team_id IS NOT NULL AND project_id IS NULL)));
CREATE TABLE tasks (
 id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id), number integer NOT NULL,
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200), description jsonb NOT NULL,
 status text NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','in_progress','in_review','done')),
 priority text NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
 assignee_id text REFERENCES users(id), creator_id text NOT NULL REFERENCES users(id), parent_id uuid,
 start_date date, due_date date, labels jsonb NOT NULL DEFAULT '[]', position double precision NOT NULL DEFAULT 0,
 version integer NOT NULL DEFAULT 1 CHECK(version>0), completed_at timestamptz, archived_at timestamptz, deleted_at timestamptz, deletion_batch uuid,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(project_id,number), UNIQUE(project_id,id),
 FOREIGN KEY(project_id,parent_id) REFERENCES tasks(project_id,id),
 CHECK (parent_id IS NULL OR parent_id <> id), CHECK(start_date IS NULL OR due_date IS NULL OR start_date<=due_date)
);
CREATE INDEX tasks_project_status_idx ON tasks(project_id,status,position,id) WHERE deleted_at IS NULL AND archived_at IS NULL;
CREATE INDEX tasks_parent_idx ON tasks(project_id,parent_id);
CREATE INDEX tasks_assignee_idx ON tasks(assignee_id,project_id);
CREATE TABLE documents (
 id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id), parent_id uuid, title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200), content jsonb NOT NULL, plain_text text NOT NULL DEFAULT '', schema_version integer NOT NULL DEFAULT 1, position double precision NOT NULL DEFAULT 0, version integer NOT NULL DEFAULT 1 CHECK(version>0), creator_id text NOT NULL REFERENCES users(id), deleted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(project_id,id), FOREIGN KEY(project_id,parent_id) REFERENCES documents(project_id,id), CHECK(parent_id IS NULL OR parent_id<>id)
);
CREATE INDEX documents_project_parent_idx ON documents(project_id,parent_id,position);
CREATE TABLE comments (id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id), task_id uuid NOT NULL, author_id text NOT NULL REFERENCES users(id), content text NOT NULL CHECK(length(content) BETWEEN 1 AND 10000), deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(project_id,task_id) REFERENCES tasks(project_id,id));
CREATE INDEX comments_task_idx ON comments(project_id,task_id,created_at);
CREATE TABLE files (id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id), uploader_id text NOT NULL REFERENCES users(id), name text NOT NULL, mime_type text NOT NULL, size integer NOT NULL CHECK(size>0), storage_key text NOT NULL UNIQUE, checksum text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE resource_attachments (id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id), file_id uuid NOT NULL REFERENCES files(id), resource_type text NOT NULL CHECK(resource_type IN ('task','document')), resource_id uuid NOT NULL, removed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE task_document_links (project_id uuid NOT NULL REFERENCES projects(id), task_id uuid NOT NULL, document_id uuid NOT NULL, PRIMARY KEY(task_id,document_id), FOREIGN KEY(project_id,task_id) REFERENCES tasks(project_id,id), FOREIGN KEY(project_id,document_id) REFERENCES documents(project_id,id));
CREATE TABLE api_credentials (id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), name text NOT NULL, token_hash text NOT NULL UNIQUE, prefix text NOT NULL, scope text NOT NULL CHECK(scope IN ('read','write')), expires_at timestamptz, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE credential_projects (credential_id uuid NOT NULL REFERENCES api_credentials(id), project_id uuid NOT NULL REFERENCES projects(id), PRIMARY KEY(credential_id,project_id));
CREATE TABLE audit_events (
 id uuid PRIMARY KEY, project_id uuid REFERENCES projects(id), resource_type text NOT NULL, resource_id text NOT NULL, operation text NOT NULL,
 actor_id text NOT NULL REFERENCES users(id), actor_name text NOT NULL, source text NOT NULL CHECK(source IN ('web','mcp','system')),
 credential_id uuid REFERENCES api_credentials(id), operation_id uuid NOT NULL, before_version integer, after_version integer,
 changes jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_resource_idx ON audit_events(project_id,resource_type,resource_id,created_at DESC,id);
CREATE TABLE resource_versions (id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id), resource_type text NOT NULL CHECK(resource_type IN ('task','document')), resource_id uuid NOT NULL, version integer NOT NULL, snapshot jsonb NOT NULL, audit_id uuid NOT NULL UNIQUE REFERENCES audit_events(id), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(resource_type,resource_id,version));
CREATE INDEX versions_resource_idx ON resource_versions(project_id,resource_type,resource_id,version DESC);
CREATE TABLE operation_receipts (actor_id text NOT NULL REFERENCES users(id), operation_id uuid NOT NULL, request_hash text NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(actor_id,operation_id));
CREATE TABLE recovery_tokens (id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL, consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE FUNCTION reject_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'History is append-only' USING ERRCODE='42501'; END $$;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_events FOR EACH STATEMENT EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER versions_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON resource_versions FOR EACH STATEMENT EXECUTE FUNCTION reject_history_mutation();
