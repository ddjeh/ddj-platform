#!/usr/bin/env bash
#
# The environment registry. One place that says where each environment lives.
#
# Sourced by deploy.sh, rollback.sh, and health-check.sh. Add an environment by
# adding a case branch here, not by editing the scripts.
#
# Ports: staging and production run side by side on the same host, so they bind
# different ports. Everything else about them is identical, which is the point:
# the artifact promoted from staging to production is the same artifact.

# shellcheck shell=bash

ddj_environment_names() {
  echo "staging production"
}

ddj_load_environment() {
  local env_name="$1"

  DDJ_ENV_NAME="$env_name"
  case "$env_name" in
    staging)
      DDJ_ENV_PORT=3001
      DDJ_ENV_UNIT="ddj-api-staging"
      DDJ_ENV_SERVICE_USER="ddj-staging"
      ;;
    production)
      DDJ_ENV_PORT=3002
      DDJ_ENV_UNIT="ddj-api-production"
      DDJ_ENV_SERVICE_USER="ddj-production"
      ;;
    *)
      echo "unknown environment: $env_name (expected: $(ddj_environment_names))" >&2
      return 1
      ;;
  esac

  DDJ_ENV_ROOT="/srv/ddj/$env_name"
  DDJ_ENV_RELEASES="$DDJ_ENV_ROOT/releases"
  DDJ_ENV_CURRENT="$DDJ_ENV_ROOT/current"
  DDJ_ENV_SHARED="$DDJ_ENV_ROOT/shared"
  DDJ_ENV_ENVFILE="$DDJ_ENV_SHARED/.env"
  DDJ_ENV_LOG_DIR="/var/log/ddj/$env_name"
  # Binding loopback by default: the service should not be reachable from the
  # LAN until something in front of it is deliberately put there.
  DDJ_ENV_HOST="${DDJ_BIND_HOST:-127.0.0.1}"
  DDJ_ENV_BASE_URL="${DDJ_BASE_URL:-http://127.0.0.1:$DDJ_ENV_PORT}"

  export DDJ_ENV_NAME DDJ_ENV_PORT DDJ_ENV_UNIT DDJ_ENV_SERVICE_USER \
         DDJ_ENV_ROOT DDJ_ENV_RELEASES DDJ_ENV_CURRENT DDJ_ENV_SHARED \
         DDJ_ENV_ENVFILE DDJ_ENV_LOG_DIR DDJ_ENV_HOST DDJ_ENV_BASE_URL
}
