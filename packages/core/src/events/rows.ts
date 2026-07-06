import type { AnyEvent } from '@localcoast/protocol-types';

/**
 * Pure row/filter types + conversions shared by the store facade and every
 * writer backend. This module must stay free of better-sqlite3 imports: the
 * Electron main process loads it, and the native module only exists inside
 * the writer's own thread/process.
 */

export interface EventRow {
  id: number;
  sessionId: string;
  targetId?: string;
  epoch: number;
  tsWall: number;
  tsMono: number;
  type: string;
  actor: string;
  requestId?: string;
  traceId?: string;
  spanId?: string;
  payload: string;
  blobId?: string;
  blobEvicted: boolean;
}

export interface EventFilter {
  sessionId?: string;
  types?: string[];
  /** Resolved numeric epoch, or undefined for all epochs. */
  epoch?: number;
  requestId?: string;
  traceId?: string;
  tsMonoMin?: number;
  tsMonoMax?: number;
  beforeId?: number;
  limit: number;
}

export interface SessionRowInput {
  sessionId: string;
  targetKey: string;
  startedAtWall: number;
  meta?: Record<string, unknown>;
}

export interface RetentionConfig {
  /** Total DB size target in bytes (default 1.5 GB). */
  sizeTargetBytes: number;
}

export function toRow(event: AnyEvent & { id: number }): EventRow {
  return {
    id: event.id,
    sessionId: event.sessionId,
    targetId: event.targetId,
    epoch: event.epoch,
    tsWall: event.tsWall,
    tsMono: event.tsMono,
    type: event.type,
    actor: event.actor,
    requestId: event.requestId,
    traceId: event.traceId,
    spanId: event.spanId,
    payload: JSON.stringify(event.payload),
    blobId: event.blobId,
    blobEvicted: event.blobEvicted ?? false,
  };
}

export function fromRow(row: Record<string, unknown>): AnyEvent & { id: number } {
  return {
    id: row.id as number,
    sessionId: row.session_id as string,
    targetId: (row.target_id as string | null) ?? undefined,
    epoch: row.epoch as number,
    tsWall: row.ts_wall as number,
    tsMono: row.ts_mono as number,
    type: row.type as never,
    actor: row.actor as never,
    requestId: (row.request_id as string | null) ?? undefined,
    traceId: (row.trace_id as string | null) ?? undefined,
    spanId: (row.span_id as string | null) ?? undefined,
    payload: JSON.parse(row.payload as string) as never,
    blobId: (row.blob_id as string | null) ?? undefined,
    blobEvicted: Boolean(row.blob_evicted),
  } as AnyEvent & { id: number };
}
