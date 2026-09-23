/**
 * Tests for the note contract.
 *
 * Weighted towards the boundary rather than the happy path: a request body is
 * attacker-controlled, so the rejections are the behaviour that matters. Each
 * assertion names the field it is about, because "expected true to be false"
 * tells the next person nothing about what broke.
 */

import { describe, expect, it } from 'vitest';

import { MAX_NOTE_BODY_LENGTH } from './note.js';
import { parseCreateNoteRequest, parseNote } from './note-validate.js';
import { ContractError } from './validate.js';

describe('parseCreateNoteRequest', () => {
  it('accepts a body and trims the surrounding whitespace', () => {
    expect(parseCreateNoteRequest({ body: '  ship the slice  ' })).toEqual({
      body: 'ship the slice',
    });
  });

  it('rejects a body that is missing, empty, or only whitespace', () => {
    // A whitespace-only note would store fine and render blank, which reads as
    // data loss to whoever wrote it. Rejecting at the boundary is cheaper.
    expect(() => parseCreateNoteRequest({})).toThrow(/body must be a string/);
    expect(() => parseCreateNoteRequest({ body: '' })).toThrow(/must not be empty or whitespace/);
    expect(() => parseCreateNoteRequest({ body: '   \n\t ' })).toThrow(
      /must not be empty or whitespace/,
    );
  });

  it('rejects a body that is not a string', () => {
    expect(() => parseCreateNoteRequest({ body: 42 })).toThrow(/body must be a string; got number/);
    expect(() => parseCreateNoteRequest({ body: null })).toThrow(/body must be a string; got null/);
    expect(() => parseCreateNoteRequest({ body: ['a'] })).toThrow(/body must be a string; got array/);
  });

  it('rejects a body longer than the limit, and measures the trimmed length', () => {
    const tooLong = 'x'.repeat(MAX_NOTE_BODY_LENGTH + 1);
    expect(() => parseCreateNoteRequest({ body: tooLong })).toThrow(/at most 2000 characters/);

    // Padding is trimmed first, so a body that is only over the limit because of
    // whitespace is accepted — the stored value is what the limit is about.
    const padded = `  ${'x'.repeat(MAX_NOTE_BODY_LENGTH)}  `;
    expect(parseCreateNoteRequest({ body: padded }).body).toHaveLength(MAX_NOTE_BODY_LENGTH);
  });

  it('rejects a payload that is not an object', () => {
    expect(() => parseCreateNoteRequest('a string')).toThrow(ContractError);
    expect(() => parseCreateNoteRequest(null)).toThrow(/must be an object; got null/);
    expect(() => parseCreateNoteRequest([])).toThrow(/must be an object; got array/);
  });
});

describe('parseNote', () => {
  const valid = { id: 'a1b2c3', body: 'hello', createdAt: '2026-09-23T11:00:00.000Z' };

  it('accepts a note that satisfies the contract and returns it unchanged', () => {
    expect(parseNote(valid)).toEqual(valid);
  });

  it('rejects a note with a field removed', () => {
    // The regression this catches: a rename in the API that the contract never
    // learned about. It must fail here rather than in a consumer.
    for (const key of ['id', 'body', 'createdAt'] as const) {
      const { [key]: _removed, ...withoutKey } = valid;
      expect(() => parseNote(withoutKey)).toThrow(new RegExp(`missing required field "${key}"`));
    }
  });

  it('rejects a note carrying an unexpected field', () => {
    expect(() => parseNote({ ...valid, updatedAt: '2026-09-23T12:00:00.000Z' })).toThrow(
      /unexpected field "updatedAt"/,
    );
  });

  it('rejects a createdAt that is not an ISO-8601 timestamp', () => {
    expect(() => parseNote({ ...valid, createdAt: 'yesterday' })).toThrow(
      /createdAt must be an ISO-8601 timestamp/,
    );
  });

  it('rejects an empty id', () => {
    expect(() => parseNote({ ...valid, id: '' })).toThrow(/id must be a non-empty string/);
  });
});
