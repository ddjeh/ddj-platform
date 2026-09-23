/**
 * Tests for the contract validator.
 *
 * This is the layer that has to be trustworthy: if `parseBuildInfo` accepts a
 * payload with a field missing, the API's own guard stops protecting anything.
 */

import { describe, expect, it } from 'vitest';

import { CONTRACT_VERSION, type BuildInfo } from './build-info.js';
import { ContractError, parseBuildInfo } from './validate.js';

const VALID: BuildInfo = {
  service: '@ddj/api',
  version: '0.1.0',
  commit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  commitShort: 'a1b2c3d',
  builtAt: '2026-09-23T00:00:00.000Z',
  environment: 'staging',
  contractVersion: CONTRACT_VERSION,
};

describe('parseBuildInfo', () => {
  it('accepts a valid payload and returns it unchanged', () => {
    expect(parseBuildInfo(VALID)).toEqual(VALID);
  });

  it.each(['service', 'version', 'commit', 'commitShort', 'builtAt', 'environment', 'contractVersion'])(
    'rejects a payload missing "%s"',
    (field) => {
      const { [field as keyof BuildInfo]: _removed, ...rest } = VALID;

      // A dropped field is the classic silent regression: the handler stops
      // emitting it and nothing notices until a consumer reads undefined.
      expect(() => parseBuildInfo(rest)).toThrow(ContractError);
      expect(() => parseBuildInfo(rest)).toThrow(new RegExp(`missing required field "${field}"`));
    },
  );

  it('rejects a payload with an unexpected field', () => {
    // What a half-finished rename looks like: the new field is there, the old
    // one is still there too.
    const drifted = { ...VALID, commitSha: VALID.commit };

    expect(() => parseBuildInfo(drifted)).toThrow(/unexpected field "commitSha"/);
  });

  it('rejects a field of the wrong type', () => {
    expect(() => parseBuildInfo({ ...VALID, version: 1 })).toThrow(/version must be a string/);
  });

  it('rejects a non-object payload', () => {
    expect(() => parseBuildInfo(null)).toThrow(/must be an object/);
    expect(() => parseBuildInfo('nope')).toThrow(/must be an object/);
    expect(() => parseBuildInfo([])).toThrow(/must be an object/);
  });

  it('rejects an unknown environment', () => {
    expect(() => parseBuildInfo({ ...VALID, environment: 'prod' })).toThrow(
      /environment must be one of/,
    );
  });

  it('rejects a builtAt that is not a timestamp', () => {
    expect(() => parseBuildInfo({ ...VALID, builtAt: 'yesterday' })).toThrow(/ISO-8601/);
  });

  it('rejects a payload built against a different contract version', () => {
    // This is the check that makes the contract version mean something: a
    // service compiled against an older contract cannot claim to satisfy this one.
    expect(() => parseBuildInfo({ ...VALID, contractVersion: '0.0.1' })).toThrow(
      /contract drift/,
    );
  });
});
