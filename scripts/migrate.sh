#!/usr/bin/env bash
#
# Apply pending database migrations to an environment.
#
# Run by deploy.sh between unpacking the release and restarting the service, so
# the schema is never behind the code that is about to serve traffic. It is also
# safe to run on its own:
#
#   ./scripts/migrate.sh staging
#   ./scripts/migrate.sh production --dry-run
#
# Design notes, because these are the parts that are expensive to change later:
#
# - Forward-only and numbered. There are no down migrations. A rollback restores
#   the previous *code*, and the schema is expected to be compatible with both —
#   which is why every migration must be additive for at least one release.
# - Each file runs inside a transaction, together with the row that records it.
#   Either the migration and its bookkeeping both land or neither does, so a
#   crash mid-apply cannot leave a migration half-done and unrecorded.
# - The applied set is read from the database, never from a file in the release
#   directory. Releases are immutable and there may be several; the database is
#   the only thing that actually knows what it has had done to it.
#
# Requires root and a passwordless `sudo -u postgres` (see setup-environments.sh).

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=scripts/environments.sh
source ./scripts/environments.sh

ENV_NAME="${1:-}"
shift || true

DRY_RUN=false
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$ENV_NAME" ]; then
  echo "usage: $0 <environment> [--dry-run]" >&2
  echo "environments: $(ddj_environment_names)" >&2
  exit 2
fi
ddj_load_environment "$ENV_NAME"

log()  { printf '\n[migrate:%s] %s\n' "$ENV_NAME" "$1"; }
fail() { printf '\n[migrate:%s] FAILED: %s\n' "$ENV_NAME" "$1" >&2; }

if [ "$(id -u)" -ne 0 ]; then
  fail "must run as root (connects as the postgres superuser)"
  exit 1
fi

MIGRATIONS_DIR="apps/api/migrations"
if [ ! -d "$MIGRATIONS_DIR" ]; then
  fail "$MIGRATIONS_DIR is missing"
  exit 1
fi

# psql as the superuser over the local socket. `-v ON_ERROR_STOP=1` is not
# optional: without it psql prints an error and exits 0, and a migration that
# failed halfway would be recorded as applied.
psql_super() {
  sudo -u postgres psql --no-psqlrc -v ON_ERROR_STOP=1 -q -d "$DDJ_ENV_DATABASE" "$@"
}

log "ensuring $DDJ_ENV_DATABASE exists"
# Created here rather than only in setup-environments.sh so that a host restored
# from a backup, or an environment added later, does not need a separate step
# remembered in the right order.
if ! sudo -u postgres psql --no-psqlrc -tAc \
      "SELECT 1 FROM pg_database WHERE datname = '$DDJ_ENV_DATABASE'" | grep -q 1; then
  # Owner is the environment's own service user, so the running service is not
  # reaching into a database owned by someone else.
  sudo -u postgres createdb -O "$DDJ_ENV_SERVICE_USER" "$DDJ_ENV_DATABASE"
  log "created database $DDJ_ENV_DATABASE"
else
  log "database $DDJ_ENV_DATABASE already exists"
fi

# Close the default CONNECT grant.
#
# PostgreSQL grants CONNECT on a new database to PUBLIC. The staging role could
# therefore open a connection to production's database — and, once there, be
# refused everything, but a connection slot is itself the resource. A
# compromised staging credential draining production's connection pool is a
# denial of service across the environment boundary.
#
# Schema grants already stop a cross-environment read or write; this makes the
# boundary structural rather than a side effect of those grants, which is the
# version that survives someone adding a table without thinking about it.
psql_super <<SQL
REVOKE CONNECT ON DATABASE "$DDJ_ENV_DATABASE" FROM PUBLIC;
GRANT CONNECT ON DATABASE "$DDJ_ENV_DATABASE" TO "$DDJ_ENV_SERVICE_USER";
SQL

# The bookkeeping table lives in the database it describes, for the reason above.
psql_super <<'SQL'
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename    text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);
SQL

# Hand the schema to the environment's own role.
#
# Migrations run as the postgres superuser (they need DDL privileges), so every
# table they create is owned by postgres. The service connects as its own
# unprivileged role, and — since PostgreSQL 15 — `public` is no longer writable
# by every role by default. Without this, the service starts, passes its health
# gate, and then fails its first write with "permission denied for table notes".
#
# `OWNER TO` moves existing objects; `ALTER DEFAULT PRIVILEGES` covers the ones
# future migrations will create, so this fix does not have to be repeated.
psql_super <<SQL
DO \$\$
DECLARE
  obj record;
BEGIN
  FOR obj IN
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO %I', obj.tablename, '$DDJ_ENV_SERVICE_USER');
  END LOOP;
  FOR obj IN
    SELECT sequencename FROM pg_sequences WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER SEQUENCE public.%I OWNER TO %I', obj.sequencename, '$DDJ_ENV_SERVICE_USER');
  END LOOP;
END
\$\$;

-- Future objects created by the superuser in this database are owned by the
-- service role, so a migration that adds a table does not need its own grant.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO "$DDJ_ENV_SERVICE_USER";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO "$DDJ_ENV_SERVICE_USER";

-- And explicitly, for anything the grants above do not reach.
GRANT USAGE, CREATE ON SCHEMA public TO "$DDJ_ENV_SERVICE_USER";
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO "$DDJ_ENV_SERVICE_USER";
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO "$DDJ_ENV_SERVICE_USER";
SQL

APPLIED="$(psql_super -tAc "SELECT filename FROM schema_migrations")"

PENDING=0
for file in "$MIGRATIONS_DIR"/*.sql; do
  [ -e "$file" ] || { fail "no .sql files in $MIGRATIONS_DIR"; exit 1; }
  filename="$(basename "$file")"

  # `grep -qx` on the whole line: a substring match would let `001_notes.sql`
  # suppress `001_notes_extra.sql`, which is the kind of near-miss that gets
  # discovered in production.
  if printf '%s\n' "$APPLIED" | grep -qx -- "$filename"; then
    continue
  fi

  PENDING=$((PENDING + 1))
  if [ "$DRY_RUN" = true ]; then
    log "would apply $filename"
    continue
  fi

  log "applying $filename"
  # The migration and its record go in the same transaction. `psql -1` wraps the
  # whole file, so a failure part-way rolls back both the schema change and the
  # bookkeeping row rather than leaving the two disagreeing.
  psql_super -1 \
    -f "$file" \
    -c "INSERT INTO schema_migrations (filename) VALUES ('$filename')" \
    || { fail "$filename did not apply; no change was made (transaction rolled back)"; exit 1; }
done

if [ "$DRY_RUN" = true ]; then
  log "dry run: $PENDING migration(s) pending"
elif [ "$PENDING" -eq 0 ]; then
  log "schema is up to date; nothing to apply"
else
  log "applied $PENDING migration(s)"
fi
