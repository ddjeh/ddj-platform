-- The notes table — the first entity in the starter kit.
--
-- Migrations are numbered, forward-only, and applied in filename order. A
-- migration that has already been applied is never edited: the change is a new
-- file. Editing one in place means two environments silently disagree about the
-- schema, which is the exact failure the numbering exists to prevent.
--
-- `IF NOT EXISTS` makes a fresh apply after a partially-completed run safe to
-- repeat. The migration runner records what it has applied, so this is a belt to
-- that pair of braces, not the mechanism.

CREATE TABLE IF NOT EXISTS notes (
  -- UUID rather than a serial: ids are handed to clients, and a sequential id
  -- tells the world how many notes exist and in what order they arrived.
  id          uuid PRIMARY KEY,
  body        text NOT NULL,
  -- `timestamptz`, not `timestamp`: a naive timestamp is ambiguous, and the
  -- ambiguity only shows up when a server moves timezone or a client does.
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- `GET /notes` orders by created_at DESC. Without this the list endpoint scans
-- and sorts the whole table, which is invisible at ten rows and a problem at a
-- hundred thousand.
CREATE INDEX IF NOT EXISTS notes_created_at_idx ON notes (created_at DESC);
