import {
  ActDispatchInput,
  ActDispatchOutput,
  ActionsListInput,
  ActionsListOutput,
  ConsoleListInput,
  ConsoleListOutput,
  ErrorsListInput,
  ErrorsListOutput,
  EventsQueryInput,
  EventsQueryOutput,
  EventsSubscribeInput,
  EventsSubscribeOutput,
  HmrTimelineInput,
  HmrTimelineOutput,
  NetworkGetInput,
  NetworkGetOutput,
  NetworkListInput,
  NetworkListOutput,
  ResourcesSamplesInput,
  ResourcesSamplesOutput,
  SessionsListInput,
  SessionsListOutput,
  SnapshotListInput,
  SnapshotListOutput,
  StorageTrailInput,
  StorageTrailOutput,
  TimelineInput,
  TimelineOutput,
  TargetsListInput,
  TargetsListOutput,
  type NetworkSummarySchema,
  type StoredEvent,
} from '@localcoast/protocol-types';
import {
  ApiSchemaInput,
  ApiSchemaOutput,
  BuildStatusInput,
  BuildStatusOutput,
  ExportBundleInput,
  ExportBundleOutput,
  ServicesGraphInput,
  ServicesGraphOutput,
} from '@localcoast/protocol-types';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { z } from 'zod';
import type { Core } from '../core.js';
import { nextBeforeId } from '../core.js';
import { redactValue } from '../engines/redaction.js';
import {
  endpointKey,
  inferShape,
  mergeShape,
  shapeToJsonSchema,
  validateAgainstShape,
  type Shape,
} from '../engines/schema-infer.js';
import { CapabilityFault } from '../registry.js';
import type { ProcessInspector } from '../services.js';

type NetworkSummary = z.infer<typeof NetworkSummarySchema>;

/** Event types that mark "the page is now at URL X" on the shared tsMono clock. */
const NAV_TYPES = ['session.attached', 'session.navigated', 'state.route'] as const;

interface NavPoint {
  id: number;
  tsMono: number;
  url: string;
}

function navUrlOf(evt: StoredEvent): string | undefined {
  switch (evt.type) {
    case 'state.route':
      return evt.payload.to;
    case 'session.navigated':
    case 'session.attached':
      return evt.payload.url;
    default:
      return undefined;
  }
}

function stripHash(url: string): string {
  const i = url.indexOf('#');
  return i === -1 ? url : url.slice(0, i);
}

/**
 * Page URL for a request: the CDP documentURL is exact even when a same-tick
 * SPA route + fetch races the state.route binding, but Chromium strips the
 * hash from it. Nav events keep the hash (hash routers). Prefer the nav URL
 * when the two agree modulo hash; trust documentURL when they genuinely
 * disagree (race, or a request from another frame).
 */
function pickPageUrl(documentUrl: string | undefined, navUrl: string | undefined): string | undefined {
  if (!documentUrl) return navUrl;
  if (!navUrl) return documentUrl;
  return stripHash(documentUrl) === stripHash(navUrl) ? navUrl : documentUrl;
}

/**
 * Collapse the raw nav-event stream into page segments. Consecutive same-URL
 * points merge (the startup session.attached + first session.navigated pair,
 * router-mount replaces) — except explicit refreshes, which always open a new
 * segment so before/after-reload requests don't share a section.
 */
function buildNavPoints(navEvents: StoredEvent[]): NavPoint[] {
  const points: NavPoint[] = [];
  for (const evt of navEvents) {
    const url = navUrlOf(evt);
    if (url === undefined) continue;
    const isRefresh = evt.type === 'session.navigated' && evt.payload.isRefresh;
    const prev = points[points.length - 1];
    if (prev && prev.url === url && !isRefresh) continue;
    points.push({ id: evt.id, tsMono: evt.tsMono, url });
  }
  return points;
}

export interface BuiltinDeps {
  inspector: ProcessInspector;
}

/**
 * Store-backed capability set — everything answerable without a live CDP
 * session. CDP-dependent capabilities (act.navigate, storage.state,
 * session.observe, …) register in their own phases when their engines exist;
 * registering stubs would lie to agents about what works.
 */
export function registerBuiltins(core: Core, deps: BuiltinDeps): void {
  const { store } = core;

  core.registry.registerQuery({
    name: 'events.query',
    description:
      'Query the session event timeline. Filter by session, dotted event types, epoch (default: current — resets on refresh, survives SPA navigation), request/trace correlation ids, and monotonic time range. Reverse-chronological pagination via beforeId.',
    input: EventsQueryInput,
    output: EventsQueryOutput,
    handler: async (input) => {
      const events = await store.query({
        sessionId: input.sessionId,
        types: input.types,
        epoch: store.resolveEpoch(input.epoch, input.sessionId),
        requestId: input.requestId,
        traceId: input.traceId,
        tsMonoMin: input.tsMonoMin,
        tsMonoMax: input.tsMonoMax,
        beforeId: input.beforeId,
        limit: input.limit,
      });
      return { events, nextBeforeId: nextBeforeId(events, input.limit) };
    },
  });

  core.registry.registerSubscription({
    name: 'events.subscribe',
    description:
      'Live event stream. Emits each new timeline event matching the session/type filter as it is recorded.',
    input: EventsSubscribeInput,
    output: EventsSubscribeOutput,
    surfaces: { mcp: false },
    mcpExclusionReason:
      'MCP v1 is request/response only (AD-7); agents poll events.query or use lc_assert_wait_for. Renderer panels consume this via core:subscribe.',
    handler: (input, _ctx, emit) =>
      store.onEvent((e) => emit(e), { sessionId: input.sessionId, types: input.types }),
  });

  core.registry.registerQuery({
    name: 'network.list',
    description:
      'List captured network requests for a session as per-request summaries (method, status, timing, sizes, mock/service-worker provenance) plus session totals of bytes uploaded/downloaded. Each request is stamped with the page URL active when it started (pageUrl from the request documentURL, falling back to navigation/route-event correlation; navId marks the navigation segment) and its wall-clock start time. Epoch filter defaults to current (resets on refresh as a view filter — history is never deleted).',
    input: NetworkListInput,
    output: NetworkListOutput,
    handler: async (input) => {
      const epoch = store.resolveEpoch(input.epoch, input.sessionId);
      const raw = await store.query({
        sessionId: input.sessionId,
        types: [
          'network.request',
          'network.response',
          'network.finished',
          'network.failed',
        ],
        epoch,
        limit: Math.min(input.limit * 8, 8000),
      });
      // Page-path correlation: nav events are deliberately NOT epoch-filtered —
      // a request racing an epoch bump still resolves to the prior nav point
      // (a refresh is same-URL by definition, so the stamp stays correct).
      const navPoints = buildNavPoints(
        await store.query({ sessionId: input.sessionId, types: [...NAV_TYPES], limit: 1000 }),
      );
      let navIdx = 0;
      const byRequest = new Map<string, NetworkSummary>();
      for (const evt of raw) {
        if (!evt.requestId) continue;
        if (evt.type === 'network.request') {
          const p = evt.payload;
          if (input.urlFilter && !p.url.includes(input.urlFilter)) continue;
          // Both lists are ascending by tsMono, so a monotone pointer suffices.
          // Tie rule <=: a nav at the identical tsMono governs the request.
          for (let next = navPoints[navIdx + 1]; next && next.tsMono <= evt.tsMono; next = navPoints[navIdx + 1]) {
            navIdx++;
          }
          const navCandidate = navPoints[navIdx];
          const nav = navCandidate && navCandidate.tsMono <= evt.tsMono ? navCandidate : undefined;
          byRequest.set(evt.requestId, {
            requestId: evt.requestId,
            sessionId: evt.sessionId,
            epoch: evt.epoch,
            url: p.url,
            method: p.method,
            resourceType: p.resourceType,
            startTsMono: evt.tsMono,
            startTsWall: evt.tsWall,
            pageUrl: pickPageUrl(p.documentUrl, nav?.url),
            navId: nav?.id,
            uploadedBytes: p.postDataSize,
            failed: false,
            mocked: Boolean(p.mockedBy),
            fromServiceWorker: false,
            graphqlOperation: p.graphqlOperation,
          });
        } else {
          const summary = byRequest.get(evt.requestId);
          if (!summary) continue;
          if (evt.type === 'network.response') {
            summary.status = evt.payload.status;
            summary.fromServiceWorker = evt.payload.fromServiceWorker ?? false;
            if (evt.payload.headers['x-localcoast-mock']) summary.mocked = true;
          } else if (evt.type === 'network.finished') {
            summary.downloadedBytes = evt.payload.encodedDataLength;
            summary.durationMs = evt.tsMono - summary.startTsMono;
          } else if (evt.type === 'network.failed') {
            summary.failed = true;
            summary.durationMs = evt.tsMono - summary.startTsMono;
          }
        }
      }
      const requests = [...byRequest.values()]
        .sort((a, b) => b.startTsMono - a.startTsMono)
        .slice(0, input.limit);
      const totals = await store.networkTotals(input.sessionId, epoch);
      return { requests, totals };
    },
  });

  core.registry.registerQuery({
    name: 'network.get',
    description:
      'Full detail for one captured request: request/response headers, timing, initiator stack, and bodies (persisted eagerly at capture time; may be marked evicted under retention pressure).',
    input: NetworkGetInput,
    output: NetworkGetOutput,
    handler: async (input) => {
      const events = await store.query({ requestId: input.requestId, limit: 50 });
      const reqEvt = events.find((e) => e.type === 'network.request');
      if (!reqEvt || reqEvt.type !== 'network.request') {
        throw new CapabilityFault('not_found', `no captured request ${input.requestId}`);
      }
      const resEvt = events.find((e) => e.type === 'network.response');
      const finEvt = events.find((e) => e.type === 'network.finished');
      const failEvt = events.find((e) => e.type === 'network.failed');

      // Latest nav at-or-before the request (query is last-N ascending, so the
      // single row IS the latest match). Skips network.list's duplicate-collapse:
      // navId can differ from the list's across a collapsed duplicate nav —
      // sections are a list-side concern, the stamped URL is identical.
      const navs = await store.query({
        sessionId: reqEvt.sessionId,
        types: [...NAV_TYPES],
        tsMonoMax: reqEvt.tsMono,
        limit: 1,
      });
      const nav = navs[0];

      const summary: NetworkSummary = {
        requestId: input.requestId,
        sessionId: reqEvt.sessionId,
        epoch: reqEvt.epoch,
        url: reqEvt.payload.url,
        method: reqEvt.payload.method,
        resourceType: reqEvt.payload.resourceType,
        status: resEvt?.type === 'network.response' ? resEvt.payload.status : undefined,
        startTsMono: reqEvt.tsMono,
        startTsWall: reqEvt.tsWall,
        pageUrl: pickPageUrl(reqEvt.payload.documentUrl, nav ? navUrlOf(nav) : undefined),
        navId: nav?.id,
        durationMs: finEvt ? finEvt.tsMono - reqEvt.tsMono : undefined,
        uploadedBytes: reqEvt.payload.postDataSize,
        downloadedBytes:
          finEvt?.type === 'network.finished' ? finEvt.payload.encodedDataLength : undefined,
        failed: Boolean(failEvt),
        mocked: Boolean(reqEvt.payload.mockedBy),
        fromServiceWorker:
          resEvt?.type === 'network.response' ? (resEvt.payload.fromServiceWorker ?? false) : false,
      };

      async function body(evt: { blobId?: string; blobEvicted?: boolean } | undefined) {
        if (!evt?.blobId) return undefined;
        if (evt.blobEvicted) {
          return { encoding: 'utf8' as const, data: '', truncated: false, evicted: true };
        }
        const blob = await store.getBlob(evt.blobId);
        if (!blob) return { encoding: 'utf8' as const, data: '', truncated: false, evicted: true };
        const isText = !blob.subarray(0, 512).includes(0);
        return isText
          ? { encoding: 'utf8' as const, data: blob.toString('utf8'), truncated: false, evicted: false }
          : { encoding: 'base64' as const, data: blob.toString('base64'), truncated: false, evicted: false };
      }

      return {
        summary,
        requestHeaders: reqEvt.payload.headers,
        responseHeaders: resEvt?.type === 'network.response' ? resEvt.payload.headers : undefined,
        // Request body rides the request event; the response body blob rides
        // the finished event (persisted eagerly at loadingFinished, AD-2).
        requestBody: input.includeBodies ? await body(reqEvt) : undefined,
        responseBody: input.includeBodies ? await body(finEvt ?? resEvt) : undefined,
        initiatorStack: reqEvt.payload.initiator?.stack as
          | Array<Record<string, unknown>>
          | undefined,
      };
    },
  });

  core.registry.registerQuery({
    name: 'console.list',
    description:
      'Formatted console/log stream for a session: browser console, worker output, and (Tier 2) server stdout. Filter by level, epoch, or substring.',
    input: ConsoleListInput,
    output: ConsoleListOutput,
    handler: async (input) => {
      const events = await store.query({
        sessionId: input.sessionId,
        types: ['console.entry'],
        epoch: store.resolveEpoch(input.epoch, input.sessionId),
        beforeId: input.beforeId,
        limit: input.limit,
      });
      const levels = input.levels ? new Set<string>(input.levels) : undefined;
      return {
        entries: events.filter((e) => {
          if (e.type !== 'console.entry') return false;
          if (levels && !levels.has(e.payload.level)) return false;
          if (input.textFilter && !e.payload.text.includes(input.textFilter)) return false;
          return true;
        }),
      };
    },
  });

  core.registry.registerQuery({
    name: 'errors.list',
    description:
      'Runtime errors grouped by stack-trace fingerprint with occurrence counts and first/last timestamps — high-frequency errors surface as one group, not a flood.',
    input: ErrorsListInput,
    output: ErrorsListOutput,
    handler: async (input) => {
      const events = await store.query({
        sessionId: input.sessionId,
        types: ['error.uncaught', 'error.rejection', 'error.resource'],
        epoch: store.resolveEpoch(input.epoch, input.sessionId),
        beforeId: input.beforeId,
        limit: input.grouped ? Math.min(input.limit * 20, 5000) : input.limit,
      });
      const groups = new Map<
        string,
        { fingerprint: string; message: string; count: number; firstTsMono: number; lastTsMono: number; sample: (typeof events)[number] }
      >();
      for (const evt of events) {
        const payload = evt.payload as { fingerprint?: string; message?: string; url?: string };
        const message = payload.message ?? payload.url ?? 'unknown error';
        const fp = payload.fingerprint ?? `${evt.type}:${message}`;
        const existing = groups.get(fp);
        if (existing) {
          existing.count++;
          existing.firstTsMono = Math.min(existing.firstTsMono, evt.tsMono);
          existing.lastTsMono = Math.max(existing.lastTsMono, evt.tsMono);
          existing.sample = evt;
        } else {
          groups.set(fp, {
            fingerprint: fp,
            message,
            count: 1,
            firstTsMono: evt.tsMono,
            lastTsMono: evt.tsMono,
            sample: evt,
          });
        }
      }
      return { groups: [...groups.values()].sort((a, b) => b.lastTsMono - a.lastTsMono) };
    },
  });

  core.registry.registerQuery({
    name: 'storage.trail',
    description:
      'The storage usage trail: every localStorage/sessionStorage/cookie read, write, remove, and clear observed in the page, with key, value size, preview, and the trimmed JS stack that did it. Filter by area or key.',
    input: StorageTrailInput,
    output: StorageTrailOutput,
    handler: async (input) => {
      const events = await store.query({
        sessionId: input.sessionId,
        types: ['storage.op'],
        beforeId: input.beforeId,
        limit: Math.min(input.limit * 4, 4000),
      });
      const filtered = events.filter((e) => {
        if (e.type !== 'storage.op') return false;
        if (input.area && e.payload.area !== input.area) return false;
        if (input.key && e.payload.key !== input.key) return false;
        return true;
      });
      return { ops: filtered.slice(-input.limit) };
    },
  });

  core.registry.registerQuery({
    name: 'hmr.timeline',
    description:
      'Hot-reload timeline: every HMR event with the changed file, invalidated modules, latency, and hot-vs-full classification. Answers "did the dev server pick up my change".',
    input: HmrTimelineInput,
    output: HmrTimelineOutput,
    handler: async (input) => ({
      updates: await store.query({
        sessionId: input.sessionId,
        types: ['hmr.update'],
        beforeId: input.beforeId,
        limit: input.limit,
      }),
    }),
  });

  core.registry.registerQuery({
    name: 'resources.samples',
    description:
      'Continuous resource-monitoring series (JS heap, DOM node count, listener count, fps) at the requested rollup resolution (raw/1s/10s/60s).',
    input: ResourcesSamplesInput,
    output: ResourcesSamplesOutput,
    handler: async (input) => ({
      samples: await store.querySamples({
        sessionId: input.sessionId,
        kinds: input.kinds,
        resolution: input.resolution,
        tsMonoMin: input.tsMonoMin,
        tsMonoMax: input.tsMonoMax,
      }),
    }),
  });

  core.registry.registerQuery({
    name: 'api.schema',
    description:
      'Inferred API spec from observed traffic (no developer schema needed): per-endpoint JSON response schema accumulated chronologically, with drift flags for later responses that violated the shape established by earlier ones.',
    input: ApiSchemaInput,
    output: ApiSchemaOutput,
    handler: async (input) => {
      const events = await store.query({
        sessionId: input.sessionId,
        types: ['network.request', 'network.response', 'network.finished'],
        limit: input.sampleLimit * 8,
      });
      // requestId → {endpoint, isJson, bodyBlob}
      const requests = new Map<string, { endpoint: string; isJson: boolean; blobId?: string }>();
      for (const evt of events) {
        if (!evt.requestId) continue;
        if (evt.type === 'network.request') {
          const key = endpointKey(evt.payload.method, evt.payload.url);
          if (input.endpoint && key !== input.endpoint) continue;
          if (['fetch', 'xhr'].includes(evt.payload.resourceType ?? '')) {
            requests.set(evt.requestId, { endpoint: key, isJson: false });
          }
        } else if (evt.type === 'network.response') {
          const entry = requests.get(evt.requestId);
          if (entry) entry.isJson = (evt.payload.mimeType ?? '').includes('json');
        } else if (evt.type === 'network.finished') {
          const entry = requests.get(evt.requestId);
          if (entry && evt.blobId && !evt.blobEvicted) entry.blobId = evt.blobId;
        }
      }

      const endpoints = new Map<
        string,
        { shape: Shape | null; samples: number; mismatches: Array<{ requestId: string; problems: string[] }> }
      >();
      // events come back oldest-first — validate each sample against the
      // shape established BEFORE it, then merge it in. Early traffic defines
      // the contract; later drift flags.
      for (const [requestId, entry] of requests) {
        if (!entry.isJson || !entry.blobId) continue;
        const blob = await store.getBlob(entry.blobId);
        if (!blob) continue;
        let value: unknown;
        try {
          value = JSON.parse(blob.toString('utf8'));
        } catch {
          continue;
        }
        let record = endpoints.get(entry.endpoint);
        if (!record) {
          record = { shape: null, samples: 0, mismatches: [] };
          endpoints.set(entry.endpoint, record);
        }
        record.samples++;
        if (record.shape) {
          const problems = validateAgainstShape(value, record.shape);
          if (problems.length > 0) record.mismatches.push({ requestId, problems });
          record.shape = mergeShape(record.shape, inferShape(value));
        } else {
          record.shape = inferShape(value);
        }
      }

      return {
        endpoints: [...endpoints.entries()].map(([endpoint, r]) => ({
          endpoint,
          samples: r.samples,
          responseSchema: r.shape ? shapeToJsonSchema(r.shape) : undefined,
          mismatches: r.mismatches,
        })),
      };
    },
  });

  core.registry.registerQuery({
    name: 'sessions.list',
    description:
      'List attach sessions (one per guest-tab attach) with target, epoch, and metadata (git sha, framework) — the spine every timeline query hangs off.',
    input: SessionsListInput,
    output: SessionsListOutput,
    handler: async (input) => {
      const sessions = await store.listSessions(input.includeEnded);
      return {
        sessions: sessions.map((s) => ({
          sessionId: s.sessionId,
          targetKey: s.targetKey,
          startedAtWall: s.startedAtWall,
          endedAtWall: s.endedAtWall,
          currentEpoch: s.currentEpoch,
          meta: s.meta as { gitSha?: string; env?: string; framework?: string },
        })),
      };
    },
  });

  core.registry.registerQuery({
    name: 'targets.list',
    description:
      'Discovered localhost servers (port, pid, command, cwd) merged with live attach state — which targets have an active inspection session.',
    input: TargetsListInput,
    output: TargetsListOutput,
    handler: async () => {
      const [servers, sessions] = await Promise.all([
        deps.inspector.listListeningServers(),
        store.listSessions(false),
      ]);
      const attached = new Map(sessions.map((s) => [s.targetKey, s.sessionId]));
      return {
        targets: servers.map((srv) => {
          const targetKey = `port:${srv.port}`;
          const sessionId = attached.get(targetKey);
          return {
            targetKey,
            port: srv.port,
            url: `http://localhost:${srv.port}/`,
            projectName: srv.projectName,
            projectRoot: srv.cwd,
            pid: srv.pid,
            attached: sessionId !== undefined,
            sessionId,
          };
        }),
      };
    },
  });

  core.registry.registerQuery({
    name: 'timeline.frames',
    description:
      'Time-travel scrubber source: meaningful state-change events (state commits, store actions, routes, snapshots, storage writes) as ordered, labeled frames you can scrub across — including across epochs.',
    input: TimelineInput,
    output: TimelineOutput,
    handler: async (input) => {
      const types = input.types ?? [
        'state.commit',
        'state.action',
        'state.route',
        'storage.op',
        'snapshot.captured',
        'network.request',
      ];
      const events = await store.query({
        sessionId: input.sessionId,
        types,
        epoch: store.resolveEpoch(input.epoch, input.sessionId),
        beforeId: input.beforeId,
        limit: input.limit,
      });
      const label = (e: (typeof events)[number]): string => {
        switch (e.type) {
          case 'state.action':
            return `store ${e.payload.storeId}: ${e.payload.actionType}`;
          case 'state.route':
            return `route → ${e.payload.to}`;
          case 'state.commit':
            return `${e.payload.framework} render ×${e.payload.renderCount ?? 1}`;
          case 'storage.op':
            return `${e.payload.area} ${e.payload.op}${e.payload.key ? ` ${e.payload.key}` : ''}`;
          case 'snapshot.captured':
            return `snapshot ${e.payload.name ?? e.payload.snapshotId}`;
          case 'network.request':
            return `${e.payload.method} ${e.payload.url}`;
          default:
            return e.type;
        }
      };
      return {
        frames: events.map((e) => ({ eventId: e.id, tsMono: e.tsMono, type: e.type, label: label(e) })),
      };
    },
  });

  core.registry.registerQuery({
    name: 'snapshots.list',
    description: 'List saved app-state snapshots (named, pinnable, timeline-anchored).',
    input: SnapshotListInput,
    output: SnapshotListOutput,
    handler: async (input) => ({ snapshots: await store.listSnapshots(input.sessionId) }),
  });

  core.registry.registerQuery({
    name: 'build.status',
    description:
      'Normalized build/HMR status per port (from Tier-0 HMR WebSocket sniffing): building/ok/error state, last build duration, and structured build errors — one surface across Vite/webpack/Next.',
    input: BuildStatusInput,
    output: BuildStatusOutput,
    handler: async (input) => {
      const events = await store.query({
        types: ['build.status', 'build.error'],
        limit: 500,
      });
      const byPort = new Map<
        number,
        { state: 'building' | 'ok' | 'error' | 'unknown'; tool?: string; lastBuildMs?: number; errors: unknown[] }
      >();
      for (const evt of events) {
        if (evt.type === 'build.status') {
          const port = evt.payload.port ?? 0;
          if (input.port !== undefined && port !== input.port) continue;
          const existing = byPort.get(port) ?? { state: 'unknown' as const, errors: [] };
          existing.state = evt.payload.state;
          existing.tool = evt.payload.tool;
          existing.lastBuildMs = evt.payload.durationMs;
          if (evt.payload.state !== 'error') existing.errors = [];
          byPort.set(port, existing);
        } else if (evt.type === 'build.error') {
          const port = input.port ?? 0;
          const existing = byPort.get(port) ?? { state: 'error' as const, errors: [] };
          existing.errors.push(evt.payload);
          byPort.set(port, existing);
        }
      }
      return {
        statuses: [...byPort.entries()].map(([port, s]) => ({
          port,
          state: s.state,
          tool: s.tool,
          lastBuildMs: s.lastBuildMs,
          errors: s.errors as never[],
        })),
      };
    },
  });

  core.registry.registerQuery({
    name: 'services.graph',
    description:
      'Inferred service-dependency graph: nodes are discovered ports (with health + tier), edges are client-observed cross-port calls with request counts and average latency. Gives agents a map of the local architecture without reading docker-compose.',
    input: ServicesGraphInput,
    output: ServicesGraphOutput,
    handler: async () => {
      const [servers, sessions] = await Promise.all([
        deps.inspector.listListeningServers(),
        store.listSessions(false),
      ]);
      const ports = new Set(servers.map((s) => s.port));
      const nodes = servers.map((s) => ({
        port: s.port,
        label: s.cmd,
        tier: 't0' as const,
      }));

      // Client-observed edges: a session on port A requesting localhost:B.
      const edgeMap = new Map<string, { from: number; to: number; count: number; totalMs: number }>();
      const sessionPort = new Map(
        sessions.map((s) => [s.sessionId, Number(s.targetKey.replace('port:', ''))]),
      );
      const requests = await store.query({ types: ['network.request', 'network.finished'], limit: 5000 });
      const reqPort = new Map<string, { from: number; to: number; start: number }>();
      for (const evt of requests) {
        if (evt.type === 'network.request' && evt.requestId) {
          const from = sessionPort.get(evt.sessionId);
          const m = /^https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/.exec(evt.payload.url);
          const to = m ? Number(m[1]) : undefined;
          if (from && to && to !== from && ports.has(to)) {
            reqPort.set(evt.requestId, { from, to, start: evt.tsMono });
          }
        } else if (evt.type === 'network.finished' && evt.requestId) {
          const r = reqPort.get(evt.requestId);
          if (!r) continue;
          const key = `${r.from}->${r.to}`;
          const edge = edgeMap.get(key) ?? { from: r.from, to: r.to, count: 0, totalMs: 0 };
          edge.count++;
          edge.totalMs += evt.tsMono - r.start;
          edgeMap.set(key, edge);
        }
      }
      return {
        nodes,
        edges: [...edgeMap.values()].map((e) => ({
          fromPort: e.from,
          toPort: e.to,
          requestCount: e.count,
          avgLatencyMs: e.count > 0 ? e.totalMs / e.count : undefined,
          source: 'client-observed' as const,
        })),
      };
    },
  });

  core.registry.registerCommand({
    name: 'export.bundle',
    description:
      'Bug Report Bundle: assemble a screenshot placeholder ref, the last N seconds of console, the last N network requests, and current storage into one JSON artifact under ~/.localcoast/exports — passed through the redaction pass (tokens, cookies, JWTs, secrets) before it leaves the process. Attach to issues or paste into an agent prompt.',
    input: ExportBundleInput,
    output: ExportBundleOutput,
    surfaces: { palette: true },
    paletteTitle: 'Export bug report bundle',
    handler: async (input) => {
      const nowMono = 0; // recent() uses clock internally
      void nowMono;
      const consoleEvents = store
        .recent(input.sessionId, input.spec.consoleSeconds * 1000)
        .filter((e) => e.type === 'console.entry' || e.type.startsWith('error.'));
      const network = (
        await store.query({
          sessionId: input.sessionId,
          types: ['network.request', 'network.response', 'network.finished'],
          limit: input.spec.networkCount * 4,
        })
      ).slice(-input.spec.networkCount * 3);
      const sessions = await store.listSessions(true);
      const session = sessions.find((s) => s.sessionId === input.sessionId);

      const rawBundle = {
        capturedAtWall: Date.now(),
        session: {
          sessionId: input.sessionId,
          url: consoleEvents.at(-1)?.sessionId,
          meta: session?.meta ?? {},
          epoch: session?.currentEpoch ?? 0,
        },
        runtime: { node: process.version, platform: process.platform },
        console: consoleEvents,
        network,
      };

      // Invariant 8: redact BEFORE anything is written to disk.
      const { value: redacted, count: redactions } = redactValue(rawBundle);

      const dir = join(process.env.LOCALCOAST_HOME ?? join(homedir(), '.localcoast'), 'exports');
      await mkdir(dir, { recursive: true });
      const path = join(dir, `bundle-${input.sessionId}-${Date.now()}.json`);
      const serialized = JSON.stringify(redacted, null, 2);
      await writeFile(path, serialized);

      return {
        path,
        sizeBytes: Buffer.byteLength(serialized),
        redactions,
        manifest: {
          consoleEntries: consoleEvents.length,
          networkEvents: network.length,
          redactions,
        },
      };
    },
  });

  core.registry.registerQuery({
    name: 'actions.list',
    description:
      'Enumerate palette actions (id, title, JSON-schema args). Every entry is dispatchable via act.dispatch — the whole palette is agent-reachable.',
    input: ActionsListInput,
    output: ActionsListOutput,
    handler: async () => ({
      actions: core.registry
        .list()
        .filter((c) => c.surfaces.palette)
        .map((c) => ({
          id: c.name,
          title: c.paletteTitle ?? c.name,
          capability: c.name,
        })),
    }),
  });

  core.registry.registerCommand({
    name: 'act.dispatch',
    description:
      'Dispatch any palette action by id with schema-validated args — the structured action dispatcher behind the command palette (Cmd+K) and the lc_act_dispatch tool.',
    input: ActDispatchInput,
    output: ActDispatchOutput,
    handler: async (input, ctx) => {
      const cap = core.registry.get(input.actionId);
      if (!cap || !cap.surfaces.palette) {
        throw new CapabilityFault('not_found', `no palette action ${input.actionId}`);
      }
      const result =
        cap.kind === 'command'
          ? await core.command(cap.name, input.args, ctx)
          : await core.query(cap.name, input.args, ctx);
      return { ok: true, result };
    },
  });
}
