ALTER TABLE comments DROP CONSTRAINT comments_content_check;
ALTER TABLE comments ADD CONSTRAINT comments_content_length_check CHECK (length(content) <= 10000);

CREATE TABLE comment_attachments (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  comment_id uuid NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES files(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(comment_id, file_id)
);
CREATE INDEX comment_attachments_comment_idx ON comment_attachments(comment_id);
CREATE INDEX comment_attachments_file_idx ON comment_attachments(file_id);
