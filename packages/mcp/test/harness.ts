import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Core,
  EventStore,
  InProcessBackend,
  registerBuiltins,
  type ProcessInspector,
} from '@localcoast/core';
import type { AnyEvent } from '@localcoast/protocol-types';

/** Deterministic clock mirroring core's test helper. */
export class FakeClock {
  wallNow = 1_700_000_000_000;
  monoNow = 0;

  wall(): number {
    return this.wallNow;
  }

  mono(): number {
    return this.monoNow;
  }

  tick(ms: number): void {
    this.wallNow += ms;
    this.monoNow += ms;
  }
}

const inspector: ProcessInspector = {
  listListeningServers: async () => [
    { port: 3000, pid: 100, cmd: 'node vite', cwd: '/proj/web', protocol: 'http' },
  ],
  envOf: async () => undefined,
};

/** Core seeded with a deterministic slice of traffic for parity comparison. */
export async function seededCore(): Promise<{ core: Core; store: EventStore; clock: FakeClock }> {
  const clock = new FakeClock();
  const dbPath = join(mkdtempSync(join(tmpdir(), 'localcoast-parity-')), 'events.db');
  const store = new EventStore({ backend: new InProcessBackend(dbPath), clock, batchMs: 1 });
  await store.open();
  const core = new Core(store);
  registerBuiltins(core, { inspector });

  await store.startSession({ sessionId: 's-1', targetKey: 'port:3000', meta: { framework: 'react' } });

  const append = (evt: AnyEvent) => store.append(evt);
  const base = { sessionId: 's-1', epoch: 0, actor: 'app' as const };
  const at = () => ({ tsWall: clock.wall(), tsMono: clock.mono() });

  append({
    ...base,
    ...at(),
    type: 'network.request',
    requestId: 'r-1',
    payload: {
      url: 'http://localhost:3000/api/users',
      method: 'GET',
      headers: { accept: 'application/json' },
      resourceType: 'fetch',
    },
  });
  clock.tick(12);
  append({
    ...base,
    ...at(),
    type: 'network.response',
    requestId: 'r-1',
    payload: { url: 'http://localhost:3000/api/users', status: 200, headers: { 'content-type': 'application/json' } },
  });
  append({
    ...base,
    ...at(),
    type: 'network.finished',
    requestId: 'r-1',
    payload: { encodedDataLength: 512 },
  });
  clock.tick(5);
  append({
    ...base,
    ...at(),
    type: 'console.entry',
    payload: { level: 'warn', source: 'page', text: 'deprecated API used' },
  });
  append({
    ...base,
    ...at(),
    type: 'error.uncaught',
    payload: { message: 'boom', fingerprint: 'fp-boom' },
  });
  append({
    ...base,
    ...at(),
    type: 'hmr.update',
    payload: { kind: 'hot', file: 'src/App.tsx', latencyMs: 90 },
  });
  append({
    ...base,
    ...at(),
    type: 'storage.op',
    payload: { area: 'localStorage', op: 'write', key: 'auth.token', valueSize: 16 },
  });
  store.addSample({
    sessionId: 's-1',
    kind: 'heapBytes',
    tsWall: clock.wall(),
    tsMono: clock.mono(),
    value: 1024,
    resolution: 0,
  });
  await store.flush();
  return { core, store, clock };
}

/**
 * Parity cases: one representative input per MCP-exposed query capability.
 * The parity test fails if a capability has no case — adding a capability
 * without extending this list breaks CI, which is the point (invariant 3).
 */
export const PARITY_CASES: Record<string, unknown> = {
  'events.query': { sessionId: 's-1', epoch: 'all', limit: 50 },
  'network.list': { sessionId: 's-1' },
  'network.get': { requestId: 'r-1' },
  'console.list': { sessionId: 's-1' },
  'errors.list': { sessionId: 's-1' },
  'storage.trail': { sessionId: 's-1' },
  'api.schema': { sessionId: 's-1' },
  'timeline.frames': { sessionId: 's-1', epoch: 'all' },
  'build.status': {},
  'services.graph': {},
  'hmr.timeline': { sessionId: 's-1' },
  'resources.samples': { sessionId: 's-1' },
  'sessions.list': {},
  'targets.list': {},
  'snapshots.list': {},
  'actions.list': {},
};
