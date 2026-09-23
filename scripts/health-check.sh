#!/usr/bin/env bash
#
# Health gate. Polls an environment until it reports ready, or times out.
#
# Used by deploy.sh (before promoting) and rollback.sh (after reverting), and
# runnable by hand to answer "is this environment actually up?".
#
# Usage: ./scripts/health-check.sh <environment> [--expect-commit <sha>] [--timeout <seconds>]

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=scripts/environments.sh
source ./scripts/environments.sh

ENV_NAME="${1:-}"
shift || true
EXPECT_COMMIT=""
TIMEOUT=30

while [ $# -gt 0 ]; do
  case "$1" in
    --expect-commit) EXPECT_COMMIT="${2:-}"; shift 2 ;;
    --timeout)       TIMEOUT="${2:-30}";   shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$ENV_NAME" ]; then
  echo "usage: $0 <environment> [--expect-commit <sha>] [--timeout <seconds>]" >&2
  exit 2
fi
ddj_load_environment "$ENV_NAME"

DEADLINE=$(( $(date +%s) + TIMEOUT ))
LAST_ERROR=""

while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  # Liveness first: a process that is not up yet is a wait, not a failure.
  if ! curl -fsS --max-time 2 "$DDJ_ENV_BASE_URL/health" >/dev/null 2>&1; then
    LAST_ERROR="not listening on $DDJ_ENV_BASE_URL"
    sleep 1
    continue
  fi

  READY_BODY=$(curl -fsS --max-time 3 "$DDJ_ENV_BASE_URL/health/ready" 2>/dev/null || echo "")
  if [ -z "$READY_BODY" ]; then
    # 503 with a body is the normal "degraded" answer. Read it either way so the
    # operator sees which dependency is failing instead of just a timeout.
    READY_BODY=$(curl -sS --max-time 3 "$DDJ_ENV_BASE_URL/health/ready" 2>/dev/null || echo "")
    LAST_ERROR="readiness gate is not ready: ${READY_BODY:-no response}"
    sleep 1
    continue
  fi

  READY_STATUS=$(echo "$READY_BODY" | node -e \
    "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).status)}catch{console.log('')}})" 2>/dev/null || echo "")
  if [ "$READY_STATUS" != "ready" ]; then
    LAST_ERROR="readiness status is '${READY_STATUS:-unparseable}': $READY_BODY"
    sleep 1
    continue
  fi

  if [ -n "$EXPECT_COMMIT" ]; then
    RUNNING_COMMIT=$(curl -fsS --max-time 3 "$DDJ_ENV_BASE_URL/version" 2>/dev/null | node -e \
      "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).commit)}catch{console.log('')}})" 2>/dev/null || echo "")
    # This is what stops a deploy that silently didn't take effect from being
    # reported as a success: the process must be running the commit we shipped.
    if [ "$RUNNING_COMMIT" != "$EXPECT_COMMIT" ]; then
      LAST_ERROR="running commit is ${RUNNING_COMMIT:-unknown}, expected $EXPECT_COMMIT"
      sleep 1
      continue
    fi
  fi

  echo "health gate passed: $ENV_NAME ready at $DDJ_ENV_BASE_URL"
  exit 0
done

echo "health gate FAILED for $ENV_NAME after ${TIMEOUT}s: $LAST_ERROR" >&2
exit 1
