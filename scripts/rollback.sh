#!/usr/bin/env bash
#
# Roll an environment back to a previous release.
#
# Deploy already rolls back automatically when its health gate fails. This is
# for the other case: a release that passed its gate and then turned out to be
# wrong. Rollback is a symlink move plus a restart, so it works even when the
# faulty release cannot start at all.
#
# Usage:
#   ./scripts/rollback.sh <environment>              # previous release
#   ./scripts/rollback.sh <environment> --list       # show available releases
#   ./scripts/rollback.sh <environment> --to <id>    # a specific release

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=scripts/environments.sh
source ./scripts/environments.sh

ENV_NAME="${1:-}"
shift || true
TARGET=""
LIST_ONLY=false
while [ $# -gt 0 ]; do
  case "$1" in
    --list) LIST_ONLY=true; shift ;;
    --to)   TARGET="${2:-}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$ENV_NAME" ]; then
  echo "usage: $0 <environment> [--list | --to <release-id>]" >&2
  exit 2
fi
ddj_load_environment "$ENV_NAME"

log()  { printf '\n[rollback:%s] %s\n' "$ENV_NAME" "$1"; }
fail() { printf '\n[rollback:%s] FAILED: %s\n' "$ENV_NAME" "$1" >&2; }

CURRENT_RELEASE=""
if [ -L "$DDJ_ENV_CURRENT" ]; then
  CURRENT_RELEASE=$(readlink -f "$DDJ_ENV_CURRENT" || true)
fi

# Releases are named with a UTC timestamp prefix, so a reverse lexical sort is
# newest-first. No mtime dependency, which is good because `cp -R` rewrites it.
mapfile -t RELEASES < <(ls -1 "$DDJ_ENV_RELEASES" 2>/dev/null | sort -r || true)

if [ "$LIST_ONLY" = true ]; then
  if [ "${#RELEASES[@]}" -eq 0 ]; then
    echo "no releases in $DDJ_ENV_RELEASES"
    exit 0
  fi
  echo "releases in $ENV_NAME (newest first):"
  for release in "${RELEASES[@]}"; do
    marker="  "
    [ "$DDJ_ENV_RELEASES/$release" = "$CURRENT_RELEASE" ] && marker="* "
    release_commit=$(grep -m1 '^commit=' "$DDJ_ENV_RELEASES/$release/RELEASE" 2>/dev/null | cut -d= -f2 || echo "?")
    printf '%s%-32s %s\n' "$marker" "$release" "${release_commit:0:7}"
  done
  echo
  echo "* = currently active"
  exit 0
fi

if [ "${#RELEASES[@]}" -eq 0 ]; then
  fail "no releases available in $DDJ_ENV_RELEASES"
  exit 1
fi

if [ -n "$TARGET" ]; then
  DESTINATION="$DDJ_ENV_RELEASES/$TARGET"
  if [ ! -d "$DESTINATION" ]; then
    fail "no such release: $TARGET (try --list)"
    exit 1
  fi
else
  # Default to the newest release that is not the one currently active.
  DESTINATION=""
  for release in "${RELEASES[@]}"; do
    if [ "$DDJ_ENV_RELEASES/$release" != "$CURRENT_RELEASE" ]; then
      DESTINATION="$DDJ_ENV_RELEASES/$release"
      break
    fi
  done
  if [ -z "$DESTINATION" ]; then
    fail "only one release exists; there is nothing to roll back to"
    exit 1
  fi
fi

if [ "$DESTINATION" = "$CURRENT_RELEASE" ]; then
  log "$(basename "$DESTINATION") is already active; nothing to do"
  exit 0
fi

if [ "$(id -u)" -ne 0 ]; then
  fail "must run as root (moves $DDJ_ENV_CURRENT and restarts $DDJ_ENV_UNIT)"
  exit 1
fi

log "rolling back $(basename "${CURRENT_RELEASE:-none}") -> $(basename "$DESTINATION")"
ln -sfn "$DESTINATION" "$DDJ_ENV_CURRENT"

if ! systemctl restart "$DDJ_ENV_UNIT"; then
  fail "could not restart $DDJ_ENV_UNIT"
  exit 1
fi

if ./scripts/health-check.sh "$ENV_NAME" --timeout 30; then
  log "rolled back; $ENV_NAME is healthy on $(basename "$DESTINATION")"
  exit 0
fi

fail "rolled-back release did not become healthy; manual attention needed"
exit 1
