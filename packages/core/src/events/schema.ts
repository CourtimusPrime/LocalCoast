/** Schema spine (AD-6): sessions → events (+ blobs, samples, snapshots). */
export const DDL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS sessions (
  session_id       TEXT PRIMARY KEY,
  target_key       TEXT NOT NULL,
  started_at_wall  REAL NOT NULL,
  ended_at_wall    REAL,
  current_epoch    INTEGER NOT NULL DEFAULT 0,
  meta             TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY,
  session_id    TEXT NOT NULL,
  target_id     TEXT,
  epoch         INTEGER NOT NULL,
  ts_wall       REAL NOT NULL,
  ts_mono       REAL NOT NULL,
  type          TEXT NOT NULL,
  actor         TEXT NOT NULL,
  request_id    TEXT,
  trace_id      TEXT,
  span_id       TEXT,
  payload       TEXT NOT NULL,
  blob_id       TEXT,
  blob_evicted  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_events_session_id   ON events(session_id, id);
CREATE INDEX IF NOT EXISTS idx_events_session_epoch ON events(session_id, epoch, id);
CREATE INDEX IF NOT EXISTS idx_events_type          ON events(type, session_id, id);
CREATE INDEX IF NOT EXISTS idx_events_request       ON events(request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_events_trace         ON events(trace_id) WHERE trace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_events_ts_mono       ON events(session_id, ts_mono);

CREATE TABLE IF NOT EXISTS blobs (
  blob_id          TEXT PRIMARY KEY,
  size             INTEGER NOT NULL,
  refcount         INTEGER NOT NULL DEFAULT 1,
  created_at_wall  REAL NOT NULL,
  last_access_wall REAL NOT NULL,
  data             BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS samples (
  session_id  TEXT NOT NULL,
  kind        TEXT NOT NULL,
  resolution  INTEGER NOT NULL DEFAULT 0,
  ts_wall     REAL NOT NULL,
  ts_mono     REAL NOT NULL,
  value       REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_samples ON samples(session_id, kind, resolution, ts_mono);

CREATE TABLE IF NOT EXISTS snapshots (
  snapshot_id          TEXT PRIMARY KEY,
  session_id           TEXT,
  name                 TEXT,
  created_at_wall      REAL NOT NULL,
  pinned               INTEGER NOT NULL DEFAULT 0,
  event_id_at_capture  INTEGER,
  document             TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
