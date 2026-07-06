import { z } from 'zod';
import {
  AnyEventSchema,
  BuildErrorEvent,
  LogLevelSchema,
  ResourceTypeSchema,
  RestoreReportSchema,
  SampleKindSchema,
  SampleSchema,
} from './events.js';
import { AssertionResultSchema, AssertionSchema } from './assertions.js';

/**
 * Capability IO schemas (AD-5 / AD-7). Inputs and outputs for every registry
 * capability. Descriptions and surface flags attach at registration time in
 * core; this module is the wire contract only.
 */

// ---------------------------------------------------------------------------
// Shared fragments
// ---------------------------------------------------------------------------

/** Most queries scope to one attached session (a guest tab). */
export const SessionScope = z.object({ sessionId: z.string() });

/** Epoch filter default is 'current': persists across SPA navigation, resets on refresh — as a view filter, never a deletion. */
export const EpochFilterSchema = z
  .union([z.literal('current'), z.literal('all'), z.number().int().nonnegative()])
  .default('current');

export const PageQuerySchema = z.object({
  limit: z.number().int().positive().max(1000).default(100),
  /** Return events with id < beforeId (reverse-chronological pagination). */
  beforeId: z.number().int().optional(),
});

export const StoredEventSchema = AnyEventSchema.and(
  z.object({ id: z.number().int().nonnegative() }),
);

export const CookieRecordSchema = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string().optional(),
  path: z.string().optional(),
  expires: z.number().optional(),
  httpOnly: z.boolean().optional(),
  secure: z.boolean().optional(),
  sameSite: z.enum(['Strict', 'Lax', 'None']).optional(),
});
export type CookieRecord = z.infer<typeof CookieRecordSchema>;

export const BodySchema = z.object({
  encoding: z.enum(['utf8', 'base64']),
  data: z.string(),
  truncated: z.boolean().default(false),
  originalSize: z.number().int().optional(),
  /** True when retention evicted the blob; `data` is empty. */
  evicted: z.boolean().default(false),
});

// ---------------------------------------------------------------------------
// events.* — the timeline spine
// ---------------------------------------------------------------------------

export const EventsQueryInput = z.object({
  sessionId: z.string().optional(),
  types: z.array(z.string()).optional(),
  epoch: EpochFilterSchema,
  requestId: z.string().optional(),
  traceId: z.string().optional(),
  tsMonoMin: z.number().optional(),
  tsMonoMax: z.number().optional(),
  ...PageQuerySchema.shape,
});
export const EventsQueryOutput = z.object({
  events: z.array(StoredEventSchema),
  /** Pass as beforeId to continue paging; absent when exhausted. */
  nextBeforeId: z.number().int().optional(),
});

export const EventsSubscribeInput = z.object({
  sessionId: z.string().optional(),
  types: z.array(z.string()).optional(),
});
export const EventsSubscribeOutput = StoredEventSchema;

// ---------------------------------------------------------------------------
// session.observe — the composite Observation API (AD-7)
// ---------------------------------------------------------------------------

export const ObserveInclude = z.object({
  a11y: z.boolean().default(true),
  componentTree: z.boolean().default(true),
  network: z.boolean().default(true),
  console: z.boolean().default(true),
});

export const A11yNodeSchema: z.ZodType<{
  role: string;
  name?: string;
  value?: string;
  focused?: boolean;
  children?: unknown[];
}> = z.object({
  role: z.string(),
  name: z.string().optional(),
  value: z.string().optional(),
  focused: z.boolean().optional(),
  children: z.array(z.lazy(() => A11yNodeSchema)).optional(),
}) as never;

export const ComponentTreeNodeSchema: z.ZodType<{
  name: string;
  framework?: string;
  sourcePath?: string;
  children?: unknown[];
}> = z.object({
  name: z.string(),
  framework: z.string().optional(),
  /** Repo-relative when resolvable (L2). */
  sourcePath: z.string().optional(),
  children: z.array(z.lazy(() => ComponentTreeNodeSchema)).optional(),
}) as never;

export const InFlightRequestSchema = z.object({
  requestId: z.string(),
  url: z.string(),
  method: z.string(),
  elapsedMs: z.number(),
});

export const SessionObserveInput = SessionScope.extend({
  include: ObserveInclude.prefault({}),
  /** Response size budgets; oversized sections truncate with a marker. */
  budgets: z
    .object({
      consoleEntries: z.number().int().positive().max(500).default(50),
      maxBytes: z.number().int().positive().default(200_000),
    })
    .prefault({}),
});

export const SessionObserveOutput = z.object({
  url: z.string(),
  title: z.string().optional(),
  viewport: z.object({ width: z.number(), height: z.number() }).optional(),
  buildStatus: z.enum(['building', 'ok', 'error', 'unknown']).default('unknown'),
  a11y: A11yNodeSchema.optional(),
  componentTree: ComponentTreeNodeSchema.optional(),
  inFlightRequests: z.array(InFlightRequestSchema),
  recentConsole: z.array(StoredEventSchema),
  recentErrors: z.array(StoredEventSchema),
  truncated: z.array(z.string()).default([]),
});

// ---------------------------------------------------------------------------
// network.*
// ---------------------------------------------------------------------------

export const NetworkSummarySchema = z.object({
  requestId: z.string(),
  sessionId: z.string(),
  epoch: z.number().int(),
  url: z.string(),
  method: z.string(),
  resourceType: ResourceTypeSchema.optional(),
  status: z.number().int().optional(),
  startTsMono: z.number(),
  durationMs: z.number().optional(),
  uploadedBytes: z.number().optional(),
  downloadedBytes: z.number().optional(),
  failed: z.boolean().default(false),
  mocked: z.boolean().default(false),
  fromServiceWorker: z.boolean().default(false),
  /** GraphQL detection: operation name when the request parsed as GraphQL. */
  graphqlOperation: z.string().optional(),
});

export const NetworkListInput = z.object({
  sessionId: z.string().optional(),
  epoch: EpochFilterSchema,
  urlFilter: z.string().optional(),
  ...PageQuerySchema.shape,
});
export const NetworkListOutput = z.object({
  requests: z.array(NetworkSummarySchema),
  totals: z.object({
    uploadedBytes: z.number(),
    downloadedBytes: z.number(),
    requestCount: z.number().int(),
  }),
});

export const NetworkGetInput = z.object({
  requestId: z.string(),
  includeBodies: z.boolean().default(true),
});
export const NetworkGetOutput = z.object({
  summary: NetworkSummarySchema,
  requestHeaders: z.record(z.string(), z.string()).optional(),
  responseHeaders: z.record(z.string(), z.string()).optional(),
  requestBody: BodySchema.optional(),
  responseBody: BodySchema.optional(),
  timing: z.record(z.string(), z.number()).optional(),
  initiatorStack: z.array(z.record(z.string(), z.unknown())).optional(),
});

export const ReplayOverridesSchema = z.object({
  url: z.string().optional(),
  method: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
});

export const NetworkReplayInput = z.object({
  requestId: z.string(),
  overrides: ReplayOverridesSchema.default({}),
  /** host = undici with CDP-hydrated cookies; inPage = Runtime.evaluate fetch. */
  mode: z.enum(['host', 'inPage']).default('host'),
});
export const NetworkReplayOutput = z.object({
  status: z.number().int(),
  headers: z.record(z.string(), z.string()),
  body: BodySchema,
  durationMs: z.number(),
  /** Inline diff vs the original response (diff engine). */
  diff: z.object({
    identical: z.boolean(),
    summary: z.string(),
    bodyDelta: z.array(
      z.object({
        path: z.string(),
        kind: z.enum(['added', 'removed', 'changed']),
        before: z.unknown().optional(),
        after: z.unknown().optional(),
      }),
    ),
    statusChanged: z.boolean(),
    headersChanged: z.array(z.string()),
  }),
});

export const MockPatternSchema = z.object({
  /** Glob-style URL pattern, e.g. `http://localhost:3000/api/users*`. */
  urlPattern: z.string(),
  method: z.string().optional(),
});

export const MockResponseSchema = z.object({
  status: z.number().int().default(200),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.string().default(''),
  bodyEncoding: z.enum(['utf8', 'base64']).default('utf8'),
  latencyMs: z.number().nonnegative().default(0),
});

export const MockSetInput = z.object({
  sessionId: z.string().optional(),
  pattern: MockPatternSchema,
  response: MockResponseSchema,
  name: z.string().optional(),
});
export const MockSetOutput = z.object({ mockId: z.string() });

export const MockListInput = z.object({});
export const MockListOutput = z.object({
  mocks: z.array(
    z.object({
      mockId: z.string(),
      name: z.string().optional(),
      pattern: MockPatternSchema,
      response: MockResponseSchema,
      hitCount: z.number().int().default(0),
    }),
  ),
});

export const MockClearInput = z.object({ mockId: z.string().optional() });
export const MockClearOutput = z.object({ cleared: z.number().int() });

export const WsSocketsInput = SessionScope;
export const WsSocketsOutput = z.object({
  sockets: z.array(z.object({ socketId: z.number().int(), url: z.string() })),
});

export const WsSendInput = SessionScope.extend({
  socketId: z.number().int(),
  data: z.string(),
});
export const WsSendOutput = z.object({ ok: z.boolean(), error: z.string().optional() });

export const EditorOpenInput = z.object({
  /** Repo-relative or absolute path; relativized paths resolve against the target's project root. */
  path: z.string(),
  line: z.number().int().positive().optional(),
  sessionId: z.string().optional(),
});
export const EditorOpenOutput = z.object({ ok: z.boolean(), uri: z.string() });

export const CookieSetInput = SessionScope.extend({ cookie: CookieRecordSchema });
export const CookieSetOutput = z.object({ ok: z.boolean() });

export const ApiSchemaInput = z.object({
  sessionId: z.string().optional(),
  /** Restrict to one endpoint, e.g. "GET /api/users". */
  endpoint: z.string().optional(),
  sampleLimit: z.number().int().positive().max(500).default(100),
});
export const ApiSchemaOutput = z.object({
  endpoints: z.array(
    z.object({
      endpoint: z.string(),
      samples: z.number().int(),
      /** JSON-Schema-shaped inferred response spec. */
      responseSchema: z.record(z.string(), z.unknown()).optional(),
      /** Requests whose response shape violated the accumulated schema. */
      mismatches: z.array(
        z.object({ requestId: z.string(), problems: z.array(z.string()).max(20) }),
      ),
    }),
  ),
});

// ---------------------------------------------------------------------------
// console.* / errors.* / storage.*
// ---------------------------------------------------------------------------

export const ConsoleListInput = z.object({
  sessionId: z.string().optional(),
  levels: z.array(LogLevelSchema).optional(),
  epoch: EpochFilterSchema,
  textFilter: z.string().optional(),
  ...PageQuerySchema.shape,
});
export const ConsoleListOutput = z.object({ entries: z.array(StoredEventSchema) });

export const ErrorsListInput = z.object({
  sessionId: z.string().optional(),
  epoch: EpochFilterSchema,
  grouped: z.boolean().default(true),
  ...PageQuerySchema.shape,
});
export const ErrorsListOutput = z.object({
  groups: z.array(
    z.object({
      fingerprint: z.string(),
      message: z.string(),
      count: z.number().int(),
      firstTsMono: z.number(),
      lastTsMono: z.number(),
      sample: StoredEventSchema,
    }),
  ),
});

export const StorageStateInput = SessionScope;
export const StorageEntrySchema = z.object({
  key: z.string(),
  value: z.string(),
  size: z.number().int(),
  /** When the entry was first observed set this session. */
  firstSetTsMono: z.number().optional(),
  lastWriteTsMono: z.number().optional(),
});
export const StorageStateOutput = z.object({
  localStorage: z.array(StorageEntrySchema),
  sessionStorage: z.array(StorageEntrySchema),
  cookies: z.array(CookieRecordSchema),
});

export const StorageTrailInput = z.object({
  sessionId: z.string(),
  area: z.enum(['localStorage', 'sessionStorage', 'cookie']).optional(),
  key: z.string().optional(),
  ...PageQuerySchema.shape,
});
export const StorageTrailOutput = z.object({ ops: z.array(StoredEventSchema) });

// ---------------------------------------------------------------------------
// build.* / hmr.* / resources.*
// ---------------------------------------------------------------------------

export const BuildStatusInput = z.object({ port: z.number().int().optional() });
export const BuildStatusOutput = z.object({
  statuses: z.array(
    z.object({
      port: z.number().int(),
      state: z.enum(['building', 'ok', 'error', 'unknown']),
      tool: z.string().optional(),
      lastBuildMs: z.number().optional(),
      errors: z.array(BuildErrorEvent.shape.payload),
    }),
  ),
});

export const HmrTimelineInput = z.object({
  sessionId: z.string().optional(),
  ...PageQuerySchema.shape,
});
export const HmrTimelineOutput = z.object({ updates: z.array(StoredEventSchema) });

export const ResourcesSamplesInput = z.object({
  sessionId: z.string(),
  kinds: z.array(SampleKindSchema).optional(),
  tsMonoMin: z.number().optional(),
  tsMonoMax: z.number().optional(),
  /** Preferred rollup resolution; store picks the finest available ≥ this. */
  resolution: z.union([z.literal(0), z.literal(1), z.literal(10), z.literal(60)]).default(0),
});
export const ResourcesSamplesOutput = z.object({ samples: z.array(SampleSchema) });

// ---------------------------------------------------------------------------
// auth.* / services.*
// ---------------------------------------------------------------------------

export const JwtInfoSchema = z.object({
  source: z.enum(['localStorage', 'sessionStorage', 'cookie', 'authorizationHeader']),
  sourceKey: z.string(),
  raw: z.string(),
  header: z.record(z.string(), z.unknown()),
  payload: z.record(z.string(), z.unknown()),
  iat: z.number().optional(),
  exp: z.number().optional(),
  nbf: z.number().optional(),
  expired: z.boolean(),
});

export const AuthTokensInput = SessionScope;
export const AuthTokensOutput = z.object({ tokens: z.array(JwtInfoSchema) });

export const AuthInjectInput = z.object({
  sessionId: z.string(),
  token: z.string(),
  placement: z.enum(['localStorage', 'sessionStorage', 'cookie', 'authorizationHeader']),
  key: z.string(),
  cookieFlags: CookieRecordSchema.partial().optional(),
});
export const AuthInjectOutput = z.object({ ok: z.boolean() });

export const ServicesGraphInput = z.object({});
export const ServicesGraphOutput = z.object({
  nodes: z.array(
    z.object({
      port: z.number().int(),
      label: z.string().optional(),
      healthy: z.boolean().optional(),
      tier: z.enum(['t0', 't1', 't2']),
    }),
  ),
  edges: z.array(
    z.object({
      fromPort: z.number().int(),
      toPort: z.number().int(),
      requestCount: z.number().int(),
      avgLatencyMs: z.number().optional(),
      source: z.enum(['client-observed', 'lsof', 'node-agent', 'otel']),
    }),
  ),
});

// ---------------------------------------------------------------------------
// act.*
// ---------------------------------------------------------------------------

export const ActNavigateInput = SessionScope.extend({ url: z.string() });
export const ActNavigateOutput = z.object({ ok: z.boolean(), finalUrl: z.string().optional() });

export const ActClickInput = SessionScope.extend({
  selector: z.string(),
  button: z.enum(['left', 'middle', 'right']).default('left'),
  clickCount: z.number().int().min(1).max(3).default(1),
});
export const ActClickOutput = z.object({ ok: z.boolean(), error: z.string().optional() });

export const ActTypeInput = SessionScope.extend({
  selector: z.string(),
  text: z.string(),
  clearFirst: z.boolean().default(false),
  pressEnter: z.boolean().default(false),
});
export const ActTypeOutput = z.object({ ok: z.boolean(), error: z.string().optional() });

export const ActScreenshotInput = SessionScope.extend({
  fullPage: z.boolean().default(false),
  format: z.enum(['png', 'jpeg']).default('png'),
});
export const ActScreenshotOutput = z.object({
  mimeType: z.string(),
  base64: z.string(),
  width: z.number().int(),
  height: z.number().int(),
});

export const SnapshotCaptureInput = SessionScope.extend({
  name: z.string().optional(),
  pin: z.boolean().default(false),
});
export const SnapshotCaptureOutput = z.object({
  snapshotId: z.string(),
  kinds: z.array(z.string()),
});

export const SnapshotRestoreInput = z.object({ snapshotId: z.string() });
export const SnapshotRestoreOutput = z.object({ report: RestoreReportSchema });

export const SnapshotListInput = z.object({ sessionId: z.string().optional() });
export const SnapshotListOutput = z.object({
  snapshots: z.array(
    z.object({
      snapshotId: z.string(),
      name: z.string().optional(),
      createdAtWall: z.number(),
      pinned: z.boolean(),
      url: z.string().optional(),
    }),
  ),
});

export const FixtureLoadInput = z.object({ name: z.string(), sessionId: z.string() });
export const FixtureLoadOutput = z.object({
  applied: z.object({
    mocks: z.number().int(),
    tokens: z.number().int(),
    snapshotRestored: z.boolean(),
  }),
});

export const ActDispatchInput = z.object({
  actionId: z.string(),
  args: z.record(z.string(), z.unknown()).default({}),
});
export const ActDispatchOutput = z.object({ ok: z.boolean(), result: z.unknown().optional() });

// ---------------------------------------------------------------------------
// component.* / stores.* (framework adapters, AD-3)
// ---------------------------------------------------------------------------

export const ComponentAtInput = SessionScope.extend({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
});
export const ComponentAtOutput = z.object({
  framework: z.enum(['react', 'vue', 'svelte']).optional(),
  componentName: z.string().optional(),
  /** Repo-relative when resolvable; raw source URL otherwise. */
  sourcePath: z.string().optional(),
  line: z.number().int().optional(),
  resolvedVia: z.enum(['debugSource', 'vueFile', 'svelteMeta', 'functionLocation', 'none']),
});

export const ComponentCopyPathInput = ComponentAtInput.extend({
  /** 'nameAndPath' copies `Name (path:line)` — the Alt-click inspect flow;
   *  'path' keeps the original right-click/MCP behavior (`path:line`). */
  format: z.enum(['path', 'nameAndPath']).default('path'),
  /** Structural DOM locator copied instead when no framework component resolves. */
  fallbackSelector: z.string().max(2048).optional(),
});
export const ComponentCopyPathOutput = ComponentAtOutput.extend({
  copied: z.boolean(),
  /** Exact clipboard text, so callers/tests can assert format without OS clipboard access. */
  copiedText: z.string().optional(),
});

export const ComponentInspectModeInput = SessionScope.extend({
  /** Omitted = toggle (palette dispatch passes only sessionId). */
  enabled: z.boolean().optional(),
});
export const ComponentInspectModeOutput = z.object({ enabled: z.boolean() });

export const ComponentTreeInput = SessionScope.extend({
  maxDepth: z.number().int().positive().max(50).default(12),
  maxNodes: z.number().int().positive().max(5000).default(800),
});
export const ComponentTreeOutput = z.object({
  framework: z.string().optional(),
  tree: ComponentTreeNodeSchema.optional(),
  truncated: z.boolean().default(false),
});

export const StoresListInput = SessionScope;
export const StoresListOutput = z.object({
  stores: z.array(
    z.object({
      storeId: z.string(),
      name: z.string(),
      actionCount: z.number().int(),
      /** Index range currently jumpable (in-page history ring). */
      historyLength: z.number().int(),
    }),
  ),
});

export const StateJumpInput = SessionScope.extend({
  storeId: z.string(),
  /** Index into the store's in-page history ring (0 = oldest retained). */
  index: z.number().int().nonnegative(),
});
export const StateJumpOutput = z.object({ ok: z.boolean() });

// ---------------------------------------------------------------------------
// assert.*
// ---------------------------------------------------------------------------

export const AssertRunInput = SessionScope.extend({
  assertions: z.array(AssertionSchema).optional(),
  /** Load a committed suite from .localcoast/assertions/<name>.json instead. */
  suiteName: z.string().optional(),
});
export const AssertRunOutput = z.object({
  pass: z.boolean(),
  results: z.array(AssertionResultSchema),
});

export const AssertWaitForInput = SessionScope.extend({
  assertion: AssertionSchema,
  timeoutMs: z.number().int().positive().max(120_000).default(10_000),
  intervalMs: z.number().int().positive().default(250),
});
export const AssertWaitForOutput = z.object({
  pass: z.boolean(),
  elapsedMs: z.number(),
  lastResult: AssertionResultSchema.optional(),
});

// ---------------------------------------------------------------------------
// timeline.* / diff.* (time travel + diff mode)
// ---------------------------------------------------------------------------

export const TimelineInput = SessionScope.extend({
  /** State-relevant event types to include, in timeline order. */
  types: z.array(z.string()).optional(),
  epoch: EpochFilterSchema,
  ...PageQuerySchema.shape,
});
export const TimelineOutput = z.object({
  /** Scrubbable positions: each is a meaningful state-change event. */
  frames: z.array(
    z.object({
      eventId: z.number().int(),
      tsMono: z.number(),
      type: z.string(),
      label: z.string(),
    }),
  ),
});

export const DiffBeginInput = SessionScope.extend({ label: z.string().optional() });
export const DiffBeginOutput = z.object({ baselineId: z.string() });

export const DiffEndInput = z.object({ baselineId: z.string() });
export const DiffEndOutput = z.object({
  domChanged: z.boolean(),
  domDelta: z.array(z.string()).max(200),
  networkDelta: z.object({
    added: z.array(z.string()),
    removed: z.array(z.string()),
  }),
  storageDelta: z.array(
    z.object({ key: z.string(), kind: z.enum(['added', 'removed', 'changed']) }),
  ),
});

export const AssertReloadOkInput = SessionScope.extend({
  /** Only consider reload/build events after this timeline position. */
  sinceTsMono: z.number().optional(),
  timeoutMs: z.number().int().positive().max(120_000).default(15_000),
});
export const AssertReloadOkOutput = z.object({
  reloaded: z.boolean(),
  kind: z.enum(['hot', 'full', 'none']),
  buildState: z.enum(['ok', 'error', 'unknown']),
  errors: z.array(BuildErrorEvent.shape.payload),
});

// ---------------------------------------------------------------------------
// manage.*
// ---------------------------------------------------------------------------

export const TargetInfoSchema = z.object({
  targetKey: z.string(),
  port: z.number().int(),
  url: z.string().optional(),
  title: z.string().optional(),
  pid: z.number().int().optional(),
  projectRoot: z.string().optional(),
  frameworkHint: z.string().optional(),
  attached: z.boolean(),
  sessionId: z.string().optional(),
  /** Advisory lease: agent holding exclusive interaction during a scenario. */
  lease: z.object({ holder: z.string(), expiresAtWall: z.number() }).optional(),
});

export const TargetsListInput = z.object({});
export const TargetsListOutput = z.object({ targets: z.array(TargetInfoSchema) });

export const SessionInfoSchema = z.object({
  sessionId: z.string(),
  targetKey: z.string(),
  startedAtWall: z.number(),
  endedAtWall: z.number().optional(),
  currentEpoch: z.number().int(),
  meta: z
    .object({
      gitSha: z.string().optional(),
      env: z.string().optional(),
      framework: z.string().optional(),
    })
    .default({}),
});

export const SessionsListInput = z.object({ includeEnded: z.boolean().default(false) });
export const SessionsListOutput = z.object({ sessions: z.array(SessionInfoSchema) });

export const ActionsListInput = z.object({});
export const ActionsListOutput = z.object({
  actions: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      capability: z.string(),
      /** JSON Schema of the args (converted from the capability's Zod input). */
      argsSchema: z.record(z.string(), z.unknown()).optional(),
      keybinding: z.string().optional(),
    }),
  ),
});

export const ExportBundleInput = z.object({
  sessionId: z.string(),
  spec: z
    .object({
      consoleSeconds: z.number().int().positive().default(60),
      networkCount: z.number().int().positive().default(30),
      includeScreenshot: z.boolean().default(true),
      includeStorage: z.boolean().default(true),
    })
    .prefault({}),
});
export const ExportBundleOutput = z.object({
  /** Written under ~/.localcoast/exports; path returned rather than inlining the zip. */
  path: z.string(),
  sizeBytes: z.number().int(),
  redactions: z.number().int(),
  manifest: z.record(z.string(), z.unknown()),
});
