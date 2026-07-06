import Database from 'better-sqlite3';
import { DDL } from './schema.js';
import type { AnyEvent, Sample } from '@localcoast/protocol-types';
import { fromRow, type EventFilter, type EventRow, type RetentionConfig, type SessionRowInput } from './rows.js';

/**
 * Synchronous SQLite writer — all DB access for the event store lives here.
 * Runs inside the writer worker thread (or spawned Node child, in Electron
 * hosts) in production (AD-6 / invariant 7); unit tests may drive it
 * in-process. NEVER construct this on the desktop main thread: better-sqlite3
 * is built for the plain-Node ABI, not Electron's.
 */

export type { EventFilter, EventRow, RetentionConfig, SessionRowInput } from './rows.js';

export class SqliteWriter {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec(DDL);
  }

  maxEventId(): number {
    const row = this.db.prepare('SELECT MAX(id) AS m FROM events').get() as { m: number | null };
    return row.m ?? 0;
  }

  appendBatch(rows: EventRow[]): void {
    const insert = this.db.prepare(
      `INSERT INTO events (id, session_id, target_id, epoch, ts_wall, ts_mono, type, actor,
                           request_id, trace_id, span_id, payload, blob_id, blob_evicted)
       VALUES (@id, @sessionId, @targetId, @epoch, @tsWall, @tsMono, @type, @actor,
               @requestId, @traceId, @spanId, @payload, @blobId, @blobEvicted)`,
    );
    const tx = this.db.transaction((batch: EventRow[]) => {
      for (const row of batch) {
        insert.run({
          ...row,
          targetId: row.targetId ?? null,
          requestId: row.requestId ?? null,
          traceId: row.traceId ?? null,
          spanId: row.spanId ?? null,
          blobId: row.blobId ?? null,
          blobEvicted: row.blobEvicted ? 1 : 0,
        });
      }
    });
    tx(rows);
  }

  queryEvents(filter: EventFilter): Array<AnyEvent & { id: number }> {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.sessionId !== undefined) {
      where.push('session_id = @sessionId');
      params.sessionId = filter.sessionId;
    }
    if (filter.types && filter.types.length > 0) {
      const placeholders = filter.types.map((_, i) => `@type${i}`);
      where.push(`type IN (${placeholders.join(', ')})`);
      filter.types.forEach((t, i) => (params[`type${i}`] = t));
    }
    if (filter.epoch !== undefined) {
      where.push('epoch = @epoch');
      params.epoch = filter.epoch;
    }
    if (filter.requestId !== undefined) {
      where.push('request_id = @requestId');
      params.requestId = filter.requestId;
    }
    if (filter.traceId !== undefined) {
      where.push('trace_id = @traceId');
      params.traceId = filter.traceId;
    }
    if (filter.tsMonoMin !== undefined) {
      where.push('ts_mono >= @tsMonoMin');
      params.tsMonoMin = filter.tsMonoMin;
    }
    if (filter.tsMonoMax !== undefined) {
      where.push('ts_mono <= @tsMonoMax');
      params.tsMonoMax = filter.tsMonoMax;
    }
    if (filter.beforeId !== undefined) {
      where.push('id < @beforeId');
      params.beforeId = filter.beforeId;
    }
    params.limit = filter.limit;
    const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT @limit`;
    const rows = this.db.prepare(sql).all(params) as Array<Record<string, unknown>>;
    return rows.map(fromRow).reverse();
  }

  /** Network panel header: totals per session+epoch, computed SQL-side. */
  networkTotals(sessionId: string | undefined, epoch: number | undefined) {
    const where: string[] = [`type IN ('network.request', 'network.finished')`];
    const params: Record<string, unknown> = {};
    if (sessionId !== undefined) {
      where.push('session_id = @sessionId');
      params.sessionId = sessionId;
    }
    if (epoch !== undefined) {
      where.push('epoch = @epoch');
      params.epoch = epoch;
    }
    const row = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN type = 'network.request'
             THEN COALESCE(json_extract(payload, '$.postDataSize'), 0) ELSE 0 END), 0) AS uploaded,
           COALESCE(SUM(CASE WHEN type = 'network.finished'
             THEN COALESCE(json_extract(payload, '$.encodedDataLength'), 0) ELSE 0 END), 0) AS downloaded,
           COALESCE(SUM(CASE WHEN type = 'network.request' THEN 1 ELSE 0 END), 0) AS requests
         FROM events WHERE ${where.join(' AND ')}`,
      )
      .get(params) as { uploaded: number; downloaded: number; requests: number };
    return {
      uploadedBytes: row.uploaded,
      downloadedBytes: row.downloaded,
      requestCount: row.requests,
    };
  }

  // -- sessions ------------------------------------------------------------

  upsertSession(input: SessionRowInput): void {
    this.db
      .prepare(
        `INSERT INTO sessions (session_id, target_key, started_at_wall, meta)
         VALUES (@sessionId, @targetKey, @startedAtWall, @meta)
         ON CONFLICT(session_id) DO UPDATE SET target_key = @targetKey, meta = @meta`,
      )
      .run({ ...input, meta: JSON.stringify(input.meta ?? {}) });
  }

  endSession(sessionId: string, endedAtWall: number): void {
    this.db
      .prepare('UPDATE sessions SET ended_at_wall = @endedAtWall WHERE session_id = @sessionId')
      .run({ sessionId, endedAtWall });
  }

  setEpoch(sessionId: string, epoch: number): void {
    this.db
      .prepare('UPDATE sessions SET current_epoch = @epoch WHERE session_id = @sessionId')
      .run({ sessionId, epoch });
  }

  listSessions(includeEnded: boolean): Array<{
    sessionId: string;
    targetKey: string;
    startedAtWall: number;
    endedAtWall?: number;
    currentEpoch: number;
    meta: Record<string, unknown>;
  }> {
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions ${includeEnded ? '' : 'WHERE ended_at_wall IS NULL'} ORDER BY started_at_wall DESC`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      sessionId: r.session_id as string,
      targetKey: r.target_key as string,
      startedAtWall: r.started_at_wall as number,
      endedAtWall: (r.ended_at_wall as number | null) ?? undefined,
      currentEpoch: r.current_epoch as number,
      meta: JSON.parse(r.meta as string) as Record<string, unknown>,
    }));
  }

  // -- blobs (content-addressed, refcounted) --------------------------------

  putBlob(blobId: string, data: Buffer, nowWall: number): void {
    this.db
      .prepare(
        `INSERT INTO blobs (blob_id, size, refcount, created_at_wall, last_access_wall, data)
         VALUES (@blobId, @size, 1, @now, @now, @data)
         ON CONFLICT(blob_id) DO UPDATE SET refcount = refcount + 1, last_access_wall = @now`,
      )
      .run({ blobId, size: data.byteLength, now: nowWall, data });
  }

  getBlob(blobId: string, nowWall: number): Buffer | undefined {
    const row = this.db.prepare('SELECT data FROM blobs WHERE blob_id = @blobId').get({ blobId }) as
      | { data: Buffer }
      | undefined;
    if (row) {
      this.db
        .prepare('UPDATE blobs SET last_access_wall = @now WHERE blob_id = @blobId')
        .run({ blobId, now: nowWall });
    }
    return row?.data;
  }

  // -- samples ---------------------------------------------------------------

  addSamples(samples: Sample[]): void {
    const insert = this.db.prepare(
      `INSERT INTO samples (session_id, kind, resolution, ts_wall, ts_mono, value)
       VALUES (@sessionId, @kind, @resolution, @tsWall, @tsMono, @value)`,
    );
    const tx = this.db.transaction((batch: Sample[]) => {
      for (const s of batch) insert.run({ ...s, resolution: s.resolution ?? 0 });
    });
    tx(samples);
  }

  querySamples(input: {
    sessionId: string;
    kinds?: string[];
    resolution: number;
    tsMonoMin?: number;
    tsMonoMax?: number;
  }): Sample[] {
    const where = ['session_id = @sessionId', 'resolution = @resolution'];
    const params: Record<string, unknown> = {
      sessionId: input.sessionId,
      resolution: input.resolution,
    };
    if (input.kinds && input.kinds.length > 0) {
      const placeholders = input.kinds.map((_, i) => `@kind${i}`);
      where.push(`kind IN (${placeholders.join(', ')})`);
      input.kinds.forEach((k, i) => (params[`kind${i}`] = k));
    }
    if (input.tsMonoMin !== undefined) {
      where.push('ts_mono >= @tsMonoMin');
      params.tsMonoMin = input.tsMonoMin;
    }
    if (input.tsMonoMax !== undefined) {
      where.push('ts_mono <= @tsMonoMax');
      params.tsMonoMax = input.tsMonoMax;
    }
    const rows = this.db
      .prepare(`SELECT * FROM samples WHERE ${where.join(' AND ')} ORDER BY ts_mono ASC`)
      .all(params) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      sessionId: r.session_id as string,
      kind: r.kind as never,
      resolution: r.resolution as never,
      tsWall: r.ts_wall as number,
      tsMono: r.ts_mono as number,
      value: r.value as number,
    }));
  }

  /**
   * Roll samples up a resolution tier (0→1s, 1→10s, 10→60s buckets, averaged)
   * and delete the finer rows. Each tier has its own age cutoff so recent data
   * stays fine-grained while old data coarsens (raw→1s after minutes, 1s→10s
   * after an hour, 10s→60s after a day, on the default schedule).
   */
  rollupSamples(cutoffs: { to1s?: number; to10s?: number; to60s?: number }): void {
    const tiers: Array<[number, number, number | undefined]> = [
      [0, 1, cutoffs.to1s],
      [1, 10, cutoffs.to10s],
      [10, 60, cutoffs.to60s],
    ];
    const tx = this.db.transaction(() => {
      for (const [from, to, cutoff] of tiers) {
        if (cutoff === undefined) continue;
        this.db
          .prepare(
            `INSERT INTO samples (session_id, kind, resolution, ts_wall, ts_mono, value)
             SELECT session_id, kind, @to,
                    MIN(ts_wall), CAST(ts_mono / (@to * 1000.0) AS INTEGER) * (@to * 1000.0),
                    AVG(value)
             FROM samples
             WHERE resolution = @from AND ts_mono < @cutoff
             GROUP BY session_id, kind, CAST(ts_mono / (@to * 1000.0) AS INTEGER)`,
          )
          .run({ from, to, cutoff });
        this.db
          .prepare('DELETE FROM samples WHERE resolution = @from AND ts_mono < @cutoff')
          .run({ from, cutoff });
      }
    });
    tx();
  }

  // -- snapshots --------------------------------------------------------------

  saveSnapshot(input: {
    snapshotId: string;
    sessionId?: string;
    name?: string;
    createdAtWall: number;
    pinned: boolean;
    eventIdAtCapture?: number;
    document: string;
  }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO snapshots
           (snapshot_id, session_id, name, created_at_wall, pinned, event_id_at_capture, document)
         VALUES (@snapshotId, @sessionId, @name, @createdAtWall, @pinned, @eventIdAtCapture, @document)`,
      )
      .run({
        ...input,
        sessionId: input.sessionId ?? null,
        name: input.name ?? null,
        eventIdAtCapture: input.eventIdAtCapture ?? null,
        pinned: input.pinned ? 1 : 0,
      });
  }

  getSnapshot(snapshotId: string): { document: string } | undefined {
    return this.db
      .prepare('SELECT document FROM snapshots WHERE snapshot_id = @snapshotId')
      .get({ snapshotId }) as { document: string } | undefined;
  }

  listSnapshots(sessionId?: string): Array<{
    snapshotId: string;
    name?: string;
    createdAtWall: number;
    pinned: boolean;
    url?: string;
  }> {
    const rows = (
      sessionId
        ? this.db
            .prepare('SELECT * FROM snapshots WHERE session_id = @sessionId ORDER BY created_at_wall DESC')
            .all({ sessionId })
        : this.db.prepare('SELECT * FROM snapshots ORDER BY created_at_wall DESC').all()
    ) as Array<Record<string, unknown>>;
    return rows.map((r) => {
      let url: string | undefined;
      try {
        url = (JSON.parse(r.document as string) as { url?: string }).url;
      } catch {
        url = undefined;
      }
      return {
        snapshotId: r.snapshot_id as string,
        name: (r.name as string | null) ?? undefined,
        createdAtWall: r.created_at_wall as number,
        pinned: Boolean(r.pinned),
        url,
      };
    });
  }

  // -- retention ---------------------------------------------------------------

  dbSizeBytes(): number {
    const row = this.db
      .prepare(
        'SELECT page_count * page_size AS size FROM pragma_page_count(), pragma_page_size()',
      )
      .get() as { size: number };
    return row.size;
  }

  /**
   * Size-targeted retention (AD-6): blobs LRU-evict first (envelope survives,
   * blob_evicted flagged), then whole ended sessions prune oldest-first —
   * except events ±30 s around pinned snapshots.
   */
  enforceRetention(config: RetentionConfig, _nowWall: number): { blobsEvicted: number; sessionsPruned: number } {
    let blobsEvicted = 0;
    let sessionsPruned = 0;
    if (this.dbSizeBytes() <= config.sizeTargetBytes) return { blobsEvicted, sessionsPruned };

    // Tier 1: LRU blob eviction.
    const candidates = this.db
      .prepare('SELECT blob_id, size FROM blobs ORDER BY last_access_wall ASC LIMIT 200')
      .all() as Array<{ blob_id: string; size: number }>;
    for (const c of candidates) {
      if (this.dbSizeBytes() <= config.sizeTargetBytes) break;
      this.db.prepare('DELETE FROM blobs WHERE blob_id = @id').run({ id: c.blob_id });
      this.db
        .prepare('UPDATE events SET blob_evicted = 1 WHERE blob_id = @id')
        .run({ id: c.blob_id });
      blobsEvicted++;
    }

    // Tier 2: prune whole ended sessions, oldest first, sparing pinned windows.
    if (this.dbSizeBytes() > config.sizeTargetBytes) {
      const sessions = this.db
        .prepare(
          'SELECT session_id FROM sessions WHERE ended_at_wall IS NOT NULL ORDER BY ended_at_wall ASC',
        )
        .all() as Array<{ session_id: string }>;
      for (const s of sessions) {
        if (this.dbSizeBytes() <= config.sizeTargetBytes) break;
        const pins = this.db
          .prepare(
            `SELECT e.ts_mono AS ts FROM snapshots sn JOIN events e ON e.id = sn.event_id_at_capture
             WHERE sn.pinned = 1 AND e.session_id = @sid`,
          )
          .all({ sid: s.session_id }) as Array<{ ts: number }>;
        if (pins.length === 0) {
          this.db.prepare('DELETE FROM events WHERE session_id = @sid').run({ sid: s.session_id });
          this.db.prepare('DELETE FROM samples WHERE session_id = @sid').run({ sid: s.session_id });
          this.db.prepare('DELETE FROM sessions WHERE session_id = @sid').run({ sid: s.session_id });
        } else {
          const conditions = pins.map((_, i) => `NOT (ts_mono BETWEEN @lo${i} AND @hi${i})`);
          const params: Record<string, unknown> = { sid: s.session_id };
          pins.forEach((p, i) => {
            params[`lo${i}`] = p.ts - 30_000;
            params[`hi${i}`] = p.ts + 30_000;
          });
          this.db
            .prepare(
              `DELETE FROM events WHERE session_id = @sid AND ${conditions.join(' AND ')}`,
            )
            .run(params);
        }
        sessionsPruned++;
      }
      this.db.exec('VACUUM');
    }
    return { blobsEvicted, sessionsPruned };
  }

  checkpoint(): void {
    this.db.pragma('wal_checkpoint(TRUNCATE)');
  }

  close(): void {
    this.db.close();
  }
}
