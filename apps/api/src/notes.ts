/**
 * The note repository — the data model half of the slice.
 *
 * The interface is separated from the Postgres implementation for one reason: it
 * is what lets the API's tests exercise the whole request path without a live
 * database. Tests that need a real Postgres are tests that get skipped, and a
 * skipped test proves nothing.
 *
 * The Postgres implementation is what staging and production run, and the
 * deployed proof at the end of DDJ-4 is what closes the gap between the two.
 */

import { randomUUID } from 'node:crypto';

import { parseNote, type Note } from '@ddj/shared';

/** Storage for notes. */
export interface NoteRepository {
  /** Persist a note and return it as stored, with its server-assigned id and timestamp. */
  create(body: string): Promise<Note>;
  /** Every note, newest first. */
  list(): Promise<ReadonlyArray<Note>>;
}

/**
 * The shape of a row in `notes`.
 *
 * Named separately from `Note` because the two are not the same thing: this is
 * what the driver hands back, with the column types Postgres actually uses, and
 * `toNote` below is the boundary where one becomes the other.
 */
interface NoteRow {
  readonly id: string;
  readonly body: string;
  readonly created_at: Date | string;
}

/**
 * Convert a database row into the wire contract.
 *
 * `pg` returns `timestamptz` as a `Date`, but a `string` is accepted too so this
 * keeps working if the column type or the driver's parsing ever changes. Either
 * way the value is a real timestamp: a row that cannot be parsed is a bug in the
 * database, not something to paper over with `new Date()`.
 *
 * The result goes through `parseNote` rather than being cast, so a row that
 * disagrees with the contract fails loudly at the boundary instead of being
 * served to a client.
 *
 * @throws {ContractError} when the row does not satisfy the note contract.
 */
export function toNote(row: NoteRow): Note {
  return parseNote({
    id: row.id,
    body: row.body,
    createdAt: new Date(row.created_at).toISOString(),
  });
}

/** Postgres-backed storage. Uses a connection pool: one connection per request does not scale. */
export function createPostgresNoteRepository(connectionString: string): NoteRepository {
  // Imported lazily so the module can be imported, and its pure helpers tested,
  // without the driver being installed or a database being reachable.
  let poolPromise: Promise<import('pg').Pool> | undefined;

  async function getPool(): Promise<import('pg').Pool> {
    poolPromise ??= (async () => {
      const { Pool } = await import('pg');
      return new Pool({ connectionString, connectionTimeoutMillis: 5000 });
    })();
    return poolPromise;
  }

  return {
    async create(body: string): Promise<Note> {
      const pool = await getPool();
      // The id is generated here rather than by a column default so the value
      // that is stored is the value that is returned, with no read-back and no
      // dependence on the server's clock for identity.
      const { rows } = await pool.query<NoteRow>(
        `INSERT INTO notes (id, body) VALUES ($1, $2) RETURNING id, body, created_at`,
        [randomUUID(), body],
      );
      const row = rows[0];
      if (row === undefined) {
        // INSERT ... RETURNING always yields a row. If it did not, the write did
        // not happen, and returning a fabricated note would hide that.
        throw new Error('insert into notes returned no row');
      }
      return toNote(row);
    },

    async list(): Promise<ReadonlyArray<Note>> {
      const pool = await getPool();
      // `created_at DESC, id DESC`: rows written inside the same millisecond
      // would otherwise come back in an arbitrary order, which would make the
      // list endpoint look non-deterministic to a caller and to a test.
      const { rows } = await pool.query<NoteRow>(
        `SELECT id, body, created_at FROM notes ORDER BY created_at DESC, id DESC`,
      );
      return rows.map(toNote);
    },
  };
}

/** In-memory storage, for tests and for local development without a database. */
export function createInMemoryNoteRepository(now: () => Date = () => new Date()): NoteRepository {
  const notes: Note[] = [];
  return {
    async create(body: string): Promise<Note> {
      const note: Note = { id: randomUUID(), body, createdAt: now().toISOString() };
      // Newest first, matching the Postgres implementation's ordering, so a test
      // that passes against one is not passing because of the other's quirk.
      notes.unshift(note);
      return note;
    },
    async list(): Promise<ReadonlyArray<Note>> {
      return [...notes];
    },
  };
}
