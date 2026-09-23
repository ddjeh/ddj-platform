/**
 * The build-info contract.
 *
 * This is the single definition of what a running service reports about itself.
 * Both the API that serves it and any consumer that reads it import these types
 * and this version, so the two can never drift apart silently.
 *
 * When you change the shape of `BuildInfo`, bump CONTRACT_VERSION. The API's
 * test suite asserts that the contract version it serves matches this constant,
 * which is what makes an accidental breaking change fail CI instead of production.
 */

/**
 * Version of the build-info contract.
 *
 * Bump on any breaking change to `BuildInfo`: removing a field, renaming one,
 * or changing its type. Adding an optional field is not breaking and does not
 * require a bump.
 */
export const CONTRACT_VERSION = '1.0.0' as const;

/** The environments a build can be deployed into. */
export type Environment = 'development' | 'test' | 'staging' | 'production';

/**
 * What a running service reports about the build it is running.
 *
 * Field notes:
 * - `commit` is the git SHA the build was cut from. It is `unknown` only when a
 *   build is produced outside git (a tarball, a hand-run script). CI and the
 *   deploy path always set it, so `unknown` in staging or production is a bug.
 * - `builtAt` is an ISO-8601 timestamp from build time, not process start time.
 */
export interface BuildInfo {
  /** Service name, e.g. `@ddj/api`. */
  readonly service: string;
  /** Version from the package manifest. */
  readonly version: string;
  /** Git SHA the build was cut from, or `unknown`. */
  readonly commit: string;
  /** Short form of `commit`, for display. */
  readonly commitShort: string;
  /** ISO-8601 timestamp of when the artifact was built. */
  readonly builtAt: string;
  /** Environment this process is running in. */
  readonly environment: Environment;
  /** Version of this contract that the process was built against. */
  readonly contractVersion: string;
}

/** Values a service can report for its readiness. */
export type ReadinessStatus = 'ready' | 'degraded';

/**
 * Response body of `GET /health/ready`.
 *
 * `degraded` means the process is up but a dependency it needs is not. The
 * process is still serving; a load balancer should stop sending it new traffic.
 */
export interface ReadinessReport {
  readonly status: ReadinessStatus;
  /** One entry per checked dependency. Empty when no dependencies are configured. */
  readonly checks: ReadonlyArray<DependencyCheck>;
}

/** The result of checking one dependency. */
export interface DependencyCheck {
  /** Dependency name, e.g. `postgres`. */
  readonly name: string;
  /** `skipped` means the dependency is not configured in this environment. */
  readonly status: 'ok' | 'fail' | 'skipped';
  /** Present when `status` is not `ok`. Safe to show an operator; must not leak credentials. */
  readonly detail?: string;
  /** How long the check took, in milliseconds. */
  readonly durationMs: number;
}

/** Response body of `GET /health`. */
export interface LivenessReport {
  readonly status: 'ok';
  /** Process uptime in seconds. */
  readonly uptimeSeconds: number;
}
