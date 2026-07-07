import { createServer, type Server } from 'node:http';
import type { EventStore } from '@localcoast/core';
import { AnyEventSchema, type AnyEvent } from '@localcoast/protocol-types';

/**
 * Server-side ingest handling (AD-8 Tier 1/2). Two feeds:
 *  - HTTP /ingest on the MCP server: run-wrapper / node-agent / reporters
 *  - OTLP receiver on 4317/4318: apps already exporting OpenTelemetry
 * Both funnel into ONE synthetic "server" session so server-side signals share
 * the timeline with page/network events. Every incoming record is validated
 * against the event taxonomy before it lands (untrusted-input discipline).
 */

const SERVER_SESSION = 'server-side';

export class IngestSink {
  /** Memoized so concurrent first ingests share ONE startSession, never race a double-start. */
  private sessionReady: Promise<void> | null = null;

  constructor(private readonly store: EventStore) {}

  ensureSession(): Promise<void> {
    this.sessionReady ??= this.store
      .startSession({ sessionId: SERVER_SESSION, targetKey: 'server-side' })
      .then(() => undefined)
      .catch((err: unknown) => {
        // Reset so a transient failure can be retried by the next ingest.
        this.sessionReady = null;
        throw err;
      });
    return this.sessionReady;
  }

  /** Accept a batch of partially-shaped events, stamp + validate, store. */
  ingest(events: unknown[]): void {
    this.ensureSession()
      .then(() => {
        for (const raw of events) {
          if (raw === null || typeof raw !== 'object') continue;
          const candidate = {
            sessionId: SERVER_SESSION,
            epoch: this.store.currentEpoch(SERVER_SESSION),
            tsWall: Date.now(),
            tsMono: performance.now(),
            ...(raw as Record<string, unknown>),
          };
          const parsed = AnyEventSchema.safeParse(candidate);
          if (parsed.success) this.store.append(parsed.data as AnyEvent);
        }
      })
      .catch((err: unknown) => {
        console.error('ingest: failed to store batch:', err);
      });
  }
}

/**
 * Minimal OTLP/HTTP receiver (AD-8): accepts JSON-encoded traces on
 * :4318/v1/traces and stores them as trace.span events. Binds with fallback so
 * a real user collector on 4318 wins (we simply don't receive). Protobuf OTLP
 * is out of scope for v1 — JSON exporters (very common in dev) work.
 */
export class OtlpReceiver {
  private server: Server | null = null;
  port = 0;

  constructor(private readonly sink: IngestSink) {}

  async start(preferredPort = 4318): Promise<boolean> {
    this.server = createServer((req, res) => {
      if (req.method !== 'POST' || !req.url?.startsWith('/v1/traces')) {
        res.writeHead(404).end();
        return;
      }
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        try {
          this.handleTraces(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{}');
        } catch {
          res.writeHead(400).end();
        }
      })();
    });
    return new Promise((resolve) => {
      this.server!.once('error', () => {
        // Port taken (likely a real collector) — degrade quietly.
        this.server = null;
        resolve(false);
      });
      this.server!.listen(preferredPort, '127.0.0.1', () => {
        this.port = preferredPort;
        resolve(true);
      });
    });
  }

  private handleTraces(body: unknown): void {
    const events: unknown[] = [];
    const resourceSpans = (body as { resourceSpans?: unknown[] })?.resourceSpans ?? [];
    for (const rs of resourceSpans) {
      const resourceAttrs = attrsToObject(
        (rs as { resource?: { attributes?: unknown[] } })?.resource?.attributes ?? [],
      );
      const serviceName = String(resourceAttrs['service.name'] ?? 'unknown');
      for (const ss of (rs as { scopeSpans?: unknown[] }).scopeSpans ?? []) {
        for (const span of (ss as { spans?: unknown[] }).spans ?? []) {
          const s = span as {
            name?: string;
            spanId?: string;
            parentSpanId?: string;
            traceId?: string;
            startTimeUnixNano?: string;
            endTimeUnixNano?: string;
            attributes?: unknown[];
            status?: { code?: number };
          };
          events.push({
            type: 'trace.span',
            actor: 'app',
            traceId: s.traceId,
            spanId: s.spanId,
            payload: {
              name: s.name ?? 'span',
              serviceName,
              parentSpanId: s.parentSpanId || undefined,
              startTsWall: nanoToMs(s.startTimeUnixNano),
              endTsWall: nanoToMs(s.endTimeUnixNano),
              attrs: attrsToObject(s.attributes ?? []),
              statusCode: s.status?.code === 2 ? 'error' : s.status?.code === 1 ? 'ok' : 'unset',
            },
          });
        }
      }
    }
    if (events.length > 0) this.sink.ingest(events);
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }
}

function nanoToMs(nano?: string): number {
  return nano ? Number(BigInt(nano) / 1_000_000n) : Date.now();
}

function attrsToObject(attrs: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const attr of attrs) {
    const a = attr as { key?: string; value?: Record<string, unknown> };
    if (!a.key) continue;
    const v = a.value ?? {};
    out[a.key] = v.stringValue ?? v.intValue ?? v.boolValue ?? v.doubleValue ?? undefined;
  }
  return out;
}
