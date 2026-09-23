#!/usr/bin/env node
/**
 * Write apps/api/build-meta.json — the record of which commit this artifact is.
 *
 * Run as part of `build`, before `tsc`, so the file lands in `dist/`'s parent
 * and ships with the artifact. `apps/api/src/build-info.ts` reads it at runtime.
 *
 * Outside git (a tarball, a hand-run build) this writes nothing rather than
 * failing: the service then reports `unknown`, and the deploy health gate is
 * what refuses to put such an artifact into staging or production.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = resolve(repoRoot, 'apps/api/build-meta.json');

/** Read a value from git, or return undefined if git cannot answer. */
function git(args) {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

const commit = git(['rev-parse', 'HEAD']);

if (!commit) {
  console.warn('[write-build-meta] not a git checkout; the service will report its commit as "unknown"');
  process.exit(0);
}

// CI checks out a detached HEAD; the branch is nice to have but never required.
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
const dirty = git(['status', '--porcelain']) ? true : false;

const meta = {
  commit,
  builtAt: new Date().toISOString(),
  ...(branch && branch !== 'HEAD' ? { branch } : {}),
  ...(dirty ? { dirty: true } : {}),
};

writeFileSync(outputPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
console.log(`[write-build-meta] ${commit.slice(0, 7)}${dirty ? ' (dirty)' : ''} -> apps/api/build-meta.json`);
