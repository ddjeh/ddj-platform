/**
 * The HTTP application.
 *
 * Built as a factory rather than a module-level singleton so tests can construct
 * an app with their own config and dependencies and call `app.inject()`, with no
 * port binding and no teardown races.
 */

import Fastify, { type FastifyInstance } from 'fastify';

import { parseBuildInfo, type BuildInfo, type LivenessReport, type ReadinessReport } from '@ddj/shared';

import { createBuildInfo, SERVICE_NAME } from './build-info.js';
import type { Config } from './config.js';
import { createPostgresDependency, runChecks, skippedCheck, type Dependency } from './readiness.js';

/** Version reported in `BuildInfo.version`; kept in step with package.json by the release check. */
export const SERVICE_VERSION = '0.1.0';

export interface AppOptions {
  readonly config: Config;
  /** Override for tests. Defaults to a Postgres check when `config.databaseUrl` is set. */
  readonly dependencies?: readonly Dependency[];
  /** Override for tests. Defaults to reading `build-meta.json`. */
  readonly buildInfo?: BuildInfo;
}

/** Build the Fastify instance. Does not listen; the caller decides that. */
export function createApp(options: AppOptions): FastifyInstance {
  const { config } = options;
  const buildInfo = options.buildInfo ?? createBuildInfo(config.environment, SERVICE_VERSION);

  // Validated at construction, not per request: a service that cannot describe
  // itself correctly should refuse to start rather than serve a bad answer.
  const validatedBuildInfo = parseBuildInfo(buildInfo);

  const dependencies: readonly Dependency[] =
    options.dependencies ??
    (config.databaseUrl ? [createPostgresDependency(config.databaseUrl)] : []);

  const app = Fastify({
    logger: { level: config.logLevel },
    // Trust the proxy in front of us for client IPs, so logs stay useful
    // whichever environment this artifact was promoted into.
    trustProxy: true,
  });

  const startedAt = performance.now();

  app.get('/health', async (): Promise<LivenessReport> => ({
    status: 'ok',
    uptimeSeconds: Math.round((performance.now() - startedAt) / 1000),
  }));

  app.get('/health/ready', async (_request, reply): Promise<ReadinessReport> => {
    const checks =
      dependencies.length > 0
        ? await runChecks(dependencies)
        : [skippedCheck('none-configured')];
    const healthy = checks.every((check) => check.status !== 'fail');
    // 503 so a load balancer drains the instance without restarting it.
    reply.code(healthy ? 200 : 503);
    return { status: healthy ? 'ready' : 'degraded', checks };
  });

  app.get('/version', async (): Promise<BuildInfo> => validatedBuildInfo);

  app.get('/', async () => ({
    service: SERVICE_NAME,
    environment: config.environment,
    version: validatedBuildInfo.version,
    commit: validatedBuildInfo.commitShort,
    endpoints: ['/health', '/health/ready', '/version'],
  }));

  return app;
}
