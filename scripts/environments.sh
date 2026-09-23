#!/usr/bin/env bash
#
# The environment registry. One place that says where each environment lives.
#
# Sourced by deploy.sh, rollback.sh, and health-check.sh. Add an environment by
# adding a case branch here, not by editing the scripts.
#
# Ports: staging and production run side by side on the same host, so they bind
# different ports. Everything else about them is identical, which is the point:
# the artifact promoted from staging to production is the same artifact.

# shellcheck shell=bash

ddj_environment_names() {
  echo "staging production"
}

ddj_load_environment() {
  local env_name="$1"

  DDJ_ENV_NAME="$env_name"
  case "$env_name" in
    staging)
      DDJ_ENV_PORT=3001
      # Template unit `ddj-api@.service` instantiated with the environment name,
      # so both environments share one unit definition.
      DDJ_ENV_UNIT="ddj-api@staging"
      DDJ_ENV_SERVICE_USER="ddj-staging"
      ;;
    production)
      DDJ_ENV_PORT=3002
      DDJ_ENV_UNIT="ddj-api@production"
      DDJ_ENV_SERVICE_USER="ddj-production"
      ;;
    *)
      echo "unknown environment: $env_name (expected: $(ddj_environment_names))" >&2
      return 1
      ;;
  esac

  # One database per environment, named after it. Staging and production share a
  # host, so they must not share a database: a staging write must never be able
  # to reach a production row, and that has to be structural rather than a
  # convention someone remembers.
  DDJ_ENV_DATABASE="ddj_$env_name"
  # Name of the variable in the environment's shared .env that holds the API
  # token. The value itself is generated once by setup-environments.sh and is
  # never written into the repository.
  DDJ_ENV_TOKEN_VAR="DDJ_API_TOKEN"

  DDJ_ENV_ROOT="/srv/ddj/$env_name"
  DDJ_ENV_RELEASES="$DDJ_ENV_ROOT/releases"
  DDJ_ENV_CURRENT="$DDJ_ENV_ROOT/current"
  DDJ_ENV_SHARED="$DDJ_ENV_ROOT/shared"
  DDJ_ENV_ENVFILE="$DDJ_ENV_SHARED/.env"
  DDJ_ENV_LOG_DIR="/var/log/ddj/$env_name"
  # Binding loopback by default: the service should not be reachable from the
  # LAN until something in front of it is deliberately put there.
  DDJ_ENV_HOST="${DDJ_BIND_HOST:-127.0.0.1}"
  DDJ_ENV_BASE_URL="${DDJ_BASE_URL:-http://127.0.0.1:$DDJ_ENV_PORT}"

  export DDJ_ENV_NAME DDJ_ENV_PORT DDJ_ENV_UNIT DDJ_ENV_SERVICE_USER \
         DDJ_ENV_ROOT DDJ_ENV_RELEASES DDJ_ENV_CURRENT DDJ_ENV_SHARED \
         DDJ_ENV_ENVFILE DDJ_ENV_LOG_DIR DDJ_ENV_HOST DDJ_ENV_BASE_URL \
         DDJ_ENV_DATABASE DDJ_ENV_TOKEN_VAR
}

# 32 bytes of hex. Hex rather than base64 because the value has to survive being
# written into a shell script, a .env file, a connection string, and an HTTP
# header without ever needing escaping.
ddj_generate_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    # A host without openssl. The kernel's CSPRNG is the same source openssl
    # reads from, so this is not a weaker secret.
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

# The existing value of a key in the environment's .env file, or empty.
ddj_existing_value() {
  # Anchored on the start of the line so DDJ_API_TOKEN does not also match
  # something like DDJ_API_TOKEN_OLD.
  sed -n "s/^$1=//p" "$DDJ_ENV_ENVFILE" 2>/dev/null | head -n 1
}

# Create the environment's service role in Postgres, if it is not already there.
#
# Called by both setup-environments.sh and deploy.sh: a host restored from a
# backup, or an environment added later, should not need a separate step
# remembered in the right order before a deploy can work. Idempotent.
ddj_ensure_database_role() {
  local role_exists
  role_exists="$(sudo -u postgres psql --no-psqlrc -tAc \
    "SELECT 1 FROM pg_roles WHERE rolname = '$DDJ_ENV_SERVICE_USER'" 2>/dev/null || true)"

  if [ "$role_exists" = "1" ]; then
    # The password is re-applied on every run so the role and the .env cannot
    # drift apart — on a restored host the role may exist without the password
    # the file records.
    sudo -u postgres psql --no-psqlrc -q -v ON_ERROR_STOP=1 \
      -c "ALTER ROLE \"$DDJ_ENV_SERVICE_USER\" WITH LOGIN PASSWORD '$1'" >/dev/null
  else
    sudo -u postgres psql --no-psqlrc -q -v ON_ERROR_STOP=1 \
      -c "CREATE ROLE \"$DDJ_ENV_SERVICE_USER\" WITH LOGIN PASSWORD '$1'" >/dev/null
  fi
}

# Write the environment's .env file, generating any secret that is not already
# present and keeping any that is.
#
# The one place this file is written, so deploy.sh and setup-environments.sh can
# never disagree about its contents or about what idempotent means. Rewritten
# wholesale rather than appended to, so it stays a function of this script and
# cannot accumulate stale lines across runs; the secrets are read back first, so
# a rewrite is not a rotation.
#
# Requires: DDJ_ENV_* loaded, and root (it chowns, and it may create the role).
ddj_write_env_file() {
  mkdir -p "$DDJ_ENV_SHARED"

  local token password
  token="$(ddj_existing_value "$DDJ_ENV_TOKEN_VAR")"
  password="$(ddj_existing_value DDJ_DATABASE_PASSWORD)"

  # Rotating either of these breaks a working deployment: a new token logs out
  # every consumer, and a new password breaks a service that is currently
  # serving. So they are generated once and preserved from then on.
  if [ -z "$token" ]; then
    token="$(ddj_generate_secret)"
    echo "    generated a new API token"
  else
    echo "    API token exists, left alone"
  fi

  if [ -z "$password" ]; then
    password="$(ddj_generate_secret)"
    echo "    generated a new database password"
  else
    echo "    database password exists, left alone"
  fi

  ddj_ensure_database_role "$password"

  umask 077
  cat > "$DDJ_ENV_ENVFILE" <<EOF
# Generated by the ddj scripts. Do not edit by hand; re-run
# scripts/setup-environments.sh instead. Not in the repository; never commit it.
DDJ_ENV=$DDJ_ENV_NAME
DDJ_PORT=$DDJ_ENV_PORT
DDJ_HOST=$DDJ_ENV_HOST
DDJ_LOG_LEVEL=info

# Connection string for this environment's own database. Staging and production
# share a host, so they must not share a database.
DDJ_DATABASE_URL=postgres://$DDJ_ENV_SERVICE_USER:$password@127.0.0.1:5432/$DDJ_ENV_DATABASE

# Bearer token required by the authenticated routes.
$DDJ_ENV_TOKEN_VAR=$token

# Kept separately from the URL above so migrate.sh can use it without having to
# parse a connection string back apart.
DDJ_DATABASE_PASSWORD=$password
EOF
  chmod 640 "$DDJ_ENV_ENVFILE"
}
