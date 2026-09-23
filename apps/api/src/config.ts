/**
 * Configuration, read once at process start.
 *
 * Two rules this module exists to enforce:
 *
 * 1. Every value has a safe default, so the service starts with an empty
 *    environment. A missing variable is never the reason a deploy fails.
 * 2. Configuration is read once and passed around, never re-read from
 *    `process.env` deeper in the code. When something behaves differently in
 *    staging than in production, this is the file you compare.
 */

import type { Environment } from '@ddj/shared';

const ENVIRONMENTS: readonly Environment[] = ['development', 'test', 'staging', 'production'];

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Config {
  readonly environment: Environment;
  readonly port: number;
  readonly host: string;
  readonly logLevel: LogLevel;
  /** Unset means no database is configured; readiness reports `skipped`. */
  readonly databaseUrl: string | undefined;
  /**
   * Token the authenticated routes require.
   *
   * Unset only in `development` and `test`, where the guards are not installed
   * at all. In staging and production a missing token is a startup failure: see
   * `assertAuthConfigured`.
   */
  readonly apiToken: string | undefined;
}

/** Environments that may run without a token. Every other one must have one. */
const TOKENLESS_ENVIRONMENTS: readonly Environment[] = ['development', 'test'];

/**
 * Refuse to run an environment that serves authenticated routes without a token.
 *
 * The alternative is a service that starts happily and treats every request as
 * unauthenticated, or worse, one that treats every request as authorised. Both
 * are silent, and both are discovered by a stranger rather than by us.
 *
 * @throws {ConfigError} when the environment needs a token and has none.
 */
export function assertAuthConfigured(config: Config): void {
  if (TOKENLESS_ENVIRONMENTS.includes(config.environment)) return;
  if (config.apiToken === undefined) {
    throw new ConfigError(
      `DDJ_API_TOKEN must be set in ${config.environment}; refusing to serve authenticated routes without a token`,
    );
  }
}

/** Thrown when the environment is malformed. Fails fast at startup, never at request time. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

function parseEnvironment(raw: string | undefined): Environment {
  const value = raw ?? 'development';
  if (!ENVIRONMENTS.includes(value as Environment)) {
    throw new ConfigError(
      `DDJ_ENV must be one of ${ENVIRONMENTS.join(', ')}; got ${JSON.stringify(value)}`,
    );
  }
  return value as Environment;
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 3000;
  // Number() would accept "8080abc" as NaN and "0x10" as 16; be strict instead.
  if (!/^\d+$/.test(raw)) {
    throw new ConfigError(`DDJ_PORT must be an integer; got ${JSON.stringify(raw)}`);
  }
  const port = Number(raw);
  if (port < 1 || port > 65535) {
    throw new ConfigError(`DDJ_PORT must be between 1 and 65535; got ${port}`);
  }
  return port;
}

function parseLogLevel(raw: string | undefined): LogLevel {
  const value = raw ?? 'info';
  if (!LOG_LEVELS.includes(value as LogLevel)) {
    throw new ConfigError(
      `DDJ_LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}; got ${JSON.stringify(value)}`,
    );
  }
  return value as LogLevel;
}

/**
 * Read configuration from the environment.
 *
 * @param env Defaults to `process.env`; tests pass their own object.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // An explicitly empty DATABASE_URL is treated as "not configured" rather than
  // as an empty connection string, which would fail at connect time with a
  // confusing error.
  const databaseUrl = env['DDJ_DATABASE_URL'];
  const apiToken = env['DDJ_API_TOKEN'];
  return {
    environment: parseEnvironment(env['DDJ_ENV']),
    port: parsePort(env['DDJ_PORT']),
    host: env['DDJ_HOST'] || '127.0.0.1',
    logLevel: parseLogLevel(env['DDJ_LOG_LEVEL']),
    databaseUrl: databaseUrl === undefined || databaseUrl === '' ? undefined : databaseUrl,
    // Same treatment as the database URL above: an empty string is "not
    // configured", not a token that happens to be empty and would never match.
    apiToken: apiToken === undefined || apiToken === '' ? undefined : apiToken,
  };
}
