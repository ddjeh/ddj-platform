/**
 * Process entry point: read config, build the app, listen, shut down cleanly.
 *
 * Everything interesting is in `app.ts`. This file only deals with the parts
 * that need a real process: binding a port, and reacting to signals.
 */

import { createApp, SERVICE_VERSION } from './app.js';
import { createBuildInfo } from './build-info.js';
import { ConfigError, loadConfig } from './config.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    // A malformed environment is an operator error, not a bug. Say exactly what
    // is wrong and exit non-zero so the supervisor does not restart-loop on it.
    if (error instanceof ConfigError) {
      process.stderr.write(`[config] ${error.message}\n`);
      process.exit(78); // EX_CONFIG
    }
    throw error;
  }

  const buildInfo = createBuildInfo(config.environment, SERVICE_VERSION);
  const app = createApp({ config, buildInfo });

  // Refuse to start in staging or production without a real commit SHA. An
  // artifact that cannot say which commit it is makes rollback guesswork, and
  // this is the cheapest possible place to catch it.
  if (buildInfo.commit === 'unknown' && config.environment !== 'development' && config.environment !== 'test') {
    app.log.error(
      { environment: config.environment },
      'refusing to start: build-meta.json is missing, so this artifact cannot report its commit',
    );
    process.exit(78);
  }

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      app.log.info({ signal }, 'shutting down');
      // close() stops accepting connections and waits for in-flight requests,
      // which is what lets a deploy drain cleanly instead of dropping requests.
      void app.close().then(
        () => process.exit(0),
        (error: unknown) => {
          app.log.error({ error }, 'error during shutdown');
          process.exit(1);
        },
      );
    });
  }

  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    { environment: config.environment, commit: buildInfo.commitShort, version: buildInfo.version },
    `${buildInfo.service} listening on ${config.host}:${config.port}`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`[fatal] ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
