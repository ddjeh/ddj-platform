#!/usr/bin/env bash
#
# Deploys are manual. This test is what keeps that true.
#
# The board rejected the card that would have wired a deploy target with:
# "per il momento non voglio che si facciano dei deploy in automatico" — no
# automatic deploys for now, to be revisited later. That is a standing
# constraint on this repository, not a one-off answer about one card.
#
# A deploy job added to a workflow would reverse it silently: nothing else in
# the pipeline would fail, and the next person to push to main would ship to an
# environment without anyone deciding to. So the rule is checked here as well
# as written down in docs/release.md.
#
# What "automatic" means: a deploy that runs on its own — on a push, on a
# schedule, or on a file change — with no person deciding to run it.
# A manual `./scripts/deploy.sh production` is exactly what is wanted and is
# unaffected by any of this.
#
# Run: ./scripts/tests/no-auto-deploy.test.sh

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

FAILURES=0
CASES=0

pass() { CASES=$((CASES + 1)); printf '  ok   %s\n' "$1"; }
fail() { CASES=$((CASES + 1)); FAILURES=$((FAILURES + 1)); printf '  FAIL %s\n' "$1"; }

# Everything a deploy job would have to call, plus the hosted-CLI equivalents,
# so the check cannot be dodged by using a provider's CLI instead of our script.
#
# Literal dots are written as [.] rather than \. on purpose: awk expands escapes
# in a -v value, so "deploy\.sh" arrives as "deploy.sh" — a pattern where the dot
# matches any character — and warns about it on every run.
DEPLOY_CALLS='deploy[.]sh|rollback[.]sh|migrate[.]sh|systemctl|flyctl|fly[[:space:]]+deploy|render[[:space:]]+deploy|railway[[:space:]]+up|cloudflared[[:space:]]+tunnel'

echo "workflows"

# A check that passes because it found nothing to check is worse than no check:
# it reads as "verified" while covering nothing. Both of these fail loudly if
# the workflow files move or the pipeline is unwired, so the scan below cannot
# pass vacuously.
WORKFLOW_DIR=.github/workflows
WORKFLOW_FILES=$(find "$WORKFLOW_DIR" -type f \( -name '*.yml' -o -name '*.yaml' \) 2>/dev/null | sort || true)

if [ -n "$WORKFLOW_FILES" ]; then
  pass "found workflow files to check ($(printf '%s\n' "$WORKFLOW_FILES" | wc -l | tr -d ' '))"
else
  fail "no workflow files under $WORKFLOW_DIR — the scan below would cover nothing"
fi

CI_WORKFLOW="$WORKFLOW_DIR/ci.yml"
if [ -f "$CI_WORKFLOW" ] && grep -qE '^[[:space:]]*run:.*scripts/ci\.sh' "$CI_WORKFLOW"; then
  pass "CI still runs the pipeline via scripts/ci.sh"
else
  fail "$CI_WORKFLOW does not call scripts/ci.sh — CI is no longer wired to the pipeline"
fi

# The actual rule. Whole-line comments are skipped first: ci.yml documents the
# deploy job it deliberately does not have, and that prose must not read as a
# violation. Scanning the original lines (rather than a filtered copy) keeps the
# reported line number pointing at the real file.
VIOLATIONS=0
for file in $WORKFLOW_FILES; do
  hits=$(awk -v pat="$DEPLOY_CALLS" '
    /^[[:space:]]*#/ { next }
    $0 ~ pat        { printf "       %s:%d: %s\n", FILENAME, FNR, $0 }
  ' "$file")
  if [ -n "$hits" ]; then
    printf '%s\n' "$hits"
    VIOLATIONS=$((VIOLATIONS + $(printf '%s\n' "$hits" | wc -l | tr -d ' ')))
  fi
done

if [ "$VIOLATIONS" -eq 0 ]; then
  pass "no workflow runs a deploy, rollback, migration, or host CLI"
else
  fail "$VIOLATIONS line(s) in $WORKFLOW_DIR would deploy without a person asking"
fi

echo "host triggers"

# A systemd .path or .timer unit is the other way a deploy starts itself: no
# workflow involved, no visible run, it just fires.
AUTO_UNITS=$(find deploy -type f \( -name '*.path' -o -name '*.timer' \) 2>/dev/null || true)
if [ -z "$AUTO_UNITS" ]; then
  pass "no systemd .path or .timer unit (nothing can trigger itself)"
else
  fail "auto-triggering systemd unit(s) in deploy/: $(printf '%s' "$AUTO_UNITS" | tr '\n' ' ')"
fi

echo "deploy.sh stays explicit"

# The other half of the rule: a deploy must not be reachable by accident. With
# no environment named there is nothing to deploy to, and it says so rather than
# guessing a default. This runs the real script — it exits at the argument check,
# before the root check and before it touches a single file.
set +e
NO_ARG_OUTPUT=$(./scripts/deploy.sh 2>&1)
NO_ARG_STATUS=$?
set -e

if [ "$NO_ARG_STATUS" -eq 2 ] && printf '%s' "$NO_ARG_OUTPUT" | grep -q 'usage:'; then
  pass "deploy.sh refuses with no environment named (exit 2, prints usage)"
else
  fail "deploy.sh with no arguments exited $NO_ARG_STATUS, expected 2 with a usage message
       output: $(printf '%s' "$NO_ARG_OUTPUT" | head -3 | tr '\n' '|')"
fi

printf '\n%d cases, %d failed\n' "$CASES" "$FAILURES"
[ "$FAILURES" -eq 0 ] || exit 1
