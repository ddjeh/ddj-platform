/**
 * The HTTP application.
 *
 * Built as a factory rather than a module-level singleton so tests can construct
 * an app with their own config and dependencies and call `app.inject()`, with no
 * port binding and no teardown races.
 */

import Fastify, { type FastifyInstance } from 'fastify';

import {
  ContractError,
  parseBuildInfo,
  parseCreateNoteRequest,
  type ApiErrorBody,
  type BuildInfo,
  type LivenessReport,
  type ReadinessReport,
} from '@ddj/shared';

import { createAuthGuard } from './auth.js';
import { createBuildInfo, SERVICE_NAME } from './build-info.js';
import type { Config } from './config.js';
import { createPostgresNoteRepository, type NoteRepository } from './notes.js';
import { createPostgresDependency, runChecks, skippedCheck, type Dependency } from './readiness.js';

/** Version reported in `BuildInfo.version`; kept in step with package.json by the release check. */
export const SERVICE_VERSION = '0.1.0';

export interface AppOptions {
  readonly config: Config;
  /** Override for tests. Defaults to a Postgres check when `config.databaseUrl` is set. */
  readonly dependencies?: readonly Dependency[];
  /** Override for tests. Defaults to reading `build-meta.json`. */
  readonly buildInfo?: BuildInfo;
  /** Override for tests. Defaults to Postgres when `config.databaseUrl` is set. */
  readonly notes?: NoteRepository;
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

  // --- Notes: the vertical slice -------------------------------------------------
  //
  // One entity, persisted and behind auth, proving the spine is connected. The
  // guards are omitted in `development` and `test` so the API stays usable on a
  // laptop with no .env; `assertAuthConfigured` is what stops that from ever
  // being true of a deployed environment.
  const guards = config.apiToken === undefined ? {} : { onRequest: createAuthGuard(config.apiToken) };
  const repository: NoteRepository | undefined =
    options.notes ??
    (config.databaseUrl === undefined
      ? undefined
      : createPostgresNoteRepository(config.databaseUrl));

  app.get('/notes', guards, async (_request, reply) => {
    if (repository === undefined) {
      // Not an empty list. "There are no notes" and "this service cannot reach
      // its data" look identical to a caller otherwise, and only one of them is
      // worth paging someone about.
      return sendError(reply, 503, 'internal', 'The notes store is not configured in this environment.');
    }
    const notes = await repository.list();
    return { notes };
  });

  app.post('/notes', guards, async (request, reply) => {
    if (repository === undefined) {
      return sendError(reply, 503, 'internal', 'The notes store is not configured in this environment.');
    }

    let body: string;
    try {
      ({ body } = parseCreateNoteRequest(request.body));
    } catch (error) {
      if (error instanceof ContractError) {
        // The parser's message names the offending field, which is exactly what
        // the caller needs and is safe to show: it describes their input, not
        // our internals.
        return sendError(reply, 400, 'validation_failed', error.message);
      }
      throw error;
    }

    const note = await repository.create(body);
    reply.code(201);
    return note;
  });

  app.get('/', async () => ({
    service: SERVICE_NAME,
    environment: config.environment,
    version: validatedBuildInfo.version,
    commit: validatedBuildInfo.commitShort,
    endpoints: ['/health', '/health/ready', '/version', '/notes'],
  }));

  return app;
}

/**
 * Send an error in the one shape every failing request uses.
 *
 * Centralised so a new endpoint cannot invent its own error body and quietly
 * give consumers a second thing to parse.
 */
function sendError(
  reply: { code(statusCode: number): { send(payload: unknown): unknown } },
  statusCode: number,
  code: ApiErrorBody['error']['code'],
  message: string,
): unknown {
  const body: ApiErrorBody = { error: { code, message } };
  return reply.code(statusCode).send(body);
}
