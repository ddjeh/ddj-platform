#!/usr/bin/env bash
#
# Tests for the shell tooling in scripts/github-bootstrap.sh.
#
# These exist because of a specific bug: GitHub returns a token's scopes as a
# comma-separated header with a space after each comma ("repo, workflow").
# Splitting the list on the comma alone leaves " workflow", so an exact match on
# "workflow" fails and the script tells a human to add a scope they already
# have. A wrong instruction is worse than no instruction, and it is silent.
#
# The functions are extracted from the real script rather than copied, so these
# tests cannot drift away from the code they describe.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

BOOTSTRAP=scripts/github-bootstrap.sh
[ -f "$BOOTSTRAP" ] || { echo "cannot find $BOOTSTRAP" >&2; exit 1; }

# Pull one function out of the script by name: from `name() {` to the first
# line that is exactly `}`. Good enough for these self-contained helpers.
extract_fn() {
  awk -v fn="$1" '
    $0 == fn "() {" { inside = 1 }
    inside          { print }
    inside && $0 == "}" { exit }
  ' "$BOOTSTRAP"
}

FAILURES=0
CASES=0

# assert_scope <description> <scope-list> <name> <yes|no>
assert_scope() {
  local desc="$1" list="$2" name="$3" want="$4" got
  CASES=$((CASES + 1))
  if has_scope "$list" "$name"; then got=yes; else got=no; fi
  if [ "$got" = "$want" ]; then
    printf '  ok   %s\n' "$desc"
  else
    printf '  FAIL %s\n       has_scope(%s, %s) was %s, expected %s\n' \
      "$desc" "$list" "$name" "$got" "$want"
    FAILURES=$((FAILURES + 1))
  fi
}

FN_SOURCE="$(extract_fn has_scope)"
if [ -z "$FN_SOURCE" ]; then
  echo "  FAIL has_scope is not defined in $BOOTSTRAP (was it renamed?)" >&2
  exit 1
fi
# shellcheck disable=SC1090
eval "$FN_SOURCE"

echo "has_scope"

# The bug: the space after the comma must not defeat the match.
assert_scope "finds a scope listed second"        "repo, workflow"         workflow yes
assert_scope "finds a scope listed third"         "gist, repo, workflow"   workflow yes
assert_scope "finds a scope listed first"         "workflow, repo"         workflow yes
assert_scope "finds a scope when it is the only one" "workflow"            workflow yes

# Guards against over-correcting: trimming spaces must not merge or invent scopes.
assert_scope "does not invent a missing scope"    "repo"                   workflow no
assert_scope "empty list has no scopes"           ""                       workflow no
assert_scope "no substring match"                 "repo, workflows"        workflow no
assert_scope "no prefix match"                    "repo, workflow_thing"   workflow no
assert_scope "matches on the whole scope name"    "repo, workflow"         repo     yes
assert_scope "does not match an unrelated scope"  "repo, workflow"         gist     no

# A fine-grained token sends no scope header at all. The caller treats an empty
# result as "cannot tell" and skips the check, so an empty list must be a
# negative match here, never a positive one.
assert_scope "an empty list matches nothing"      ""                       repo     no

printf '\n%d cases, %d failed\n' "$CASES" "$FAILURES"
[ "$FAILURES" -eq 0 ] || exit 1
