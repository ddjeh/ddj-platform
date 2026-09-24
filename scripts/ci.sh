#!/usr/bin/env bash
#
# The CI pipeline, as a script.
#
# GitHub Actions runs this (see .github/workflows/ci.yml) instead of repeating
# the steps in YAML. That means CI can be reproduced exactly on a laptop with
# `pnpm ci`, which is the difference between "it fails in CI" being debuggable
# and being a mystery.
#
# Exits non-zero on the first failing step. Green means every step passed.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Paperclip runs this repo's commands from a Node process that has its own
# npm_* environment. Those leak into child processes and confuse pnpm, so strip
# them. Harmless when they are not set.
unset npm_config_user_agent npm_package_name npm_package_type \
      npm_lifecycle_event npm_lifecycle_script npm_config_registry \
      npm_config_auto_install_peers npm_config_frozen_lockfile \
      pnpm_config_pm_on_fail npm_config_node_gyp \
      npm_config_dangerously_allow_all_scripts npm_config_strict_dep_builds \
      npm_config_manage_package_manager_versions 2>/dev/null || true

# Colour only when a human is watching.
if [ -t 1 ]; then
  BOLD=$'\033[1m'; GREEN=$'\033[32m'; RED=$'\033[31m'; RESET=$'\033[0m'
else
  BOLD=''; GREEN=''; RED=''; RESET=''
fi

STEP=0
step() {
  STEP=$((STEP + 1))
  printf '\n%s[%d] %s%s\n' "$BOLD" "$STEP" "$1" "$RESET"
}
ok() { printf '%s  ok%s %s\n' "$GREEN" "$RESET" "$1"; }
fail() { printf '%s  FAILED%s %s\n' "$RED" "$RESET" "$1"; }

STARTED_AT=$(date +%s)

step "Install dependencies (frozen lockfile)"
# --frozen-lockfile is the point: CI must test the committed lockfile, not
# silently resolve newer versions and pass on a tree nobody has.
pnpm install --frozen-lockfile
ok "dependencies installed"

step "Typecheck"
pnpm typecheck
ok "no type errors"

step "Lint"
pnpm lint
ok "no lint errors"

step "Test"
pnpm test
ok "tests passed"

step "Test the shell tooling"
# The scripts under scripts/ are part of the deploy path, so they are tested
# too. They are bash, so they are tested with bash rather than dragged into the
# TypeScript runner; see scripts/tests/ for what is covered and why.
./scripts/tests/github-bootstrap.test.sh
ok "shell tooling tests passed"

step "Build"
pnpm build
ok "build succeeded"

step "Verify the build reports the commit it was built from"
# Catches the failure where a build silently loses its metadata and would go on
# to deploy something that cannot say which commit it is.
META_FILE=apps/api/build-meta.json
if [ ! -f "$META_FILE" ]; then
  fail "$META_FILE was not produced by the build"
  exit 1
fi
COMMIT=$(node -p "require('./$META_FILE').commit" 2>/dev/null || echo "")
if [ -z "$COMMIT" ] || [ "$COMMIT" = "unknown" ]; then
  fail "$META_FILE does not record a commit"
  exit 1
fi
ok "build records commit ${COMMIT:0:7}"

ELAPSED=$(( $(date +%s) - STARTED_AT ))
printf '\n%sCI passed%s in %ds\n' "$GREEN" "$RESET" "$ELAPSED"
