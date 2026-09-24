#!/usr/bin/env bash
#
# Run every shell test in scripts/tests/.
#
# The scripts under scripts/ are part of the deploy path, so they are tested the
# same way the TypeScript is. They are bash, so they are tested with bash rather
# than dragged through vitest.
#
# The glob is the point. A new test is wired into CI by existing, not by someone
# remembering to add it to a list in two other files — which is the way a test
# ends up written, green, and never run.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

shopt -s nullglob
TESTS=(scripts/tests/*.test.sh)

if [ "${#TESTS[@]}" -eq 0 ]; then
  echo "no shell tests found in scripts/tests/ — that is not expected" >&2
  exit 1
fi

for test_script in "${TESTS[@]}"; do
  printf '\n--- %s\n' "$test_script"
  "$test_script"
done

printf '\n%s shell test file(s) passed\n' "${#TESTS[@]}"
