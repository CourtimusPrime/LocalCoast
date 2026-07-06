import { describe, expect, it } from 'vitest';
import { Core } from '../src/core.js';
import { registerBuiltins } from '../src/capabilities/builtins.js';
import { consoleEvent, fakeInspector, makeStore, navEvent, requestTriple } from './helpers.js';

async function seededCore() {
  const { store, clock } = await makeStore();
  const core = new Core(store);
  registerBuiltins(core, { inspector: fakeInspector });
  await store.startSession({ sessionId: 's-1', targetKey: 'port:3000' });
  return { core, store, clock };
}

describe('network.list', () => {
  it('aggregates request/response/finished into summaries with totals', async () => {
    const { core, store, clock } = await seededCore();
    for (const evt of requestTriple('s-1', 0, clock, 'r-1', 'http://localhost:3000/api/users', {
      size: 2048,
      postSize: 128,
    })) {
      store.append(evt);
    }
    clock.tick(50);
    for (const evt of requestTriple('s-1', 0, clock, 'r-2', 'http://localhost:3000/api/orders', {
      status: 500,
      size: 512,
    })) {
      store.append(evt);
    }

    const out = (await core.query('network.list', { sessionId: 's-1' }, { actor: 'ui' })) as {
      requests: Array<{ requestId: string; status?: number; durationMs?: number; downloadedBytes?: number }>;
      totals: { uploadedBytes: number; downloadedBytes: number; requestCount: number };
    };
    expect(out.requests).toHaveLength(2);
    // Reverse-chronological: newest first.
    expect(out.requests[0]!.requestId).toBe('r-2');
    expect(out.requests[0]!.status).toBe(500);
    expect(out.requests[1]!.downloadedBytes).toBe(2048);
    expect(out.requests[1]!.durationMs).toBeCloseTo(10);
    expect(out.totals).toEqual({ uploadedBytes: 128, downloadedBytes: 2560, requestCount: 2 });
    await store.close();
  });

  it('scopes to current epoch by default, all epochs on request', async () => {
    const { core, store, clock } = await seededCore();
    for (const evt of requestTriple('s-1', 0, clock, 'r-old', 'http://localhost:3000/old')) {
      store.append(evt);
    }
    await store.bumpEpoch('s-1');
    for (const evt of requestTriple('s-1', 1, clock, 'r-new', 'http://localhost:3000/new')) {
      store.append(evt);
    }

    const current = (await core.query('network.list', { sessionId: 's-1' }, { actor: 'ui' })) as {
      requests: Array<{ requestId: string }>;
    };
    expect(current.requests.map((r) => r.requestId)).toEqual(['r-new']);

    const all = (await core.query(
      'network.list',
      { sessionId: 's-1', epoch: 'all' },
      { actor: 'ui' },
    )) as { requests: Array<{ requestId: string }> };
    expect(all.requests).toHaveLength(2);
    await store.close();
  });
});

describe('network.list page correlation', () => {
  type Stamped = Array<{ requestId: string; pageUrl?: string; navId?: number; startTsWall: number }>;
  const list = async (core: Awaited<ReturnType<typeof seededCore>>['core']) =>
    (await core.query('network.list', { sessionId: 's-1' }, { actor: 'ui' })) as {
      requests: Stamped;
    };

  it('leaves requests before any navigation unstamped but carries wall time', async () => {
    const { core, store, clock } = await seededCore();
    for (const evt of requestTriple('s-1', 0, clock, 'r-1', 'http://localhost:3000/api')) {
      store.append(evt);
    }
    const out = await list(core);
    expect(out.requests[0]!.pageUrl).toBeUndefined();
    expect(out.requests[0]!.navId).toBeUndefined();
    expect(out.requests[0]!.startTsWall).toBe(1_700_000_000_000);
    await store.close();
  });

  it('stamps each OAuth stage with the page active at request start', async () => {
    const { core, store, clock } = await seededCore();
    store.append(navEvent('s-1', 0, clock, 'http://localhost:3000/', { kind: 'attached' }));
    clock.tick(10);
    store.append(navEvent('s-1', 0, clock, 'http://localhost:3000/login'));
    clock.tick(10);
    for (const evt of requestTriple('s-1', 0, clock, 'r-a', 'http://localhost:3000/api/session')) {
      store.append(evt);
    }
    clock.tick(20);
    store.append(navEvent('s-1', 0, clock, 'https://accounts.google.com/o/oauth2/auth', { kind: 'route' }));
    clock.tick(10);
    for (const evt of requestTriple('s-1', 0, clock, 'r-b', 'https://accounts.google.com/token')) {
      store.append(evt);
    }
    clock.tick(20);
    store.append(navEvent('s-1', 0, clock, 'http://localhost:3000/callback'));
    clock.tick(10);
    for (const evt of requestTriple('s-1', 0, clock, 'r-c', 'http://localhost:3000/api/me')) {
      store.append(evt);
    }

    const byId = new Map((await list(core)).requests.map((r) => [r.requestId, r]));
    expect(byId.get('r-a')!.pageUrl).toBe('http://localhost:3000/login');
    expect(byId.get('r-b')!.pageUrl).toBe('https://accounts.google.com/o/oauth2/auth');
    expect(byId.get('r-c')!.pageUrl).toBe('http://localhost:3000/callback');
    const navIds = [byId.get('r-a')!.navId, byId.get('r-b')!.navId, byId.get('r-c')!.navId];
    expect(new Set(navIds).size).toBe(3);
    await store.close();
  });

  it('gives revisits of the same path distinct navIds', async () => {
    const { core, store, clock } = await seededCore();
    store.append(navEvent('s-1', 0, clock, 'http://localhost:3000/login'));
    clock.tick(10);
    for (const evt of requestTriple('s-1', 0, clock, 'r-a', 'http://localhost:3000/a')) {
      store.append(evt);
    }
    clock.tick(20);
    store.append(navEvent('s-1', 0, clock, 'http://localhost:3000/step2'));
    clock.tick(10);
    for (const evt of requestTriple('s-1', 0, clock, 'r-b', 'http://localhost:3000/b')) {
      store.append(evt);
    }
    clock.tick(20);
    store.append(navEvent('s-1', 0, clock, 'http://localhost:3000/login'));
    clock.tick(10);
    for (const evt of requestTriple('s-1', 0, clock, 'r-c', 'http://localhost:3000/c')) {
      store.append(evt);
    }

    const byId = new Map((await list(core)).requests.map((r) => [r.requestId, r]));
    expect(byId.get('r-a')!.pageUrl).toBe('http://localhost:3000/login');
    expect(byId.get('r-c')!.pageUrl).toBe('http://localhost:3000/login');
    expect(byId.get('r-a')!.navId).not.toBe(byId.get('r-c')!.navId);
    await store.close();
  });

  it('collapses consecutive same-URL navs except explicit refreshes', async () => {
    const { core, store, clock } = await seededCore();
    // Startup pair: attached(/) immediately followed by navigated(/) — one segment.
    store.append(navEvent('s-1', 0, clock, 'http://localhost:3000/', { kind: 'attached' }));
    clock.tick(1);
    store.append(navEvent('s-1', 0, clock, 'http://localhost:3000/'));
    clock.tick(10);
    for (const evt of requestTriple('s-1', 0, clock, 'r-a', 'http://localhost:3000/a')) {
      store.append(evt);
    }
    clock.tick(20);
    // Same-URL refresh must open a NEW segment.
    store.append(navEvent('s-1', 0, clock, 'http://localhost:3000/', { isRefresh: true }));
    clock.tick(10);
    for (const evt of requestTriple('s-1', 0, clock, 'r-b', 'http://localhost:3000/b')) {
      store.append(evt);
    }

    const byId = new Map(
      (
        (await core.query('network.list', { sessionId: 's-1', epoch: 'all' }, { actor: 'ui' })) as {
          requests: Stamped;
        }
      ).requests.map((r) => [r.requestId, r]),
    );
    expect(byId.get('r-a')!.pageUrl).toBe('http://localhost:3000/');
    expect(byId.get('r-b')!.pageUrl).toBe('http://localhost:3000/');
    expect(byId.get('r-a')!.navId).not.toBe(byId.get('r-b')!.navId);
    await store.close();
  });

  it('trusts documentUrl when it disagrees with nav correlation (same-tick SPA race)', async () => {
    const { core, store, clock } = await seededCore();
    store.append(navEvent('s-1', 0, clock, 'http://localhost:3000/login'));
    clock.tick(10);
    // Fetch fired same-tick as a pushState whose state.route event lands LATER:
    // documentUrl already reflects the new route.
    for (const evt of requestTriple('s-1', 0, clock, 'r-a', 'http://localhost:3000/api/consent', {
      documentUrl: 'http://localhost:3000/consent',
    })) {
      store.append(evt);
    }
    clock.tick(5);
    store.append(navEvent('s-1', 0, clock, 'http://localhost:3000/consent', { kind: 'route' }));

    const out = await list(core);
    expect(out.requests[0]!.pageUrl).toBe('http://localhost:3000/consent');
    // navId still points at the segment open when the request started.
    expect(out.requests[0]!.navId).toBeDefined();
    await store.close();
  });

  it('keeps the hash from nav events when documentUrl agrees modulo hash (hash routers)', async () => {
    const { core, store, clock } = await seededCore();
    store.append(navEvent('s-1', 0, clock, 'http://localhost:3000/login#/consent', { kind: 'route' }));
    clock.tick(10);
    // Chromium strips the fragment from documentURL.
    for (const evt of requestTriple('s-1', 0, clock, 'r-a', 'http://localhost:3000/api/consent', {
      documentUrl: 'http://localhost:3000/login',
    })) {
      store.append(evt);
    }
    const out = await list(core);
    expect(out.requests[0]!.pageUrl).toBe('http://localhost:3000/login#/consent');
    await store.close();
  });

  it('stamps across epoch bumps (navs are not epoch-filtered)', async () => {
    const { core, store, clock } = await seededCore();
    store.append(navEvent('s-1', 0, clock, 'http://localhost:3000/page'));
    clock.tick(10);
    await store.bumpEpoch('s-1');
    for (const evt of requestTriple('s-1', 1, clock, 'r-a', 'http://localhost:3000/api')) {
      store.append(evt);
    }
    const out = await list(core);
    expect(out.requests[0]!.requestId).toBe('r-a');
    expect(out.requests[0]!.pageUrl).toBe('http://localhost:3000/page');
    await store.close();
  });

  it('network.get stamps the same pageUrl as network.list', async () => {
    const { core, store, clock } = await seededCore();
    store.append(navEvent('s-1', 0, clock, 'http://localhost:3000/login'));
    clock.tick(10);
    for (const evt of requestTriple('s-1', 0, clock, 'r-a', 'http://localhost:3000/api')) {
      store.append(evt);
    }
    const listed = (await list(core)).requests[0]!;
    const got = (await core.query('network.get', { requestId: 'r-a' }, { actor: 'mcp' })) as {
      summary: { pageUrl?: string; navId?: number; startTsWall: number };
    };
    expect(got.summary.pageUrl).toBe('http://localhost:3000/login');
    expect(got.summary.pageUrl).toBe(listed.pageUrl);
    expect(got.summary.startTsWall).toBe(listed.startTsWall);
    await store.close();
  });
});

describe('network.get', () => {
  it('returns full detail with blob-backed bodies', async () => {
    const { core, store, clock } = await seededCore();
    const bodyBlob = await store.putBlob(Buffer.from('{"ok":true}'));
    const [req, res, fin] = requestTriple('s-1', 0, clock, 'r-1', 'http://localhost:3000/api');
    store.append(req!);
    store.append(res!);
    // The body blob rides network.finished — persisted eagerly at capture (AD-2).
    store.append({ ...fin!, blobId: bodyBlob });

    const out = (await core.query('network.get', { requestId: 'r-1' }, { actor: 'mcp' })) as {
      summary: { url: string; status?: number };
      responseBody?: { encoding: string; data: string };
    };
    expect(out.summary.status).toBe(200);
    expect(out.responseBody?.data).toBe('{"ok":true}');
    await store.close();
  });

  it('404s unknown requests', async () => {
    const { core, store } = await seededCore();
    await expect(
      core.query('network.get', { requestId: 'r-missing' }, { actor: 'mcp' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await store.close();
  });
});

describe('console.list / errors.list', () => {
  it('filters console by level and substring', async () => {
    const { core, store, clock } = await seededCore();
    store.append(consoleEvent('s-1', 0, clock, 'boot ok', 'info'));
    store.append(consoleEvent('s-1', 0, clock, 'cart is empty', 'warn'));
    store.append(consoleEvent('s-1', 0, clock, 'checkout failed', 'error'));

    const warnPlus = (await core.query(
      'console.list',
      { sessionId: 's-1', levels: ['warn', 'error'] },
      { actor: 'ui' },
    )) as { entries: unknown[] };
    expect(warnPlus.entries).toHaveLength(2);

    const search = (await core.query(
      'console.list',
      { sessionId: 's-1', textFilter: 'checkout' },
      { actor: 'ui' },
    )) as { entries: Array<{ payload: { text: string } }> };
    expect(search.entries).toHaveLength(1);
    expect(search.entries[0]!.payload.text).toBe('checkout failed');
    await store.close();
  });

  it('groups errors by fingerprint with counts', async () => {
    const { core, store, clock } = await seededCore();
    for (let i = 0; i < 5; i++) {
      store.appendNow({
        sessionId: 's-1',
        actor: 'app',
        type: 'error.uncaught',
        payload: { message: 'Cannot read x of undefined', fingerprint: 'fp-1' },
      });
      clock.tick(10);
    }
    store.appendNow({
      sessionId: 's-1',
      actor: 'app',
      type: 'error.rejection',
      payload: { message: 'fetch failed', fingerprint: 'fp-2' },
    });

    const out = (await core.query('errors.list', { sessionId: 's-1' }, { actor: 'mcp' })) as {
      groups: Array<{ fingerprint: string; count: number }>;
    };
    expect(out.groups).toHaveLength(2);
    const fp1 = out.groups.find((g) => g.fingerprint === 'fp-1');
    expect(fp1?.count).toBe(5);
    await store.close();
  });
});

describe('targets.list', () => {
  it('merges discovered servers with attach state', async () => {
    const { core, store } = await seededCore();
    const out = (await core.query('targets.list', {}, { actor: 'mcp' })) as {
      targets: Array<{ targetKey: string; attached: boolean; sessionId?: string }>;
    };
    expect(out.targets).toHaveLength(2);
    const attached = out.targets.find((t) => t.targetKey === 'port:3000');
    expect(attached?.attached).toBe(true);
    expect(attached?.sessionId).toBe('s-1');
    const unattached = out.targets.find((t) => t.targetKey === 'port:8080');
    expect(unattached?.attached).toBe(false);
    await store.close();
  });
});
