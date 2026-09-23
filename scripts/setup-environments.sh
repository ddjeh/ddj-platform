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

# useradd lives in /sbin, which is not on PATH in every environment (containers
# and non-login shells routinely omit it). Resolve it explicitly rather than
# depending on the caller's PATH.
USERADD="$(command -v useradd || true)"
if [ -z "$USERADD" ]; then
  for candidate in /usr/sbin/useradd /sbin/useradd; do
    [ -x "$candidate" ] && USERADD="$candidate" && break
  done
fi
if [ -z "$USERADD" ]; then
  echo "cannot find useradd (looked on PATH, /usr/sbin, /sbin)" >&2
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
    # nologin is not in the same place on every distro; fall back to /bin/false,
    # which exists everywhere and serves the same purpose.
    NOLOGIN=/usr/sbin/nologin
    [ -x "$NOLOGIN" ] || NOLOGIN=/sbin/nologin
    [ -x "$NOLOGIN" ] || NOLOGIN=/bin/false
    "$USERADD" --system --no-create-home --shell "$NOLOGIN" "$DDJ_ENV_SERVICE_USER"
    echo "    created user $DDJ_ENV_SERVICE_USER"
  fi

  mkdir -p "$DDJ_ENV_RELEASES" "$DDJ_ENV_SHARED" "$DDJ_ENV_LOG_DIR"

  # Credentials, the database role, and the environment file. Shared with
  # deploy.sh so the two cannot disagree about what the file contains or about
  # which secrets must survive a re-run.
  echo "    provisioning credentials and $DDJ_ENV_ENVFILE"
  ddj_write_env_file

  # The database itself is created by migrate.sh, which runs before the service
  # restarts. That keeps creation and migration in one place; this script only
  # has to guarantee the role exists to own it.

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
  # Do not swallow this failure. A silently unenabled unit means the service
  # disappears on the next reboot, which is exactly the kind of thing that is
  # discovered at the worst possible moment.
  if systemctl enable "$DDJ_ENV_UNIT" >/dev/null 2>&1; then
    echo "    enabled $DDJ_ENV_UNIT (port $DDJ_ENV_PORT)"
  else
    echo "    WARNING: could not enable $DDJ_ENV_UNIT; it will not start on boot" >&2
    SETUP_FAILED=true
  fi
done

if [ "${SETUP_FAILED:-false}" = true ]; then
  echo
  echo "Setup finished with warnings (see above)." >&2
  exit 1
fi

echo
echo "Setup complete. Deploy with:"
for ENV_NAME in $(ddj_environment_names); do
  ddj_load_environment "$ENV_NAME"
  echo "  ./scripts/deploy.sh $ENV_NAME     # serves $DDJ_ENV_BASE_URL"
done
