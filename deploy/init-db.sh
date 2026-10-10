#!/usr/bin/env bash
set -euo pipefail
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 <<'SQL'
\getenv migration_password MIGRATION_DB_PASSWORD
\getenv app_password APP_DB_PASSWORD
\getenv database_name POSTGRES_DB
CREATE ROLE yuanplan_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'migration_password';
CREATE ROLE yuanplan_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'app_password';
ALTER DATABASE :"database_name" OWNER TO yuanplan_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO yuanplan_migrator;
GRANT USAGE ON SCHEMA public TO yuanplan_app;
SQL
