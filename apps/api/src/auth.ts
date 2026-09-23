/**
 * Bearer-token authentication.
 *
 * The kit's target is a baseline that ships with authentication in it, because
 * bolting auth on later is how an internal tool ends up on the public internet
 * with no door. This is deliberately the smallest thing that is actually
 * authentication rather than the appearance of it:
 *
 * - The token is compared in constant time. String comparison short-circuits on
 *   the first differing byte, which leaks the token one byte at a time to anyone
 *   who can measure the response time.
 * - The failure body never distinguishes "no token" from "wrong token". Telling
 *   an unauthenticated caller that their guess was *close* is free information.
 * - The token is read once at startup and lives in `Config`, never re-read from
 *   `process.env` at request time.
 *
 * What this is not: a user model, a login flow, or an expiring token. Those are
 * a product decision and a new issue; see the scope boundary on DDJ-4.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ApiErrorBody } from '@ddj/shared';

/** The header a caller presents its token in. */
const AUTH_HEADER = 'authorization';
const BEARER_PREFIX = 'Bearer ';

/**
 * The message every authentication failure returns, whatever the reason.
 *
 * Shared by the guard and its tests so the two cannot disagree about what an
 * unauthenticated caller is told.
 */
export const UNAUTHORIZED_MESSAGE = 'A valid bearer token is required.';

/**
 * Compare two strings without leaking their contents through response timing.
 *
 * `timingSafeEqual` requires equal-length buffers and throws when they differ,
 * so both sides are hashed first. A digest is a fixed 32 bytes for any input,
 * which keeps the comparison constant-time even when the presented token is the
 * wrong length — a guess usually is, and a length-dependent early return is
 * exactly where the leak would show up.
 */
export function tokenMatches(presented: string, expected: string): boolean {
  const presentedDigest = createHash('sha256').update(presented, 'utf8').digest();
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(presentedDigest, expectedDigest);
}

/**
 * Extract the token from an `Authorization: Bearer <token>` header.
 *
 * Returns `undefined` for a missing header, a different scheme, or an empty
 * token — all of which are "no credential presented", and none of which the
 * caller can distinguish from a wrong one in the response.
 */
export function extractBearerToken(header: string | undefined): string | undefined {
  if (header === undefined || !header.startsWith(BEARER_PREFIX)) return undefined;
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token === '' ? undefined : token;
}

/**
 * Build the `onRequest` hook that guards the routes that need a credential.
 *
 * `onRequest` rather than `preHandler`: it runs before the body is parsed, so an
 * unauthenticated request carrying a large body is rejected without the server
 * doing the work of reading it.
 */
export function createAuthGuard(expectedToken: string) {
  return async function authGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const presented = extractBearerToken(request.headers[AUTH_HEADER]);
    if (presented === undefined || !tokenMatches(presented, expectedToken)) {
      // Logged without the presented value: a wrong token is still a credential
      // someone typed, and logs are the least protected store we have.
      request.log.warn({ path: request.url }, 'rejected unauthenticated request');
      const body: ApiErrorBody = {
        error: { code: 'unauthorized', message: UNAUTHORIZED_MESSAGE },
      };
      await reply.code(401).send(body);
    }
  };
}
