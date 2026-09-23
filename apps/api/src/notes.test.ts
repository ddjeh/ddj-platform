/**
 * Tests for the vertical slice: authenticate, write, read back.
 *
 * These run against an in-memory repository, which is the point of splitting the
 * repository interface out — the whole request path is exercised on every push,
 * including in CI, with no database to stand up and therefore no chance of the
 * test being quietly skipped.
 *
 * What this file cannot prove is that the *Postgres* implementation works. That
 * is proved by the deployed walkthrough recorded on DDJ-4, which is the only
 * evidence that closes the gap between the two.
 */

import { describe, expect, it } from 'vitest';

import { CONTRACT_VERSION, type ApiErrorBody, type BuildInfo, type Note } from '@ddj/shared';

import { createApp } from './app.js';
import { extractBearerToken, tokenMatches } from './auth.js';
import type { Config } from './config.js';
import { createInMemoryNoteRepository, toNote } from './notes.js';

const TEST_TOKEN = 'a-test-token-that-is-not-a-real-secret';

const TEST_CONFIG: Config = {
  environment: 'test',
  port: 0,
  host: '127.0.0.1',
  logLevel: 'fatal',
  databaseUrl: 'postgres://unused/never-connected',
  apiToken: TEST_TOKEN,
};

const CI_BUILD: BuildInfo = {
  service: '@ddj/api',
  version: '0.1.0',
  commit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  commitShort: 'a1b2c3d',
  builtAt: '2026-09-23T00:00:00.000Z',
  environment: 'test',
  contractVersion: CONTRACT_VERSION,
};

function appFor() {
  // An explicit repository, so nothing in this file touches a real database even
  // though the config names one.
  return createApp({
    config: TEST_CONFIG,
    buildInfo: CI_BUILD,
    dependencies: [],
    notes: createInMemoryNoteRepository(),
  });
}

const AUTHORIZED = { authorization: `Bearer ${TEST_TOKEN}` };

describe('the note slice, end to end', () => {
  it('writes a note and returns it on the next read', async () => {
    const app = appFor();

    const created = await app.inject({
      method: 'POST',
      url: '/notes',
      headers: AUTHORIZED,
      payload: { body: 'first slice' },
    });

    expect(created.statusCode).toBe(201);
    const note = created.json<Note>();
    // Validated against the shared contract, so a handler that stops satisfying
    // the contract fails here rather than in a consumer.
    expect(note).toMatchObject({ body: 'first slice' });
    expect(note.id).toBeTruthy();
    expect(Number.isNaN(Date.parse(note.createdAt))).toBe(false);

    const listed = await app.inject({ method: 'GET', url: '/notes', headers: AUTHORIZED });
    expect(listed.statusCode).toBe(200);
    // This is the assertion the slice exists to make: what was written is what
    // comes back.
    expect(listed.json<{ notes: Note[] }>().notes).toEqual([note]);

    await app.close();
  });

  it('returns notes newest first', async () => {
    const app = appFor();
    for (const body of ['one', 'two', 'three']) {
      await app.inject({ method: 'POST', url: '/notes', headers: AUTHORIZED, payload: { body } });
    }

    const listed = await app.inject({ method: 'GET', url: '/notes', headers: AUTHORIZED });
    expect(listed.json<{ notes: Note[] }>().notes.map((n) => n.body)).toEqual([
      'three',
      'two',
      'one',
    ]);

    await app.close();
  });

  it('trims the stored body', async () => {
    const app = appFor();
    const created = await app.inject({
      method: 'POST',
      url: '/notes',
      headers: AUTHORIZED,
      payload: { body: '  padded  ' },
    });
    expect(created.json<Note>().body).toBe('padded');
    await app.close();
  });
});

describe('authentication', () => {
  it('rejects a request with no credential', async () => {
    const app = appFor();
    const response = await app.inject({ method: 'GET', url: '/notes' });

    expect(response.statusCode).toBe(401);
    expect(response.json<ApiErrorBody>().error.code).toBe('unauthorized');
    await app.close();
  });

  it('rejects a wrong token and a malformed header identically', async () => {
    const app = appFor();

    const wrongToken = await app.inject({
      method: 'GET',
      url: '/notes',
      headers: { authorization: 'Bearer not-the-token' },
    });
    const wrongScheme = await app.inject({
      method: 'GET',
      url: '/notes',
      headers: { authorization: `Basic ${TEST_TOKEN}` },
    });
    const emptyToken = await app.inject({
      method: 'GET',
      url: '/notes',
      headers: { authorization: 'Bearer ' },
    });

    // All three must be indistinguishable. A caller who can tell "wrong scheme"
    // from "wrong token" learns something about the credential for free.
    for (const response of [wrongToken, wrongScheme, emptyToken]) {
      expect(response.statusCode).toBe(401);
      expect(response.json<ApiErrorBody>()).toEqual(wrongToken.json<ApiErrorBody>());
    }

    await app.close();
  });

  it('guards the write path too, not just the read path', async () => {
    // The failure this catches: auth added to GET and forgotten on POST.
    const app = appFor();
    const response = await app.inject({
      method: 'POST',
      url: '/notes',
      payload: { body: 'unauthenticated write' },
    });

    expect(response.statusCode).toBe(401);
    // And nothing was written.
    const listed = await app.inject({ method: 'GET', url: '/notes', headers: AUTHORIZED });
    expect(listed.json<{ notes: Note[] }>().notes).toEqual([]);

    await app.close();
  });
});

describe('validation on the write path', () => {
  it('rejects an empty body with 400 and a machine-readable code', async () => {
    const app = appFor();
    const response = await app.inject({
      method: 'POST',
      url: '/notes',
      headers: AUTHORIZED,
      payload: { body: '   ' },
    });

    expect(response.statusCode).toBe(400);
    const error = response.json<ApiErrorBody>().error;
    expect(error.code).toBe('validation_failed');
    // The message names the field, which is what makes it actionable.
    expect(error.message).toMatch(/body/);

    await app.close();
  });

  it('rejects a missing body', async () => {
    const app = appFor();
    const response = await app.inject({
      method: 'POST',
      url: '/notes',
      headers: AUTHORIZED,
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});

describe('when no notes store is configured', () => {
  it('answers 503 rather than an empty list', async () => {
    // The failure this catches: a caller concluding "there are no notes" when
    // the truth is "this service cannot reach its data".
    const app = createApp({
      config: { ...TEST_CONFIG, databaseUrl: undefined },
      buildInfo: CI_BUILD,
      dependencies: [],
    });

    const response = await app.inject({ method: 'GET', url: '/notes', headers: AUTHORIZED });
    expect(response.statusCode).toBe(503);
    expect(response.json<ApiErrorBody>().error.code).toBe('internal');

    await app.close();
  });
});

describe('toNote', () => {
  it('converts a database row into the wire contract', () => {
    const note = toNote({
      id: 'a1b2c3d4-0000-0000-0000-000000000000',
      body: 'from postgres',
      created_at: new Date('2026-09-23T11:00:00.000Z'),
    });

    expect(note).toEqual({
      id: 'a1b2c3d4-0000-0000-0000-000000000000',
      body: 'from postgres',
      createdAt: '2026-09-23T11:00:00.000Z',
    });
  });

  it('rejects a row that does not satisfy the contract', () => {
    // A NOT NULL column is not the same guarantee as a contract. If the table
    // and the contract ever drift, this fails here rather than in a client.
    expect(() => toNote({ id: '', body: 'x', created_at: new Date() })).toThrow(/id/);
  });
});

describe('token comparison', () => {
  it('matches only an exact token', () => {
    expect(tokenMatches(TEST_TOKEN, TEST_TOKEN)).toBe(true);
    expect(tokenMatches('wrong', TEST_TOKEN)).toBe(false);
    // Differing lengths, which is the case a naive length check would leak.
    expect(tokenMatches(`${TEST_TOKEN}x`, TEST_TOKEN)).toBe(false);
    expect(tokenMatches(TEST_TOKEN.slice(0, -1), TEST_TOKEN)).toBe(false);
  });

  it('extracts a token only from a well-formed bearer header', () => {
    expect(extractBearerToken('Bearer abc')).toBe('abc');
    expect(extractBearerToken('Bearer   abc  ')).toBe('abc');
    expect(extractBearerToken('Basic abc')).toBeUndefined();
    expect(extractBearerToken('Bearer ')).toBeUndefined();
    expect(extractBearerToken(undefined)).toBeUndefined();
  });
});
