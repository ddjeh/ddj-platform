/**
 * Runtime validation for the contracts in `build-info.ts`.
 *
 * TypeScript types vanish at runtime. These guards are what turn "the handler
 * and the contract disagree" from a production incident into a failed test: the
 * API validates its own response before sending it, and the test suite asserts
 * that the validator rejects a payload with a field removed.
 *
 * Deliberately dependency-free and hand-written. A schema library is the right
 * call once there are dozens of contracts; at two, the dependency costs more
 * than it saves.
 */

import { CONTRACT_VERSION, type BuildInfo, type Environment } from './build-info.js';

/** Thrown when a value does not satisfy a contract. */
export class ContractError extends Error {
  override readonly name = 'ContractError';
}

const ENVIRONMENTS: readonly string[] = ['development', 'test', 'staging', 'production'];

/** The exact set of keys `BuildInfo` must carry. Kept in sync with the interface. */
export const BUILD_INFO_KEYS = [
  'service',
  'version',
  'commit',
  'commitShort',
  'builtAt',
  'environment',
  'contractVersion',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== 'string') {
    throw new ContractError(`BuildInfo.${key} must be a string; got ${typeof value}`);
  }
  return value;
}

/**
 * Assert that `value` satisfies `BuildInfo` and return it narrowed.
 *
 * Rejects unknown keys as well as missing ones. An extra key usually means a
 * rename left the old field behind, which is exactly the drift worth catching.
 *
 * @throws {ContractError} when the value does not satisfy the contract.
 */
export function parseBuildInfo(value: unknown): BuildInfo {
  if (!isRecord(value)) {
    throw new ContractError(`BuildInfo must be an object; got ${typeof value}`);
  }

  for (const key of BUILD_INFO_KEYS) {
    if (!(key in value)) {
      throw new ContractError(`BuildInfo is missing required field "${key}"`);
    }
  }
  for (const key of Object.keys(value)) {
    if (!(BUILD_INFO_KEYS as readonly string[]).includes(key)) {
      throw new ContractError(`BuildInfo has unexpected field "${key}"`);
    }
  }

  const environment = requireString(value, 'environment');
  if (!ENVIRONMENTS.includes(environment)) {
    throw new ContractError(
      `BuildInfo.environment must be one of ${ENVIRONMENTS.join(', ')}; got ${environment}`,
    );
  }

  const builtAt = requireString(value, 'builtAt');
  if (Number.isNaN(Date.parse(builtAt))) {
    throw new ContractError(`BuildInfo.builtAt must be an ISO-8601 timestamp; got ${builtAt}`);
  }

  const contractVersion = requireString(value, 'contractVersion');
  if (contractVersion !== CONTRACT_VERSION) {
    throw new ContractError(
      `BuildInfo.contractVersion is ${contractVersion}, but this build of @ddj/shared implements ${CONTRACT_VERSION}. ` +
        'This is a contract drift: bump CONTRACT_VERSION or fix the service.',
    );
  }

  return {
    service: requireString(value, 'service'),
    version: requireString(value, 'version'),
    commit: requireString(value, 'commit'),
    commitShort: requireString(value, 'commitShort'),
    builtAt,
    environment: environment as Environment,
    contractVersion,
  };
}
