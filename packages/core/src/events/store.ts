import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { AnyEventSchema, type AnyEvent, type Sample, type StoredEvent } from '@localcoast/protocol-types';
import type { Clock } from '../services.js';
import { systemClock } from '../services.js';
import { HotRing } from './ring.js';
import { decodeIpc, encodeIpc } from './ipc-codec.js';
import { toRow, type EventFilter, type RetentionConfig } from './rows.js';

/**
 * EventStore facade. Owns id assignment, epoch tracking, the hot ring, live
 * subscriptions, and write micro-batching (~16 ms / 200 events). All SQLite
 * work happens behind a backend (invariant 7):
 *  - WorkerBackend — worker thread; plain-Node hosts
 *  - ChildProcessBackend — spawned system-Node child; Electron hosts, where
 *    better-sqlite3's Node-ABI prebuild cannot load in-process
 *  - InProcessBackend — unit tests
 * better-sqlite3 is loaded lazily/behind process boundaries so importing this
 * module never pulls the native binding into an Electron main process.
 */

export interface StoreBackend {
  call<T = unknown>(method: string, ...args: unknown[]): Promise<T>;
  close(): Promise<void>;
}

type WriterLike = Record<string, (...a: unknown[]) => unknown>;

export class InProcessBackend implements StoreBackend {
  private writer: Promise<WriterLike>;

  constructor(dbPath: string) {
    this.writer = import('./writer.js').then(
      ({ SqliteWriter }) => new SqliteWriter(dbPath) as unknown as WriterLike,
    );
  }

  async call<T>(method: string, ...args: unknown[]): Promise<T> {
    const writer = await this.writer;
    const fn = writer[method];
    if (typeof fn !== 'function') throw new Error(`unknown writer method: ${method}`);
    return fn.apply(writer, args) as T;
  }

  async close(): Promise<void> {
    const writer = await this.writer;
    (writer.close as () => void).call(writer);
  }
}

export class ChildProcessBackend implements StoreBackend {
  private child: ChildProcess;
  private nextCallId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(dbPath: string, opts: { nodeBin?: string; childScript?: string } = {}) {
    const script =
      opts.childScript ?? new URL('./writer-child.js', import.meta.url).pathname;
    // JSON serialization on purpose: an Electron host and the system-Node
    // child run different V8s, and structured-clone framing is not
    // cross-version compatible. Buffers travel via the ipc-codec.
    this.child = spawn(opts.nodeBin ?? 'node', [script, dbPath], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      serialization: 'json',
    });
    this.child.on('message', (msg: { id: number; ok: boolean; result?: unknown; error?: string }) => {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.ok) entry.resolve(decodeIpc(msg.result));
      else entry.reject(new Error(msg.error ?? 'writer child error'));
    });
    this.child.on('exit', (code) => {
      const err = new Error(`writer child exited (${code})`);
      for (const entry of this.pending.values()) entry.reject(err);
      this.pending.clear();
    });
  }

  call<T>(method: string, ...args: unknown[]): Promise<T> {
    const id = this.nextCallId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.child.send({ id, method, args: encodeIpc(args) });
    });
  }

  async close(): Promise<void> {
    await this.call('close').catch(() => undefined);
    this.child.kill();
  }
}

export class WorkerBackend implements StoreBackend {
  private worker: Worker;
  private nextCallId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(dbPath: string, workerUrl?: URL) {
    this.worker = new Worker(workerUrl ?? new URL('./writer-worker.js', import.meta.url), {
      workerData: { dbPath },
    });
    this.worker.on('message', (msg: { id: number; ok: boolean; result?: unknown; error?: string }) => {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.ok) entry.resolve(msg.result);
      else entry.reject(new Error(msg.error ?? 'writer worker error'));
    });
    this.worker.on('error', (err) => {
      for (const entry of this.pending.values()) entry.reject(err);
      this.pending.clear();
    });
  }

  call<T>(method: string, ...args: unknown[]): Promise<T> {
    const id = this.nextCallId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ id, method, args });
    });
  }

  async close(): Promise<void> {
    await this.worker.terminate();
  }
}

export interface EventStoreOptions {
  backend: StoreBackend;
  clock?: Clock;
  batchMs?: number;
  batchMax?: number;
  ringWindowMs?: number;
  retention?: RetentionConfig;
}

export type EventListener = (event: StoredEvent) => void;

export interface SessionStartInput {
  sessionId: string;
  targetKey: string;
  meta?: Record<string, unknown>;
}

export class EventStore {
  private backend: StoreBackend;
  private clock: Clock;
  private ring: HotRing;
  private listeners = new Set<{ fn: EventListener; sessionId?: string; types?: Set<string> }>();
  private epochs = new Map<string, number>();
  private nextId = 1;
  private buffer: StoredEvent[] = [];
  private sampleBuffer: Sample[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private flushInFlight: Promise<void> = Promise.resolve();
  private batchMs: number;
  private batchMax: number;
  readonly retention: RetentionConfig;
  private opened = false;

  constructor(opts: EventStoreOptions) {
    this.backend = opts.backend;
    this.clock = opts.clock ?? systemClock;
    this.ring = new HotRing(opts.ringWindowMs ?? 90_000);
    this.batchMs = opts.batchMs ?? 16;
    this.batchMax = opts.batchMax ?? 200;
    this.retention = opts.retention ?? { sizeTargetBytes: 1.5 * 1024 * 1024 * 1024 };
  }

  async open(): Promise<void> {
    const maxId = await this.backend.call<number>('maxEventId');
    this.nextId = maxId + 1;
    const sessions = await this.backend.call<
      Array<{ sessionId: string; currentEpoch: number; endedAtWall?: number }>
    >('listSessions', true);
    for (const s of sessions) this.epochs.set(s.sessionId, s.currentEpoch);
    this.opened = true;
  }

  // -- sessions / epochs -----------------------------------------------------

  async startSession(input: SessionStartInput): Promise<void> {
    this.assertOpen();
    this.epochs.set(input.sessionId, 0);
    await this.backend.call('upsertSession', {
      sessionId: input.sessionId,
      targetKey: input.targetKey,
      startedAtWall: this.clock.wall(),
      meta: input.meta ?? {},
    });
  }

  async endSession(sessionId: string): Promise<void> {
    await this.flush();
    await this.backend.call('endSession', sessionId, this.clock.wall());
    this.ring.dropSession(sessionId);
  }

  currentEpoch(sessionId: string): number {
    return this.epochs.get(sessionId) ?? 0;
  }

  /** Merge keys into a session's meta (e.g. detected framework). */
  async setSessionMeta(sessionId: string, patch: Record<string, unknown>): Promise<void> {
    const sessions = await this.listSessions(true);
    const session = sessions.find((s) => s.sessionId === sessionId);
    if (!session) return;
    await this.backend.call('upsertSession', {
      sessionId,
      targetKey: session.targetKey,
      startedAtWall: session.startedAtWall,
      meta: { ...session.meta, ...patch },
    });
  }

  /** Explicit-refresh-only (invariant 7). Returns the new epoch. */
  async bumpEpoch(sessionId: string): Promise<number> {
    const next = this.currentEpoch(sessionId) + 1;
    this.epochs.set(sessionId, next);
    await this.backend.call('setEpoch', sessionId, next);
    return next;
  }

  // -- append ------------------------------------------------------------------

  /** Validate, assign id, write through the ring, notify subscribers, queue for SQLite. */
  append(event: AnyEvent): StoredEvent {
    this.assertOpen();
    const parsed = AnyEventSchema.parse(event);
    const stored = { ...parsed, id: this.nextId++ } as StoredEvent;
    this.ring.push(stored);
    for (const l of this.listeners) {
      if (l.sessionId && l.sessionId !== stored.sessionId) continue;
      if (l.types && !l.types.has(stored.type)) continue;
      l.fn(stored);
    }
    this.buffer.push(stored);
    this.scheduleFlush();
    return stored;
  }

  /** Convenience: fills timestamps + current epoch. */
  appendNow(
    event: Omit<AnyEvent, 'tsWall' | 'tsMono' | 'epoch'> & { epoch?: number },
  ): StoredEvent {
    return this.append({
      ...event,
      epoch: event.epoch ?? this.currentEpoch(event.sessionId),
      tsWall: this.clock.wall(),
      tsMono: this.clock.mono(),
    } as AnyEvent);
  }

  addSample(sample: Sample): void {
    this.assertOpen();
    this.sampleBuffer.push(sample);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.buffer.length + this.sampleBuffer.length >= this.batchMax) {
      void this.flush();
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => void this.flush(), this.batchMs);
      this.flushTimer.unref?.();
    }
  }

  /** Drain buffered writes to the backend; serialized so batches stay ordered. */
  flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const events = this.buffer;
    const samples = this.sampleBuffer;
    if (events.length === 0 && samples.length === 0) return this.flushInFlight;
    this.buffer = [];
    this.sampleBuffer = [];
    this.flushInFlight = this.flushInFlight.then(async () => {
      if (events.length > 0) {
        await this.backend.call('appendBatch', events.map((e) => toRow(e)));
      }
      if (samples.length > 0) {
        await this.backend.call('addSamples', samples);
      }
    });
    return this.flushInFlight;
  }

  // -- reads ---------------------------------------------------------------------

  /** Resolve an epoch filter ('current' needs a sessionId) to a concrete epoch or undefined (= all). */
  resolveEpoch(epoch: 'current' | 'all' | number, sessionId?: string): number | undefined {
    if (epoch === 'all') return undefined;
    if (epoch === 'current') {
      if (!sessionId) return undefined;
      return this.currentEpoch(sessionId);
    }
    return epoch;
  }

  async query(filter: Omit<EventFilter, 'epoch'> & { epoch?: number }): Promise<StoredEvent[]> {
    await this.flush();
    return this.backend.call<StoredEvent[]>('queryEvents', filter);
  }

  async networkTotals(sessionId: string | undefined, epoch: number | undefined) {
    await this.flush();
    return this.backend.call<{
      uploadedBytes: number;
      downloadedBytes: number;
      requestCount: number;
    }>('networkTotals', sessionId, epoch);
  }

  /** Zero-DB-read recent window from the hot ring (bug-bundle path). */
  recent(sessionId: string, ms: number): StoredEvent[] {
    return this.ring.recent(sessionId, ms, this.clock.mono());
  }

  onEvent(fn: EventListener, filter?: { sessionId?: string; types?: string[] }): () => void {
    const entry = {
      fn,
      sessionId: filter?.sessionId,
      types: filter?.types ? new Set(filter.types) : undefined,
    };
    this.listeners.add(entry);
    return () => this.listeners.delete(entry);
  }

  // -- blobs -----------------------------------------------------------------------

  async putBlob(data: Buffer): Promise<string> {
    const blobId = createHash('sha256').update(data).digest('hex').slice(0, 32);
    await this.backend.call('putBlob', blobId, data, this.clock.wall());
    return blobId;
  }

  async getBlob(blobId: string): Promise<Buffer | undefined> {
    const raw = await this.backend.call<Uint8Array | undefined>('getBlob', blobId, this.clock.wall());
    return raw ? Buffer.from(raw) : undefined;
  }

  // -- samples / sessions / snapshots -------------------------------------------------

  async querySamples(input: {
    sessionId: string;
    kinds?: string[];
    resolution: number;
    tsMonoMin?: number;
    tsMonoMax?: number;
  }): Promise<Sample[]> {
    await this.flush();
    return this.backend.call<Sample[]>('querySamples', input);
  }

  async listSessions(includeEnded: boolean) {
    return this.backend.call<
      Array<{
        sessionId: string;
        targetKey: string;
        startedAtWall: number;
        endedAtWall?: number;
        currentEpoch: number;
        meta: Record<string, unknown>;
      }>
    >('listSessions', includeEnded);
  }

  async saveSnapshot(input: {
    snapshotId: string;
    sessionId?: string;
    name?: string;
    pinned: boolean;
    eventIdAtCapture?: number;
    document: unknown;
  }): Promise<void> {
    await this.backend.call('saveSnapshot', {
      ...input,
      createdAtWall: this.clock.wall(),
      document: JSON.stringify(input.document),
    });
  }

  async getSnapshot(snapshotId: string): Promise<unknown | undefined> {
    const row = await this.backend.call<{ document: string } | undefined>('getSnapshot', snapshotId);
    return row ? (JSON.parse(row.document) as unknown) : undefined;
  }

  async listSnapshots(sessionId?: string) {
    return this.backend.call<
      Array<{ snapshotId: string; name?: string; createdAtWall: number; pinned: boolean; url?: string }>
    >('listSnapshots', sessionId);
  }

  // -- maintenance -------------------------------------------------------------------

  async enforceRetention(): Promise<{ blobsEvicted: number; sessionsPruned: number }> {
    await this.flush();
    return this.backend.call('enforceRetention', this.retention, this.clock.wall());
  }

  async rollupSamples(cutoffs: { to1s?: number; to10s?: number; to60s?: number }): Promise<void> {
    await this.flush();
    await this.backend.call('rollupSamples', cutoffs);
  }

  async close(): Promise<void> {
    await this.flush();
    await this.flushInFlight;
    await this.backend.close();
    this.opened = false;
  }

  private assertOpen(): void {
    if (!this.opened) throw new Error('EventStore not opened — call open() first');
  }
}
