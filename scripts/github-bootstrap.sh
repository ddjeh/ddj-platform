#!/usr/bin/env bash
#
# Put this repository on GitHub: create it if it does not exist, add the
# remote, push main, then wait for the Actions run that proves CI is live.
#
# This exists so the one-time credential step is the only manual part. Once
# GITHUB_TOKEN is in the environment this is a single idempotent command, and
# running it twice is harmless.
#
# Usage:
#   GITHUB_TOKEN=... ./scripts/github-bootstrap.sh [options]
#
# Options:
#   --owner <owner>         GitHub user or organisation to own the repo.
#                           Defaults to the account the token belongs to.
#   --name <name>           Repository name. Default: ddj-platform
#   --visibility <v>        public | private. Default: public
#   --wait-seconds <n>      How long to wait for the first Actions run.
#                           Default: 180. 0 skips the wait.
#   --dry-run               Print what would happen. No writes, no push.
#
# The token is read from the environment only, and is never written to disk:
# the push goes through a one-shot credential helper rather than a remote URL
# containing the token, because a token in .git/config is a token in every
# backup and every `git remote -v`.
#
# Token requirements: classic PAT with `repo` (create + push) and `workflow`
# (push files under .github/workflows/). Fine-grained tokens cannot be used
# here: they must be scoped to existing repositories, and this one does not
# exist yet.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

OWNER=""
REPO_NAME="ddj-platform"
VISIBILITY="public"
WAIT_SECONDS=180
DRY_RUN=false

while [ $# -gt 0 ]; do
  case "$1" in
    --owner)        OWNER="${2:-}"; shift 2 ;;
    --name)         REPO_NAME="${2:-}"; shift 2 ;;
    --visibility)   VISIBILITY="${2:-}"; shift 2 ;;
    --wait-seconds) WAIT_SECONDS="${2:-}"; shift 2 ;;
    --dry-run)      DRY_RUN=true; shift ;;
    -h|--help)      sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

log()  { printf '\n[github] %s\n' "$1"; }
ok()   { printf '  ok   %s\n' "$1"; }
fail() { printf '\n[github] FAILED: %s\n' "$1" >&2; exit 1; }

case "$VISIBILITY" in
  public)  PRIVATE=false ;;
  private) PRIVATE=true ;;
  *) fail "--visibility must be public or private, got '$VISIBILITY'" ;;
esac

if [ "$DRY_RUN" = false ] && [ -z "${GITHUB_TOKEN:-}" ]; then
  fail "GITHUB_TOKEN is not set.
Create a classic token with 'repo' and 'workflow' scope, add it to Paperclip
as a secret named github_token bound to env.GITHUB_TOKEN, then re-run."
fi

# --- API helpers -------------------------------------------------------------

# Every call goes through this so the token is passed in exactly one place and
# can never be printed. -o/-w keep the body and the status separable.
api() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS -X "$method" -H "Authorization: Bearer $GITHUB_TOKEN"
              -H "Accept: application/vnd.github+json"
              -H "X-GitHub-Api-Version: 2022-11-28"
              -o "$BODY_FILE" -w '%{http_code}')
  if [ -n "$body" ]; then
    args+=(-H "Content-Type: application/json" --data-binary "$body")
  fi
  curl "${args[@]}" "https://api.github.com$path"
}

BODY_FILE="$(mktemp)"
trap 'rm -f "$BODY_FILE"' EXIT

json_field() {
  # Read one string field without assuming jq is installed.
  node -e '
    let raw = "";
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => {
      try {
        const value = JSON.parse(raw)[process.argv[1]];
        if (value === undefined || value === null) process.exit(1);
        process.stdout.write(String(value));
      } catch { process.exit(1); }
    });
  ' "$1" < "$BODY_FILE" 2>/dev/null
}

# --- 1. Who is the token? ----------------------------------------------------

log "Checking the token"
LOGIN=""
if [ "$DRY_RUN" = false ]; then
  STATUS="$(api GET /user)"
  case "$STATUS" in
    200) LOGIN="$(json_field login)" ;;
    401) fail "GitHub rejected the token (401). It is expired, revoked, or not a token." ;;
    403) fail "GitHub refused the token (403). Check its scopes: 'repo' and 'workflow' are required." ;;
    *)   fail "Unexpected response from GitHub /user: HTTP $STATUS" ;;
  esac
  [ -n "$LOGIN" ] || fail "Could not read the token's login from GitHub's response."
  ok "authenticated as $LOGIN"
else
  ok "dry run: skipping authentication"
fi

OWNER="${OWNER:-${LOGIN:-<token-owner>}}"
REPO_SLUG="$OWNER/$REPO_NAME"
ok "target repository: $REPO_SLUG ($VISIBILITY)"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "main" ] || fail "bootstrap expects to push main, but HEAD is on '$BRANCH'."
[ -z "$(git status --porcelain)" ] || fail "the working tree is dirty; commit or stash before pushing."

COMMIT="$(git rev-parse HEAD)"
ok "will push main at ${COMMIT:0:7}"

if [ "$DRY_RUN" = true ]; then
  log "Dry run: nothing was created or pushed"
  printf '  would ensure  https://github.com/%s\n' "$REPO_SLUG"
  printf '  would set     git remote origin -> https://github.com/%s.git\n' "$REPO_SLUG"
  printf '  would push    main (%s) and all tags\n' "${COMMIT:0:7}"
  printf '  would wait    up to %ss for the Actions run on %s\n' "$WAIT_SECONDS" "${COMMIT:0:7}"
  exit 0
fi

# --- 2. Create the repository if it is missing -------------------------------

log "Ensuring the repository exists"
STATUS="$(api GET "/repos/$REPO_SLUG")"
if [ "$STATUS" = "200" ]; then
  ok "already exists"
elif [ "$STATUS" = "404" ]; then
  # An organisation repo is created through a different endpoint than a
  # personal one. Ask GitHub which the owner is rather than guessing.
  OWNER_TYPE=""
  if [ "$(api GET "/users/$OWNER")" = "200" ]; then
    OWNER_TYPE="$(json_field type)"
  fi
  CREATE_PATH="/user/repos"
  if [ "$OWNER_TYPE" = "Organization" ]; then
    CREATE_PATH="/orgs/$OWNER/repos"
    ok "$OWNER is an organisation"
  fi
  CREATE_BODY="$(node -e '
    process.stdout.write(JSON.stringify({
      name: process.argv[1],
      private: process.argv[2] === "private",
      description: "DDJEH engineering baseline: API, shared contracts, CI, deploy path.",
      has_issues: true, has_wiki: false, has_projects: false, auto_init: false,
    }));
  ' "$REPO_NAME" "$VISIBILITY")"
  STATUS="$(api POST "$CREATE_PATH" "$CREATE_BODY")"
  case "$STATUS" in
    201) ok "created https://github.com/$REPO_SLUG" ;;
    403) fail "GitHub refused to create the repo (403). The token needs 'repo' scope, and for an
organisation it needs permission to create repositories in it." ;;
    422) fail "GitHub rejected the repository name '$REPO_NAME' (422). Another repo may already
use that name, or the name is invalid." ;;
    *)   fail "Unexpected response creating the repository: HTTP $STATUS" ;;
  esac
else
  fail "Could not read $REPO_SLUG from GitHub: HTTP $STATUS"
fi

# --- 3. Remote ---------------------------------------------------------------

log "Pointing origin at the repository"
REMOTE_URL="https://github.com/$REPO_SLUG.git"
if git remote get-url origin >/dev/null 2>&1; then
  EXISTING="$(git remote get-url origin)"
  if [ "$EXISTING" = "$REMOTE_URL" ]; then
    ok "origin already set"
  else
    git remote set-url origin "$REMOTE_URL"
    ok "origin moved from $EXISTING"
  fi
else
  git remote add origin "$REMOTE_URL"
  ok "origin added"
fi

# --- 4. Push -----------------------------------------------------------------

log "Pushing main"
# The token is injected by a helper that lives for this one command. Writing it
# into the remote URL instead would persist it in .git/config, which is how
# credentials leak into backups and pasted `git remote -v` output.
if ! git -c credential.helper= \
     -c credential.helper='!f() { echo username=x-access-token; echo "password=${GITHUB_TOKEN}"; }; f' \
     push --quiet --set-upstream origin main; then
  fail "push failed. If GitHub asked for a 'workflow' scope, the token is missing it:
this repository contains files under .github/workflows/, which a token needs
explicit 'workflow' scope to push."
fi
# Tags carry releases; failing to push them is not fatal, so it does not abort.
git -c credential.helper= \
    -c credential.helper='!f() { echo username=x-access-token; echo "password=${GITHUB_TOKEN}"; }; f' \
    push --quiet --tags origin 2>/dev/null || true
ok "pushed ${COMMIT:0:7} to $REPO_SLUG"

# --- 5. Wait for the CI run --------------------------------------------------

if [ "$WAIT_SECONDS" -le 0 ]; then
  log "Skipping the Actions wait (--wait-seconds 0)"
  exit 0
fi

log "Waiting up to ${WAIT_SECONDS}s for the Actions run on ${COMMIT:0:7}"
DEADLINE=$(( $(date +%s) + WAIT_SECONDS ))
RUN_URL=""
RUN_STATUS=""
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  STATUS="$(api GET "/repos/$REPO_SLUG/actions/runs?head_sha=$COMMIT&per_page=1")"
  if [ "$STATUS" = "200" ]; then
    RUN_URL="$(node -e '
      let raw = "";
      process.stdin.on("data", (c) => (raw += c));
      process.stdin.on("end", () => {
        try {
          const run = (JSON.parse(raw).workflow_runs || [])[0];
          if (run) process.stdout.write(run.html_url + "\t" + (run.status || "") + "\t" + (run.conclusion || ""));
        } catch {}
      });
    ' < "$BODY_FILE" 2>/dev/null || true)"
  fi
  if [ -n "$RUN_URL" ]; then
    RUN_STATUS="$(printf '%s' "$RUN_URL" | cut -f2)"
    if [ "$RUN_STATUS" = "completed" ]; then break; fi
  fi
  sleep 5
done

if [ -z "$RUN_URL" ]; then
  fail "no Actions run appeared within ${WAIT_SECONDS}s. Check the Actions tab:
https://github.com/$REPO_SLUG/actions"
fi

RUN_LINK="$(printf '%s' "$RUN_URL" | cut -f1)"
CONCLUSION="$(printf '%s' "$RUN_URL" | cut -f3)"
printf '\n[github] run: %s\n' "$RUN_LINK"
if [ "$RUN_STATUS" != "completed" ]; then
  printf '[github] still running after %ss; open the link for the result.\n' "$WAIT_SECONDS"
elif [ "$CONCLUSION" = "success" ]; then
  printf '[github] CI is green on %s.\n' "${COMMIT:0:7}"
else
  printf '[github] CI concluded %s. Open the link for the failing step.\n' "$CONCLUSION"
  exit 1
fi
