/**
 * Tests for configuration parsing.
 *
 * Config bugs are the ones that only show up in the environment you did not
 * test, so the malformed cases are worth pinning down here.
 */

import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from './config.js';

describe('loadConfig', () => {
  it('starts with safe defaults from an empty environment', () => {
    // A missing variable must never be the reason a deploy fails.
    const config = loadConfig({});

    expect(config).toEqual({
      environment: 'development',
      port: 3000,
      host: '127.0.0.1',
      logLevel: 'info',
      databaseUrl: undefined,
    });
  });

  it('reads every value from the environment when set', () => {
    const config = loadConfig({
      DDJ_ENV: 'production',
      DDJ_PORT: '8080',
      DDJ_HOST: '0.0.0.0',
      DDJ_LOG_LEVEL: 'debug',
      DDJ_DATABASE_URL: 'postgres://user:pass@127.0.0.1:5432/ddj',
    });

    expect(config.environment).toBe('production');
    expect(config.port).toBe(8080);
    expect(config.host).toBe('0.0.0.0');
    expect(config.logLevel).toBe('debug');
    expect(config.databaseUrl).toBe('postgres://user:pass@127.0.0.1:5432/ddj');
  });

  it('treats an empty DATABASE_URL as not configured', () => {
    // An empty string would fail at connect time with a confusing driver error.
    expect(loadConfig({ DDJ_DATABASE_URL: '' }).databaseUrl).toBeUndefined();
  });

  it.each([
    ['an unknown environment', { DDJ_ENV: 'prod' }, /DDJ_ENV must be one of/],
    ['a non-numeric port', { DDJ_PORT: '8080abc' }, /DDJ_PORT must be an integer/],
    ['a port out of range', { DDJ_PORT: '70000' }, /between 1 and 65535/],
    ['an unknown log level', { DDJ_LOG_LEVEL: 'loud' }, /DDJ_LOG_LEVEL must be one of/],
  ])('rejects %s with a message naming the variable', (_label, env, expected) => {
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(expected);
  });
});
