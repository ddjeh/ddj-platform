/**
 * @ddj/shared — contracts shared across the workspace.
 *
 * Keep this package free of runtime dependencies. It is imported by the API and
 * by anything that talks to it, so a dependency added here is a dependency
 * added everywhere.
 */

export {
  CONTRACT_VERSION,
  type BuildInfo,
  type DependencyCheck,
  type Environment,
  type LivenessReport,
  type ReadinessReport,
  type ReadinessStatus,
} from './build-info.js';

export { BUILD_INFO_KEYS, ContractError, parseBuildInfo } from './validate.js';
