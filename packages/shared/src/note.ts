/**
 * The note contract — the first real entity in the starter kit.
 *
 * This exists to prove the kit's whole spine is connected: a caller writes a
 * note through the HTTP interface, the API persists it in Postgres, and reading
 * the list back returns what was written. It is deliberately the smallest
 * entity that can demonstrate that. Anything more elaborate (authors, tags,
 * edits) would be a feature, and features are new issues, not scope.
 *
 * Both sides of the wire import these types, so the API and its consumers
 * cannot drift apart silently. See `validate.ts` for the runtime half.
 */

/**
 * A note as it appears on the wire.
 *
 * Timestamps are ISO-8601 strings, not `Date` objects: this type crosses a JSON
 * boundary, and `JSON.parse` never produces a `Date`.
 */
export interface Note {
  /** Server-assigned UUID. */
  readonly id: string;
  /** The note text. Never empty; whitespace is trimmed before it is stored. */
  readonly body: string;
  /** ISO-8601 timestamp of when the note was created. */
  readonly createdAt: string;
}

/** Request body of `POST /notes`. */
export interface CreateNoteRequest {
  readonly body: string;
}

/** Response body of `GET /notes`. */
export interface NoteList {
  /** Newest first. */
  readonly notes: ReadonlyArray<Note>;
}

/**
 * The codes an error response can carry.
 *
 * Machine-readable so a caller can branch on the failure without parsing the
 * prose, and a closed set so adding one is a deliberate act rather than a typo.
 */
export type ApiErrorCode =
  /** No credential, or one the server does not recognise. */
  | 'unauthorized'
  /** A body or parameter did not satisfy its contract. */
  | 'validation_failed'
  /** The request was well-formed but names something that does not exist. */
  | 'not_found'
  /** Nothing the caller did; the fault is ours. Details are in the logs, not here. */
  | 'internal';

/**
 * The error shape every failing request returns.
 *
 * Uniform on purpose: a client writes one error path, not one per endpoint. The
 * `message` is safe to display — it never carries a credential, a stack trace,
 * or a driver's connection string.
 */
export interface ApiErrorBody {
  readonly error: {
    readonly code: ApiErrorCode;
    readonly message: string;
  };
}

/** Longest note body accepted. Bounds what one request can write to the table. */
export const MAX_NOTE_BODY_LENGTH = 2000;
