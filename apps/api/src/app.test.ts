/**
 * Tests for the HTTP surface.
 *
 * The load-bearing test here is "serves build info that satisfies the shared
 * contract". It is written to fail on the regressions that actually matter:
 * a handler and the contract drifting apart, and a build that cannot report
 * which commit it came from.
 */

import { describe, expect, it } from 'vitest';

import {
  BUILD_INFO_KEYS,
  CONTRACT_VERSION,
  parseBuildInfo,
  type BuildInfo,
  type DependencyCheck,
  type LivenessReport,
  type ReadinessReport,
} from '@ddj/shared';

import { createApp } from './app.js';
import { createBuildInfo } from './build-info.js';
import type { Config } from './config.js';
import type { Dependency } from './readiness.js';

const TEST_CONFIG: Config = {
  environment: 'test',
  port: 0,
  host: '127.0.0.1',
  logLevel: 'fatal',
  databaseUrl: undefined,
};

/** A build as CI produces one: a real commit SHA, not `unknown`. */
const CI_BUILD: BuildInfo = {
  service: '@ddj/api',
  version: '0.1.0',
  commit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  commitShort: 'a1b2c3d',
  builtAt: '2026-09-23T00:00:00.000Z',
  environment: 'test',
  contractVersion: CONTRACT_VERSION,
};

function appFor(buildInfo: BuildInfo = CI_BUILD, dependencies: readonly Dependency[] = []) {
  return createApp({ config: TEST_CONFIG, buildInfo, dependencies });
}

describe('GET /health (liveness)', () => {
  it('reports ok without touching any dependency', async () => {
    const app = appFor();
    // A dependency that always fails. Liveness must not care: restarting a
    // process because its database is unreachable is how an outage becomes a
    // crash loop.
    const failing: Dependency = {
      name: 'always-down',
      check: () => Promise.reject(new Error('down')),
    };

    const response = await createApp({
      config: TEST_CONFIG,
      buildInfo: CI_BUILD,
      dependencies: [failing],
    }).inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    const body = response.json<LivenessReport>();
    expect(body.status).toBe('ok');
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);

    await app.close();
  });
});

describe('GET /health/ready (readiness)', () => {
  it('is ready and 200 when every dependency is healthy', async () => {
    const healthy: Dependency = { name: 'postgres', check: () => Promise.resolve() };
    const response = await appFor(CI_BUILD, [healthy]).inject({
      method: 'GET',
      url: '/health/ready',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<ReadinessReport>();
    expect(body.status).toBe('ready');
    expect(body.checks).toEqual([
      { name: 'postgres', status: 'ok', durationMs: expect.any(Number) },
    ]);
  });

  it('is degraded and 503 when a dependency is down, so a load balancer drains it', async () => {
    const down: Dependency = {
      name: 'postgres',
      check: () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:5432')),
    };
    const response = await appFor(CI_BUILD, [down]).inject({ method: 'GET', url: '/health/ready' });

    // The status code is the contract a load balancer acts on. A 200 here would
    // keep traffic pointed at an instance that cannot serve it.
    expect(response.statusCode).toBe(503);
    const body = response.json<ReadinessReport>();
    expect(body.status).toBe('degraded');
    expect(body.checks[0]).toMatchObject({ name: 'postgres', status: 'fail' });
  });

  it('reports a skipped check rather than failing when no dependency is configured', async () => {
    const response = await appFor(CI_BUILD, []).inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(200);
    const body = response.json<ReadinessReport>();
    expect(body.status).toBe('ready');
    expect(body.checks).toEqual([{ name: 'none-configured', status: 'skipped', durationMs: 0 }]);
  });

  it('does not leak a connection string into the failure detail', async () => {
    // Database drivers routinely put the DSN, password included, in the error
    // message. This endpoint is unauthenticated.
    const leaky: Dependency = {
      name: 'postgres',
      check: () => Promise.reject(new Error('failed to connect to postgres://ddj:hunter2@db:5432/ddj')),
    };
    const response = await appFor(CI_BUILD, [leaky]).inject({ method: 'GET', url: '/health/ready' });

    const check = response.json<ReadinessReport>().checks[0] as DependencyCheck;
    expect(check.detail).not.toContain('hunter2');
    expect(check.detail).toContain('<redacted-url>');
  });
});

describe('GET /version', () => {
  it('serves build info that satisfies the shared contract', async () => {
    const response = await appFor().inject({ method: 'GET', url: '/version' });

    expect(response.statusCode).toBe(200);
    // The real assertion: the validator is the contract's own definition of a
    // valid payload, so this fails if the handler and the contract ever drift.
    expect(() => parseBuildInfo(response.json())).not.toThrow();
  });

  it('reports exactly the contract fields, so a rename cannot pass unnoticed', async () => {
    const response = await appFor().inject({ method: 'GET', url: '/version' });

    expect(Object.keys(response.json()).sort()).toEqual([...BUILD_INFO_KEYS].sort());
  });

  it('reports the commit it was built from, not a placeholder', async () => {
    const response = await appFor().inject({ method: 'GET', url: '/version' });

    const body = response.json<BuildInfo>();
    expect(body.commit).toBe(CI_BUILD.commit);
    expect(body.commitShort).toBe(CI_BUILD.commitShort);
    expect(body.contractVersion).toBe(CONTRACT_VERSION);
  });

  it('refuses to start when the handler would serve a payload that breaks the contract', async () => {
    // Simulates the realistic regression: someone renames a field in the
    // handler but not in @ddj/shared. Failing at construction means a bad build
    // never reaches a port.
    const drifted = { ...CI_BUILD, commitSha: CI_BUILD.commit } as unknown as BuildInfo;

    expect(() => appFor(drifted)).toThrow(/unexpected field "commitSha"/);
  });

  it('refuses to start when the served contract version does not match the compiled one', async () => {
    const stale = { ...CI_BUILD, contractVersion: '0.0.1' } as BuildInfo;

    expect(() => appFor(stale)).toThrow(/contract drift/);
  });
});

describe('GET /', () => {
  it('describes the service and points at its endpoints', async () => {
    const response = await appFor().inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      service: '@ddj/api',
      environment: 'test',
      endpoints: ['/health', '/health/ready', '/version'],
    });
  });
});

describe('createBuildInfo', () => {
  it('uses the commit from build metadata', () => {
    const info = createBuildInfo('production', '1.2.3', {
      commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      builtAt: '2026-09-23T00:00:00.000Z',
    });

    expect(info.commitShort).toBe('deadbee');
    expect(info.environment).toBe('production');
    expect(parseBuildInfo(info)).toEqual(info);
  });

  it('falls back to a visible placeholder when build metadata is absent', () => {
    // Honest and greppable. The deploy health gate rejects this in staging and
    // production, so it cannot silently ship.
    const info = createBuildInfo('test', '0.1.0', {});

    expect(info.commit).toBe('unknown');
    expect(info.commitShort).toBe('unknown');
    expect(info.builtAt).toBe('unknown');
  });
});
