/**
 * Build metadata, injected at build time and read at process start.
 *
 * Why this exists: "which commit is actually running in production?" should
 * never be a question answered by guesswork. The build writes
 * `build-meta.json` next to the compiled output; this module reads it back.
 *
 * The contract version is *not* read from that file. It is imported from
 * `@ddj/shared`, so the number the service reports is always the number its
 * compiled code was actually built against. A stale JSON file can then only get
 * the commit wrong, never the contract, and the two disagreeing is what the
 * test suite catches.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CONTRACT_VERSION, type BuildInfo, type Environment } from '@ddj/shared';

/** Service identifier reported in `BuildInfo.service`. */
export const SERVICE_NAME = '@ddj/api';

/** Reported when a build is produced outside git, e.g. from a tarball. */
export const UNKNOWN_COMMIT = 'unknown';

/** Shape of the generated `build-meta.json`. Written by `scripts/write-build-meta.mjs`. */
interface BuildMeta {
  commit?: string;
  builtAt?: string;
}

/** Where the build script writes `build-meta.json`, relative to this module. */
const BUILD_META_URL = new URL('../build-meta.json', import.meta.url);

function readBuildMeta(): BuildMeta {
  try {
    return JSON.parse(readFileSync(fileURLToPath(BUILD_META_URL), 'utf8')) as BuildMeta;
  } catch (error) {
    // A missing or malformed file is not fatal: the service still runs and
    // reports `unknown`, which is honest and visible rather than a crash loop.
    // The deploy health gate treats `unknown` in staging or production as a
    // failure, so this cannot quietly reach a real environment.
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[build-info] could not read build-meta.json (${reason}); reporting ${UNKNOWN_COMMIT}\n`);
    return {};
  }
}

/** Shorten a git SHA for display, leaving non-SHA values untouched. */
export function shortCommit(commit: string): string {
  return /^[0-9a-f]{7,40}$/i.test(commit) ? commit.slice(0, 7) : commit;
}

/**
 * Build the `BuildInfo` this process reports.
 *
 * @param environment Environment this process is running in; comes from config,
 *   not from the build, because the same artifact is promoted staging -> production.
 * @param version Version from the package manifest.
 * @param meta Override for tests; defaults to reading `build-meta.json`.
 */
export function createBuildInfo(
  environment: Environment,
  version: string,
  meta: BuildMeta = readBuildMeta(),
): BuildInfo {
  const commit = meta.commit && meta.commit !== '' ? meta.commit : UNKNOWN_COMMIT;
  return {
    service: SERVICE_NAME,
    version,
    commit,
    commitShort: shortCommit(commit),
    builtAt: meta.builtAt && meta.builtAt !== '' ? meta.builtAt : 'unknown',
    environment,
    contractVersion: CONTRACT_VERSION,
  };
}
