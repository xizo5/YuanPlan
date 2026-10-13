-- A credential can now cover every project its owner belongs to instead of an explicit list.
-- Membership in project_members is still rechecked on every request, so this widens the
-- credential's reach only within projects the owner can already reach.
ALTER TABLE api_credentials ADD COLUMN all_projects boolean NOT NULL DEFAULT false;
