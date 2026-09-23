#!/usr/bin/env bash
#
# One-time host setup: create the service accounts, directories, and systemd
# units for every environment.
#
# Idempotent — safe to re-run after changing the unit file or the environment
# registry. It never touches a release or the shared .env, so it cannot disturb
# a running deployment.
#
# Usage: sudo ./scripts/setup-environments.sh

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=scripts/environments.sh
source ./scripts/environments.sh

if [ "$(id -u)" -ne 0 ]; then
  echo "must run as root (creates users and installs systemd units)" >&2
  exit 1
fi

REPO_DIR="$(pwd)"
UNIT_SOURCE="$REPO_DIR/deploy/ddj-api@.service"
UNIT_TARGET="/etc/systemd/system/ddj-api@.service"

if [ ! -f "$UNIT_SOURCE" ]; then
  echo "missing $UNIT_SOURCE" >&2
  exit 1
fi

for ENV_NAME in $(ddj_environment_names); do
  ddj_load_environment "$ENV_NAME"
  echo
  echo "==> $ENV_NAME"

  # A dedicated unprivileged user per environment, so a compromise in one
  # environment does not hand over the other.
  if id "$DDJ_ENV_SERVICE_USER" >/dev/null 2>&1; then
    echo "    user $DDJ_ENV_SERVICE_USER exists"
  else
    useradd --system --no-create-home --shell /usr/sbin/nologin "$DDJ_ENV_SERVICE_USER"
    echo "    created user $DDJ_ENV_SERVICE_USER"
  fi

  mkdir -p "$DDJ_ENV_RELEASES" "$DDJ_ENV_SHARED" "$DDJ_ENV_LOG_DIR"

  if [ ! -f "$DDJ_ENV_ENVFILE" ]; then
    cat > "$DDJ_ENV_ENVFILE" <<EOF
DDJ_ENV=$ENV_NAME
DDJ_PORT=$DDJ_ENV_PORT
DDJ_HOST=$DDJ_ENV_HOST
DDJ_LOG_LEVEL=info
EOF
    chmod 640 "$DDJ_ENV_ENVFILE"
    echo "    wrote $DDJ_ENV_ENVFILE"
  else
    echo "    $DDJ_ENV_ENVFILE exists, left alone"
  fi

  chown -R "$DDJ_ENV_SERVICE_USER:$DDJ_ENV_SERVICE_USER" \
    "$DDJ_ENV_ROOT" "$DDJ_ENV_LOG_DIR"
  chmod 750 "$DDJ_ENV_ROOT" "$DDJ_ENV_RELEASES" "$DDJ_ENV_SHARED" "$DDJ_ENV_LOG_DIR"
  echo "    directories ready under $DDJ_ENV_ROOT"
done

echo
echo "==> installing $UNIT_TARGET"
# `install -m` rather than cp+chmod: one step, and it never leaves the file
# briefly world-writable.
install -m 0644 "$UNIT_SOURCE" "$UNIT_TARGET"

systemctl daemon-reload
echo "    systemd reloaded"

for ENV_NAME in $(ddj_environment_names); do
  ddj_load_environment "$ENV_NAME"
  systemctl enable "$DDJ_ENV_UNIT" >/dev/null 2>&1 || true
  echo "    enabled $DDJ_ENV_UNIT (port $DDJ_ENV_PORT)"
done

echo
echo "Setup complete. Deploy with:"
for ENV_NAME in $(ddj_environment_names); do
  ddj_load_environment "$ENV_NAME"
  echo "  ./scripts/deploy.sh $ENV_NAME     # serves $DDJ_ENV_BASE_URL"
done
