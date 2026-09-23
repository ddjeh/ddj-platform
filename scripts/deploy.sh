#!/usr/bin/env bash
#
# Deploy a build to an environment.
#
# The shape: cut a new release directory, point `current` at it, restart, then
# gate on the health check. If the gate fails, roll back automatically. A deploy
# that cannot prove it is healthy does not get to stay up.
#
# Releases are immutable and timestamped, and `current` is a symlink. Rollback
# is therefore a symlink move — seconds, and it works when the new build is too
# broken to even start.
#
# Usage: ./scripts/deploy.sh <environment> [--skip-build]
#
# Requires root (writes to /srv, restarts systemd units).

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=scripts/environments.sh
source ./scripts/environments.sh

ENV_NAME="${1:-}"
shift || true
SKIP_BUILD=false
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-build) SKIP_BUILD=true; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$ENV_NAME" ]; then
  echo "usage: $0 <environment> [--skip-build]" >&2
  echo "environments: $(ddj_environment_names)" >&2
  exit 2
fi
ddj_load_environment "$ENV_NAME"

log()  { printf '\n[deploy:%s] %s\n' "$ENV_NAME" "$1"; }
fail() { printf '\n[deploy:%s] FAILED: %s\n' "$ENV_NAME" "$1" >&2; }

if [ "$(id -u)" -ne 0 ]; then
  fail "must run as root (writes to $DDJ_ENV_ROOT and restarts $DDJ_ENV_UNIT)"
  exit 1
fi

# --- Build -------------------------------------------------------------------
if [ "$SKIP_BUILD" = false ]; then
  log "building"
  pnpm install --frozen-lockfile
  pnpm build
fi

META_FILE="apps/api/build-meta.json"
if [ ! -f "$META_FILE" ]; then
  fail "$META_FILE is missing; build first (drop --skip-build)"
  exit 1
fi

COMMIT=$(node -p "require('./$META_FILE').commit" 2>/dev/null || echo "")
BUILT_AT=$(node -p "require('./$META_FILE').builtAt" 2>/dev/null || echo "")
if [ -z "$COMMIT" ] || [ "$COMMIT" = "unknown" ]; then
  fail "build does not record a commit; refusing to deploy an unidentifiable artifact"
  exit 1
fi
SHORT_COMMIT="${COMMIT:0:7}"

# Guard against deploying a tree with uncommitted changes to production. Staging
# tolerates it so a fix can be tested before it is committed.
if [ "$ENV_NAME" = "production" ]; then
  if [ -n "$(git status --porcelain 2>/dev/null || echo '')" ]; then
    fail "working tree is dirty; production deploys must come from a commit"
    exit 1
  fi
fi

# --- Layout ------------------------------------------------------------------
log "preparing $DDJ_ENV_ROOT"
mkdir -p "$DDJ_ENV_RELEASES" "$DDJ_ENV_SHARED" "$DDJ_ENV_LOG_DIR"

RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)-$SHORT_COMMIT"
RELEASE_DIR="$DDJ_ENV_RELEASES/$RELEASE_ID"

# The environment file persists across releases, so it lives in shared/ and is
# never overwritten by a deploy.
#
# Ensured rather than assumed: a host restored from a backup, or an environment
# added since the last setup run, would otherwise deploy a service that starts
# with no database URL and no token — and in staging or production that is a
# refusal to start, after the release directory is already cut.
if [ ! -f "$DDJ_ENV_ENVFILE" ]; then
  log "writing initial environment file"
  ddj_write_env_file
fi

mkdir -p "$RELEASE_DIR"

# Copy the built artifact. Only what the service needs at runtime, so a release
# directory is the running system and nothing else.
log "staging release $RELEASE_ID"
cp -R apps/api/dist "$RELEASE_DIR/api"
cp -R packages/shared/dist "$RELEASE_DIR/shared"
cp "$META_FILE" "$RELEASE_DIR/build-meta.json"
cat > "$RELEASE_DIR/RELEASE" <<EOF
commit=$COMMIT
builtAt=$BUILT_AT
deployedAt=$(date -u +%Y-%m-%dT%H:%M:%SZ)
environment=$ENV_NAME
EOF

# The release needs its own resolvable node_modules, because the service runs
# from /srv and cannot reach the workspace's. Copy the app's manifest — not the
# workspace root's, which declares no runtime dependencies at all — and install
# the `dependencies` it names.
#
# Note this install is not a `pnpm install`: the app's manifest points
# @ddj/shared at `workspace:*`, which only resolves inside the workspace. The
# shared package is already vendored as ./shared above, so the manifest is
# rewritten to reference that copy and a plain npm install is used.
log "installing runtime dependencies"
node -e '
  const fs = require("node:fs");
  const manifest = JSON.parse(fs.readFileSync("apps/api/package.json", "utf8"));
  const deps = { ...(manifest.dependencies ?? {}) };
  if (deps["@ddj/shared"]) deps["@ddj/shared"] = "file:./shared";
  fs.writeFileSync(
    process.argv[1],
    JSON.stringify({ name: manifest.name, version: manifest.version, type: "module", private: true, dependencies: deps }, null, 2) + "\n",
  );
' "$RELEASE_DIR/package.json" || { fail "could not write the release manifest"; exit 1; }

( cd "$RELEASE_DIR" && npm install --omit=dev --no-audit --no-fund --ignore-scripts >/dev/null 2>&1 ) || {
  fail "could not install production dependencies for the release"
  exit 1
}

# Prove the install actually produced the runtime dependencies. An install that
# silently resolves nothing leaves a service that only fails once it is already
# live, which is the failure this whole health gate exists to prevent.
for required in fastify; do
  if [ ! -d "$RELEASE_DIR/node_modules/$required" ]; then
    fail "runtime dependency '$required' is not present in the release after install"
    exit 1
  fi
done

# --- Migrate -----------------------------------------------------------------
#
# Before activation, and therefore before the new code can serve a request. A
# schema that is behind the code is the failure mode where a deploy looks healthy
# and then breaks on the first write.
#
# This runs from the repository rather than from the release directory, and takes
# the environment name: the migrations are the same for every environment, and
# the release directory is an artifact the service runs from, not a place to keep
# operational scripts.
#
# The schema is expected to be compatible with both the outgoing and incoming
# code for at least one release, which is what makes the rollback below safe — a
# rollback restores code, never schema.
log "applying database migrations"
if ! ./scripts/migrate.sh "$ENV_NAME"; then
  fail "migrations did not apply; nothing was activated and $DDJ_ENV_UNIT is still running the previous release"
  exit 1
fi

# --- Activate ----------------------------------------------------------------
PREVIOUS_RELEASE=""
if [ -L "$DDJ_ENV_CURRENT" ]; then
  PREVIOUS_RELEASE=$(readlink -f "$DDJ_ENV_CURRENT" || true)
fi

log "activating $RELEASE_ID (previous: ${PREVIOUS_RELEASE:-none})"
ln -sfn "$RELEASE_DIR" "$DDJ_ENV_CURRENT"

if ! systemctl restart "$DDJ_ENV_UNIT"; then
  fail "could not restart $DDJ_ENV_UNIT"
  exit 1
fi

# --- Health gate -------------------------------------------------------------
log "waiting for the health gate"
if ./scripts/health-check.sh "$ENV_NAME" --expect-commit "$COMMIT" --timeout 45; then
  log "deployed $SHORT_COMMIT to $ENV_NAME"
  log "url: $DDJ_ENV_BASE_URL"
  printf '%s\n' "$RELEASE_ID" > "$DDJ_ENV_ROOT/.last-successful-release"
  exit 0
fi

# --- Automatic rollback ------------------------------------------------------
fail "health gate did not pass; rolling back"
if [ -z "$PREVIOUS_RELEASE" ]; then
  fail "no previous release to roll back to; $DDJ_ENV_UNIT is left running the failed release"
  exit 1
fi

ln -sfn "$PREVIOUS_RELEASE" "$DDJ_ENV_CURRENT"
systemctl restart "$DDJ_ENV_UNIT"

if ./scripts/health-check.sh "$ENV_NAME" --timeout 30; then
  fail "rolled back to $(basename "$PREVIOUS_RELEASE"); $SHORT_COMMIT was not deployed"
else
  fail "rollback to $(basename "$PREVIOUS_RELEASE") also failed to become healthy; manual attention needed"
fi
exit 1
