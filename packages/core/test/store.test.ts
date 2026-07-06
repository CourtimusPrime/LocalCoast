import { describe, expect, it } from 'vitest';
import { ChildProcessBackend, EventStore, WorkerBackend } from '../src/events/store.js';
import { consoleEvent, FakeClock, makeStore, tempDbPath } from './helpers.js';

describe('EventStore', () => {
  it('assigns monotonic ids and round-trips events through SQLite', async () => {
    const { store, clock } = await makeStore();
    await store.startSession({ sessionId: 's-1', targetKey: 'port:3000' });

    const a = store.append(consoleEvent('s-1', 0, clock, 'first'));
    clock.tick(10);
    const b = store.append(consoleEvent('s-1', 0, clock, 'second'));
    expect(b.id).toBe(a.id + 1);

    const events = await store.query({ sessionId: 's-1', limit: 10 });
    expect(events.map((e) => (e.payload as { text: string }).text)).toEqual(['first', 'second']);
    await store.close();
  });

  it('rejects events that violate the taxonomy', async () => {
    const { store } = await makeStore();
    await store.startSession({ sessionId: 's-1', targetKey: 'port:3000' });
    expect(() =>
      store.append({
        sessionId: 's-1',
        epoch: 0,
        tsWall: 1,
        tsMono: 1,
        actor: 'app',
        type: 'console.entry',
        payload: { wrong: true },
      } as never),
    ).toThrow();
    await store.close();
  });

  it('epoch bumps on explicit refresh only, and epoch filtering is a view filter not a deletion', async () => {
    const { store, clock } = await makeStore();
    await store.startSession({ sessionId: 's-1', targetKey: 'port:3000' });

    store.append(consoleEvent('s-1', store.currentEpoch('s-1'), clock, 'epoch0'));
    // SPA route change: no bump.
    store.appendNow({
      sessionId: 's-1',
      actor: 'app',
      type: 'state.route',
      payload: { to: '/about', kind: 'push' },
    });
    expect(store.currentEpoch('s-1')).toBe(0);

    // Explicit refresh.
    await store.bumpEpoch('s-1');
    expect(store.currentEpoch('s-1')).toBe(1);
    store.append(consoleEvent('s-1', 1, clock, 'epoch1'));

    const current = await store.query({ sessionId: 's-1', epoch: 1, types: ['console.entry'], limit: 10 });
    expect(current).toHaveLength(1);
    expect((current[0]!.payload as { text: string }).text).toBe('epoch1');

    // All epochs still queryable — nothing was deleted.
    const all = await store.query({ sessionId: 's-1', types: ['console.entry'], limit: 10 });
    expect(all).toHaveLength(2);
    await store.close();
  });

  it('persists epochs across reopen', async () => {
    const clock = new FakeClock();
    const dbPath = tempDbPath();
    const { InProcessBackend } = await import('../src/events/store.js');
    let store = new EventStore({ backend: new InProcessBackend(dbPath), clock, batchMs: 1 });
    await store.open();
    await store.startSession({ sessionId: 's-1', targetKey: 'port:3000' });
    await store.bumpEpoch('s-1');
    await store.bumpEpoch('s-1');
    await store.close();

    store = new EventStore({ backend: new InProcessBackend(dbPath), clock, batchMs: 1 });
    await store.open();
    expect(store.currentEpoch('s-1')).toBe(2);
    await store.close();
  });

  it('serves recent events from the hot ring without flushing', () => {
    return makeStore().then(async ({ store, clock }) => {
      await store.startSession({ sessionId: 's-1', targetKey: 'port:3000' });
      store.append(consoleEvent('s-1', 0, clock, 'old'));
      clock.tick(70_000);
      store.append(consoleEvent('s-1', 0, clock, 'recent'));

      const last60 = store.recent('s-1', 60_000);
      expect(last60).toHaveLength(1);
      expect((last60[0]!.payload as { text: string }).text).toBe('recent');
      await store.close();
    });
  });

  it('notifies subscribers with type and session filters', async () => {
    const { store, clock } = await makeStore();
    await store.startSession({ sessionId: 's-1', targetKey: 'port:3000' });
    await store.startSession({ sessionId: 's-2', targetKey: 'port:8080' });

    const seen: string[] = [];
    const unsub = store.onEvent((e) => seen.push(e.sessionId), {
      sessionId: 's-1',
      types: ['console.entry'],
    });
    store.append(consoleEvent('s-1', 0, clock, 'yes'));
    store.append(consoleEvent('s-2', 0, clock, 'other session'));
    store.appendNow({
      sessionId: 's-1',
      actor: 'app',
      type: 'state.route',
      payload: { to: '/x', kind: 'push' },
    });
    expect(seen).toEqual(['s-1']);
    unsub();
    store.append(consoleEvent('s-1', 0, clock, 'after unsub'));
    expect(seen).toEqual(['s-1']);
    await store.close();
  });

  it('stores content-addressed blobs and dedupes identical payloads', async () => {
    const { store } = await makeStore();
    const data = Buffer.from('{"users":[1,2,3]}');
    const id1 = await store.putBlob(data);
    const id2 = await store.putBlob(Buffer.from('{"users":[1,2,3]}'));
    expect(id2).toBe(id1);
    const back = await store.getBlob(id1);
    expect(back?.toString('utf8')).toBe('{"users":[1,2,3]}');
    await store.close();
  });

  it('rolls samples up through resolution tiers', async () => {
    const { store, clock } = await makeStore();
    await store.startSession({ sessionId: 's-1', targetKey: 'port:3000' });
    for (let i = 0; i < 20; i++) {
      store.addSample({
        sessionId: 's-1',
        kind: 'heapBytes',
        tsWall: clock.wall(),
        tsMono: i * 100,
        value: 1000 + i,
        resolution: 0,
      });
    }
    await store.rollupSamples({ to1s: 10_000 });
    const raw = await store.querySamples({ sessionId: 's-1', resolution: 0 });
    expect(raw).toHaveLength(0);
    const rolled = await store.querySamples({ sessionId: 's-1', resolution: 1 });
    expect(rolled.length).toBeGreaterThan(0);
    expect(rolled.length).toBeLessThan(20);
    await store.close();
  });

  it('runs through the real worker-thread writer (production path)', async () => {
    const clock = new FakeClock();
    const workerUrl = new URL('../dist/events/writer-worker.js', import.meta.url);
    const store = new EventStore({
      backend: new WorkerBackend(tempDbPath(), workerUrl),
      clock,
      batchMs: 1,
    });
    await store.open();
    await store.startSession({ sessionId: 's-w', targetKey: 'port:3000' });
    for (let i = 0; i < 250; i++) {
      store.append(consoleEvent('s-w', 0, clock, `msg-${i}`));
    }
    const events = await store.query({ sessionId: 's-w', types: ['console.entry'], limit: 300 });
    expect(events).toHaveLength(250);

    const blobId = await store.putBlob(Buffer.from('worker blob'));
    expect((await store.getBlob(blobId))?.toString('utf8')).toBe('worker blob');
    await store.close();
  });

  it('runs through the child-process writer (Electron-host path)', async () => {
    const clock = new FakeClock();
    const childScript = new URL('../dist/events/writer-child.js', import.meta.url).pathname;
    const store = new EventStore({
      backend: new ChildProcessBackend(tempDbPath(), { childScript }),
      clock,
      batchMs: 1,
    });
    await store.open();
    await store.startSession({ sessionId: 's-c', targetKey: 'port:3000' });
    store.append(consoleEvent('s-c', 0, clock, 'via child'));
    const events = await store.query({ sessionId: 's-c', limit: 10 });
    expect(events).toHaveLength(1);

    // Buffers survive the advanced-serialization IPC boundary.
    const blobId = await store.putBlob(Buffer.from('child blob'));
    expect((await store.getBlob(blobId))?.toString('utf8')).toBe('child blob');
    await store.close();
  });
});
