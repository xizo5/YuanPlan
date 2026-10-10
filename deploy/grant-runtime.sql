-- Run as the migration owner after each migration or restore.
GRANT USAGE ON SCHEMA public TO yuanplan_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO yuanplan_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO yuanplan_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events, resource_versions FROM yuanplan_app;
REVOKE ALL ON schema_migrations FROM yuanplan_app;
REVOKE CREATE ON SCHEMA public FROM yuanplan_app;
