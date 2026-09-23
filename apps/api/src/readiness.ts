/**
 * Dependency readiness checks.
 *
 * Liveness and readiness are deliberately different questions:
 *
 * - `GET /health` is liveness. "Is this process alive?" It touches nothing
 *   external, so it stays true even when the database is down. Restarting a
 *   process because the database is unreachable is how a transient outage
 *   becomes a crash loop.
 * - `GET /health/ready` is readiness. "Should this process receive traffic?"
 *   It checks dependencies, so a load balancer can drain it without killing it.
 *
 * The deploy script's health gate reads readiness, which is what makes a deploy
 * of a build that cannot reach its database fail instead of going live.
 */

import type { DependencyCheck } from '@ddj/shared';

/** A dependency this process needs in order to serve traffic. */
export interface Dependency {
  readonly name: string;
  /** Resolve when the dependency is usable; reject with a safe-to-display reason. */
  check(): Promise<void>;
}

/** Postgres readiness via a TCP connect and a trivial query. */
export function createPostgresDependency(connectionString: string): Dependency {
  return {
    name: 'postgres',
    async check(): Promise<void> {
      // Imported lazily so the service starts, and liveness stays green, even
      // when the driver is absent or the database is unreachable.
      const { Client } = await import('pg');
      const client = new Client({ connectionString, connectionTimeoutMillis: 2000 });
      try {
        await client.connect();
        await client.query('SELECT 1');
      } finally {
        // Never let a failed connect() leave a socket behind.
        await client.end().catch(() => undefined);
      }
    },
  };
}

/**
 * Run every dependency check, tolerating individual failures.
 *
 * A check that rejects becomes a `fail` entry, not a thrown error: one broken
 * dependency must not hide the state of the others.
 */
export async function runChecks(
  dependencies: readonly Dependency[],
): Promise<ReadonlyArray<DependencyCheck>> {
  return Promise.all(
    dependencies.map(async (dependency): Promise<DependencyCheck> => {
      const startedAt = performance.now();
      try {
        await dependency.check();
        return { name: dependency.name, status: 'ok', durationMs: elapsed(startedAt) };
      } catch (error) {
        return {
          name: dependency.name,
          status: 'fail',
          detail: safeDetail(error),
          durationMs: elapsed(startedAt),
        };
      }
    }),
  );
}

/** Record a dependency that is not configured in this environment. */
export function skippedCheck(name: string): DependencyCheck {
  return { name, status: 'skipped', durationMs: 0 };
}

function elapsed(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

/**
 * Render an error as something an operator can read.
 *
 * Database drivers put the connection string, including its password, into
 * their error messages. This endpoint is reachable without authentication, so
 * the message is scrubbed of anything URL-shaped before it is returned.
 */
function safeDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<redacted-url>');
}
