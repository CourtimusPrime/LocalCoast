import { describe, expect, it } from 'vitest';
import { Core } from '../src/core.js';
import { registerBuiltins } from '../src/capabilities/builtins.js';
import { consoleEvent, fakeInspector, makeStore, requestTriple } from './helpers.js';

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
