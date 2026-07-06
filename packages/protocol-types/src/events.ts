import { z } from 'zod';

/**
 * Event taxonomy (AD-6). Dotted `type` strings; every event shares the envelope
 * and carries a type-specific payload. Payloads stay small — large bodies go to
 * the content-addressed blob store and are referenced by `blobId` on the
 * envelope. High-frequency fixed-shape series (heap, DOM count, fps) are NOT
 * events; they live in the `samples` table (see `SampleSchema`).
 */

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export const ActorSchema = z.enum(['app', 'user', 'ui', 'mcp', 'palette', 'system']);
export type Actor = z.infer<typeof ActorSchema>;

/** Fields shared by every event. `id` is assigned by the store on write. */
export const EventEnvelopeBase = z.object({
  id: z.number().int().nonnegative().optional(),
  sessionId: z.string(),
  /** Sub-target attribution (OOPIF / worker / service worker) within the session. */
  targetId: z.string().optional(),
  /** Increments only on explicit refresh — SPA route changes do not bump it. */
  epoch: z.number().int().nonnegative(),
  /** Wall-clock ms since Unix epoch. */
  tsWall: z.number(),
  /** Host-session monotonic ms — the shared timeline across page/network/server. */
  tsMono: z.number(),
  actor: ActorSchema,
  /** Correlation keys — nullable columns in the store, indexed. */
  requestId: z.string().optional(),
  traceId: z.string().optional(),
  spanId: z.string().optional(),
  /** Content-addressed blob reference (bodies, frames, screenshots). */
  blobId: z.string().optional(),
  /** Set by retention when the blob was LRU-evicted; the envelope survives. */
  blobEvicted: z.boolean().optional(),
});

function event<T extends string, P extends z.ZodType>(type: T, payload: P) {
  return EventEnvelopeBase.extend({ type: z.literal(type), payload });
}

// ---------------------------------------------------------------------------
// Shared fragments
// ---------------------------------------------------------------------------

export const HeadersSchema = z.record(z.string(), z.string());

export const StackFrameSchema = z.object({
  functionName: z.string().optional(),
  url: z.string().optional(),
  file: z.string().optional(),
  line: z.number().int().optional(),
  column: z.number().int().optional(),
});
export const TrimmedStackSchema = z.array(StackFrameSchema).max(20);

export const ResourceTypeSchema = z.enum([
  'document',
  'stylesheet',
  'image',
  'media',
  'font',
  'script',
  'xhr',
  'fetch',
  'eventsource',
  'websocket',
  'manifest',
  'other',
]);

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

export const SessionAttachedEvent = event(
  'session.attached',
  z.object({
    url: z.string(),
    targetType: z.enum(['page', 'iframe', 'worker', 'service_worker']),
    port: z.number().int().optional(),
    frameworks: z.array(z.string()).optional(),
  }),
);

export const SessionDetachedEvent = event(
  'session.detached',
  z.object({ reason: z.string().optional() }),
);

/** `isRefresh: true` is the signal that bumped the epoch (invariant 7). */
export const SessionNavigatedEvent = event(
  'session.navigated',
  z.object({ url: z.string(), isRefresh: z.boolean() }),
);

export const PageLifecycleEvent = event(
  'page.lifecycle',
  z.object({ phase: z.enum(['domContentLoaded', 'load', 'networkIdle']) }),
);

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

export const NetworkRequestEvent = event(
  'network.request',
  z.object({
    url: z.string(),
    method: z.string(),
    headers: HeadersSchema,
    resourceType: ResourceTypeSchema.optional(),
    /** CDP documentURL: the page the request originated from, exact even for same-tick SPA route + fetch. */
    documentUrl: z.string().optional(),
    hasPostData: z.boolean().optional(),
    postDataSize: z.number().int().optional(),
    initiator: z
      .object({
        kind: z.enum(['parser', 'script', 'preload', 'other']),
        stack: TrimmedStackSchema.optional(),
      })
      .optional(),
    /** Set when the response was served by a mock intercept. */
    mockedBy: z.string().optional(),
    /** Parsed from the request body when the request is GraphQL. */
    graphqlOperation: z.string().optional(),
    graphqlKind: z.enum(['query', 'mutation', 'subscription']).optional(),
  }),
);

export const NetworkResponseEvent = event(
  'network.response',
  z.object({
    url: z.string(),
    status: z.number().int(),
    statusText: z.string().optional(),
    headers: HeadersSchema,
    mimeType: z.string().optional(),
    fromServiceWorker: z.boolean().optional(),
    fromCache: z.boolean().optional(),
    remoteAddress: z.string().optional(),
    timing: z
      .object({
        dnsMs: z.number().optional(),
        connectMs: z.number().optional(),
        tlsMs: z.number().optional(),
        ttfbMs: z.number().optional(),
      })
      .optional(),
  }),
);

/** Body persisted eagerly on loadingFinished (bodies evict from Chromium buffers). */
export const NetworkFinishedEvent = event(
  'network.finished',
  z.object({
    encodedDataLength: z.number(),
    decodedBodySize: z.number().optional(),
    bodyTruncated: z.boolean().optional(),
  }),
);

export const NetworkFailedEvent = event(
  'network.failed',
  z.object({ errorText: z.string(), canceled: z.boolean().optional() }),
);

export const WsCreatedEvent = event('network.ws.created', z.object({ url: z.string() }));

const wsFramePayload = z.object({
  opcode: z.number().int().optional(),
  payloadSize: z.number().int(),
  /** First N chars for list rendering; full frame goes to the blob store. */
  payloadPreview: z.string().optional(),
});
export const WsFrameSentEvent = event('network.ws.frameSent', wsFramePayload);
export const WsFrameReceivedEvent = event('network.ws.frameReceived', wsFramePayload);

export const WsClosedEvent = event(
  'network.ws.closed',
  z.object({ code: z.number().int().optional(), reason: z.string().optional() }),
);

export const SseEventEvent = event(
  'network.sse.event',
  z.object({
    eventName: z.string().optional(),
    dataSize: z.number().int(),
    dataPreview: z.string().optional(),
  }),
);

// ---------------------------------------------------------------------------
// Console + errors
// ---------------------------------------------------------------------------

export const LogLevelSchema = z.enum(['debug', 'log', 'info', 'warn', 'error']);

export const ConsoleEntryEvent = event(
  'console.entry',
  z.object({
    level: LogLevelSchema,
    source: z.enum(['page', 'worker', 'server', 'localcoast']),
    text: z.string(),
    /** Bounded-depth serialized argument previews. */
    args: z.array(z.unknown()).optional(),
    stack: TrimmedStackSchema.optional(),
    /** Present when the entry parsed as a structured (pino/winston/bunyan) log line. */
    structured: z
      .object({
        levelLabel: z.string().optional(),
        serviceName: z.string().optional(),
        fields: z.record(z.string(), z.unknown()),
      })
      .optional(),
  }),
);

export const ErrorUncaughtEvent = event(
  'error.uncaught',
  z.object({
    message: z.string(),
    stack: TrimmedStackSchema.optional(),
    rawStack: z.string().optional(),
    url: z.string().optional(),
    line: z.number().int().optional(),
    column: z.number().int().optional(),
    /** Stable fingerprint for aggregation/grouping. */
    fingerprint: z.string().optional(),
  }),
);

export const ErrorRejectionEvent = event(
  'error.rejection',
  z.object({
    message: z.string(),
    stack: TrimmedStackSchema.optional(),
    rawStack: z.string().optional(),
    fingerprint: z.string().optional(),
  }),
);

export const ErrorResourceEvent = event(
  'error.resource',
  z.object({
    url: z.string(),
    resourceType: ResourceTypeSchema.optional(),
    status: z.number().int().optional(),
  }),
);

// ---------------------------------------------------------------------------
// Storage trail (page-agent main-world patches)
// ---------------------------------------------------------------------------

export const StorageAreaSchema = z.enum(['localStorage', 'sessionStorage', 'cookie']);

export const StorageOpEvent = event(
  'storage.op',
  z.object({
    area: StorageAreaSchema,
    op: z.enum(['read', 'write', 'remove', 'clear']),
    key: z.string().optional(),
    valueSize: z.number().int().optional(),
    valuePreview: z.string().optional(),
    stack: TrimmedStackSchema.optional(),
  }),
);

// ---------------------------------------------------------------------------
// Framework state
// ---------------------------------------------------------------------------

export const FrameworkSchema = z.enum(['react', 'vue', 'svelte', 'unknown']);

export const StateCommitEvent = event(
  'state.commit',
  z.object({
    framework: FrameworkSchema,
    componentPath: z.string().optional(),
    durationMs: z.number().optional(),
    renderCount: z.number().int().optional(),
  }),
);

/** Redux-DevTools-shim / Pinia store action. Serialized state goes to a blob. */
export const StateActionEvent = event(
  'state.action',
  z.object({
    storeId: z.string(),
    actionType: z.string(),
    payloadPreview: z.string().optional(),
  }),
);

export const StateRouteEvent = event(
  'state.route',
  z.object({
    from: z.string().optional(),
    to: z.string(),
    kind: z.enum(['push', 'replace', 'pop', 'hashchange']),
  }),
);

// ---------------------------------------------------------------------------
// Command audit (invariant: every command logs an action event with its actor)
// ---------------------------------------------------------------------------

export const ActionDispatchedEvent = event(
  'action.dispatched',
  z.object({
    capability: z.string(),
    argsPreview: z.string().optional(),
    ok: z.boolean(),
    error: z.string().optional(),
    durationMs: z.number().optional(),
  }),
);

// ---------------------------------------------------------------------------
// Build / HMR (Tier-0 HMR sniffing and up)
// ---------------------------------------------------------------------------

export const BuildToolSchema = z.enum(['vite', 'webpack', 'next', 'turbopack', 'unknown']);

export const BuildStatusEvent = event(
  'build.status',
  z.object({
    state: z.enum(['building', 'ok', 'error']),
    port: z.number().int().optional(),
    tool: BuildToolSchema.optional(),
    durationMs: z.number().optional(),
    changedFiles: z.array(z.string()).optional(),
  }),
);

export const BuildErrorEvent = event(
  'build.error',
  z.object({
    message: z.string(),
    file: z.string().optional(),
    line: z.number().int().optional(),
    column: z.number().int().optional(),
    rule: z.string().optional(),
    severity: z.enum(['error', 'warning']),
    source: z.enum(['ts', 'eslint', 'build', 'unknown']),
  }),
);

export const HmrUpdateEvent = event(
  'hmr.update',
  z.object({
    kind: z.enum(['hot', 'full']),
    port: z.number().int().optional(),
    file: z.string().optional(),
    modules: z.array(z.string()).optional(),
    latencyMs: z.number().optional(),
    tool: BuildToolSchema.optional(),
  }),
);

// ---------------------------------------------------------------------------
// Server registry / health
// ---------------------------------------------------------------------------

export const ServerDiscoveredEvent = event(
  'server.discovered',
  z.object({
    port: z.number().int(),
    pid: z.number().int().optional(),
    cmd: z.string().optional(),
    cwd: z.string().optional(),
    protocol: z.enum(['http', 'https']),
    frameworkHint: z.string().optional(),
  }),
);

export const ServerLostEvent = event('server.lost', z.object({ port: z.number().int() }));

export const ServerHealthEvent = event(
  'server.health',
  z.object({
    port: z.number().int(),
    healthy: z.boolean(),
    latencyMs: z.number().optional(),
    checkKind: z.enum(['http', 'tcp']),
  }),
);

// ---------------------------------------------------------------------------
// Server-side ingestors (Tier 1/2)
// ---------------------------------------------------------------------------

export const DbQueryEvent = event(
  'db.query',
  z.object({
    sql: z.string(),
    driver: z.string().optional(),
    durationMs: z.number().optional(),
    rowCount: z.number().int().optional(),
    stack: TrimmedStackSchema.optional(),
    /** Set by N+1 detection: queries sharing a normalized shape within one load. */
    duplicateGroup: z.string().optional(),
  }),
);

export const TraceSpanEvent = event(
  'trace.span',
  z.object({
    name: z.string(),
    serviceName: z.string().optional(),
    parentSpanId: z.string().optional(),
    startTsWall: z.number(),
    endTsWall: z.number(),
    attrs: z.record(z.string(), z.unknown()).optional(),
    statusCode: z.enum(['unset', 'ok', 'error']).optional(),
  }),
);

export const TestRunEvent = event(
  'test.run',
  z.object({
    runner: z.enum(['vitest', 'jest', 'playwright', 'unknown']),
    status: z.enum(['started', 'finished']),
    total: z.number().int().optional(),
    passed: z.number().int().optional(),
    failed: z.number().int().optional(),
  }),
);

export const TestResultEvent = event(
  'test.result',
  z.object({
    name: z.string(),
    file: z.string().optional(),
    status: z.enum(['passed', 'failed', 'skipped']),
    durationMs: z.number().optional(),
    error: z.string().optional(),
  }),
);

// ---------------------------------------------------------------------------
// Snapshots / perf
// ---------------------------------------------------------------------------

export const RestoreItemStatusSchema = z.enum([
  'restored',
  'skipped:unserializable',
  'skipped:unmatched',
  'skipped:prod-build',
]);

export const RestoreReportSchema = z.object({
  items: z.array(z.object({ path: z.string(), status: RestoreItemStatusSchema })),
});
export type RestoreReport = z.infer<typeof RestoreReportSchema>;

export const SnapshotCapturedEvent = event(
  'snapshot.captured',
  z.object({ snapshotId: z.string(), name: z.string().optional(), kinds: z.array(z.string()) }),
);

export const SnapshotRestoredEvent = event(
  'snapshot.restored',
  z.object({ snapshotId: z.string(), report: RestoreReportSchema }),
);

export const PerfLongTaskEvent = event(
  'perf.longTask',
  z.object({ durationMs: z.number(), attribution: z.string().optional() }),
);

// ---------------------------------------------------------------------------
// Union + helpers
// ---------------------------------------------------------------------------

export const AnyEventSchema = z.discriminatedUnion('type', [
  SessionAttachedEvent,
  SessionDetachedEvent,
  SessionNavigatedEvent,
  PageLifecycleEvent,
  NetworkRequestEvent,
  NetworkResponseEvent,
  NetworkFinishedEvent,
  NetworkFailedEvent,
  WsCreatedEvent,
  WsFrameSentEvent,
  WsFrameReceivedEvent,
  WsClosedEvent,
  SseEventEvent,
  ConsoleEntryEvent,
  ErrorUncaughtEvent,
  ErrorRejectionEvent,
  ErrorResourceEvent,
  StorageOpEvent,
  StateCommitEvent,
  StateActionEvent,
  StateRouteEvent,
  ActionDispatchedEvent,
  BuildStatusEvent,
  BuildErrorEvent,
  HmrUpdateEvent,
  ServerDiscoveredEvent,
  ServerLostEvent,
  ServerHealthEvent,
  DbQueryEvent,
  TraceSpanEvent,
  TestRunEvent,
  TestResultEvent,
  SnapshotCapturedEvent,
  SnapshotRestoredEvent,
  PerfLongTaskEvent,
]);

export type AnyEvent = z.infer<typeof AnyEventSchema>;
export type EventType = AnyEvent['type'];
export type EventOfType<T extends EventType> = Extract<AnyEvent, { type: T }>;

export const EVENT_TYPES = AnyEventSchema.options.map(
  (o) => o.shape.type.value,
) as readonly EventType[];

/** An event as it exists after a store write: id assigned. */
export type StoredEvent = AnyEvent & { id: number };

// ---------------------------------------------------------------------------
// Samples — high-frequency fixed-shape series, kept out of `events` (AD-6)
// ---------------------------------------------------------------------------

export const SampleKindSchema = z.enum(['heapBytes', 'domNodes', 'listeners', 'fps', 'cpu']);
export type SampleKind = z.infer<typeof SampleKindSchema>;

export const SampleSchema = z.object({
  sessionId: z.string(),
  kind: SampleKindSchema,
  tsWall: z.number(),
  tsMono: z.number(),
  value: z.number(),
  /** Rollup resolution: 0 = raw, otherwise seconds-per-bucket (1, 10, 60). */
  resolution: z.union([z.literal(0), z.literal(1), z.literal(10), z.literal(60)]).default(0),
});
export type Sample = z.infer<typeof SampleSchema>;
