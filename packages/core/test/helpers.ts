import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnyEvent } from '@localcoast/protocol-types';
import type { Clock, ProcessInspector } from '../src/services.js';
import { EventStore, InProcessBackend } from '../src/events/store.js';

/** Deterministic manual clock for tests. */
export class FakeClock implements Clock {
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

export function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'localcoast-test-')), 'events.db');
}

export async function makeStore(clock: FakeClock = new FakeClock()): Promise<{
  store: EventStore;
  clock: FakeClock;
}> {
  const store = new EventStore({
    backend: new InProcessBackend(tempDbPath()),
    clock,
    batchMs: 1,
  });
  await store.open();
  return { store, clock };
}

export const fakeInspector: ProcessInspector = {
  listListeningServers: async () => [
    { port: 3000, pid: 100, cmd: 'node vite', cwd: '/proj/web', projectName: 'web-app', protocol: 'http' },
    { port: 8080, pid: 200, cmd: 'node api', cwd: '/proj/api', protocol: 'http' },
  ],
  envOf: async () => undefined,
};

export function consoleEvent(
  sessionId: string,
  epoch: number,
  clock: FakeClock,
  text: string,
  level: 'debug' | 'log' | 'info' | 'warn' | 'error' = 'log',
): AnyEvent {
  return {
    sessionId,
    epoch,
    tsWall: clock.wall(),
    tsMono: clock.mono(),
    actor: 'app',
    type: 'console.entry',
    payload: { level, source: 'page', text },
  };
}

export function navEvent(
  sessionId: string,
  epoch: number,
  clock: FakeClock,
  url: string,
  opts: { kind?: 'attached' | 'navigated' | 'route'; isRefresh?: boolean } = {},
): AnyEvent {
  const base = {
    sessionId,
    epoch,
    tsWall: clock.wall(),
    tsMono: clock.mono(),
  };
  switch (opts.kind ?? 'navigated') {
    case 'attached':
      return {
        ...base,
        actor: 'system',
        type: 'session.attached',
        payload: { url, targetType: 'page' },
      };
    case 'route':
      return { ...base, actor: 'app', type: 'state.route', payload: { to: url, kind: 'push' } };
    default:
      return {
        ...base,
        actor: 'app',
        type: 'session.navigated',
        payload: { url, isRefresh: opts.isRefresh ?? false },
      };
  }
}

export function requestTriple(
  sessionId: string,
  epoch: number,
  clock: FakeClock,
  requestId: string,
  url: string,
  opts: { status?: number; size?: number; postSize?: number; documentUrl?: string } = {},
): AnyEvent[] {
  const base = {
    sessionId,
    epoch,
    actor: 'app' as const,
    requestId,
  };
  return [
    {
      ...base,
      tsWall: clock.wall(),
      tsMono: clock.mono(),
      type: 'network.request',
      payload: {
        url,
        method: 'GET',
        headers: { accept: '*/*' },
        resourceType: 'fetch',
        documentUrl: opts.documentUrl,
        postDataSize: opts.postSize,
      },
    },
    {
      ...base,
      tsWall: clock.wall() + 5,
      tsMono: clock.mono() + 5,
      type: 'network.response',
      payload: { url, status: opts.status ?? 200, headers: { 'content-type': 'application/json' } },
    },
    {
      ...base,
      tsWall: clock.wall() + 10,
      tsMono: clock.mono() + 10,
      type: 'network.finished',
      payload: { encodedDataLength: opts.size ?? 1000 },
    },
  ];
}
