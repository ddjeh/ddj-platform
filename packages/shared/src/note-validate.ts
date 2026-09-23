/**
 * Runtime validation for the note contract.
 *
 * Same job as `validate.ts` does for build info, and the same reasoning: types
 * do not exist at runtime, so anything arriving from a client is parsed before
 * it is trusted. A request body is the least trustworthy input the service has,
 * which makes this the file that matters most.
 */

import { MAX_NOTE_BODY_LENGTH, type CreateNoteRequest, type Note } from './note.js';
import { ContractError } from './validate.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse a `POST /notes` request body.
 *
 * Trims before validating, so a body of only whitespace is rejected rather than
 * stored as a note that renders as blank and looks like data loss.
 *
 * @throws {ContractError} when the value is not a valid create request.
 */
export function parseCreateNoteRequest(value: unknown): CreateNoteRequest {
  if (!isRecord(value)) {
    throw new ContractError(`CreateNoteRequest must be an object; got ${describe(value)}`);
  }

  const { body } = value;
  if (typeof body !== 'string') {
    throw new ContractError(`CreateNoteRequest.body must be a string; got ${describe(body)}`);
  }

  const trimmed = body.trim();
  if (trimmed === '') {
    throw new ContractError('CreateNoteRequest.body must not be empty or whitespace');
  }
  if (trimmed.length > MAX_NOTE_BODY_LENGTH) {
    throw new ContractError(
      `CreateNoteRequest.body must be at most ${MAX_NOTE_BODY_LENGTH} characters; got ${trimmed.length}`,
    );
  }

  return { body: trimmed };
}

/**
 * Assert that `value` satisfies `Note` and return it narrowed.
 *
 * Rejects unknown keys as well as missing ones, for the same reason
 * `parseBuildInfo` does: an extra key usually means a rename left a field behind.
 *
 * @throws {ContractError} when the value does not satisfy the contract.
 */
export function parseNote(value: unknown): Note {
  if (!isRecord(value)) {
    throw new ContractError(`Note must be an object; got ${describe(value)}`);
  }

  for (const key of ['id', 'body', 'createdAt'] as const) {
    if (!(key in value)) {
      throw new ContractError(`Note is missing required field "${key}"`);
    }
  }
  for (const key of Object.keys(value)) {
    if (!['id', 'body', 'createdAt'].includes(key)) {
      throw new ContractError(`Note has unexpected field "${key}"`);
    }
  }

  const id = value['id'];
  const body = value['body'];
  const createdAt = value['createdAt'];

  if (typeof id !== 'string' || id === '') {
    throw new ContractError(`Note.id must be a non-empty string; got ${describe(id)}`);
  }
  if (typeof body !== 'string') {
    throw new ContractError(`Note.body must be a string; got ${describe(body)}`);
  }
  if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) {
    throw new ContractError(`Note.createdAt must be an ISO-8601 timestamp; got ${describe(createdAt)}`);
  }

  return { id, body, createdAt };
}

/**
 * A short description of a value for an error message.
 *
 * `typeof null` is `'object'`, which reads as a bug in the message rather than
 * in the payload. Naming `null` and arrays explicitly keeps the message honest.
 */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value === undefined) return 'undefined';
  return typeof value;
}
