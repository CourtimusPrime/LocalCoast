import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Core } from '../src/core.js';
import { CapabilityFault } from '../src/registry.js';
import { registerBuiltins } from '../src/capabilities/builtins.js';
import { fakeInspector, makeStore } from './helpers.js';

async function makeCore() {
  const { store, clock } = await makeStore();
  const core = new Core(store);
  registerBuiltins(core, { inspector: fakeInspector });
  return { core, store, clock };
}

describe('Core dispatch', () => {
  it('validates input and applies schema defaults', async () => {
    const { core, store } = await makeCore();
    await store.startSession({ sessionId: 's-1', targetKey: 'port:3000' });
    const result = (await core.query('events.query', {}, { actor: 'ui' })) as { events: unknown[] };
    expect(result.events).toEqual([]);
    await expect(
      core.query('events.query', { limit: -5 }, { actor: 'ui' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await store.close();
  });

  it('rejects unknown capabilities and wrong kinds', async () => {
    const { core, store } = await makeCore();
    await expect(core.query('nope.nothing', {}, { actor: 'ui' })).rejects.toMatchObject({
      code: 'not_found',
    });
    // events.query is a query; dispatching it as a command must fail.
    await expect(core.command('events.query', {}, { actor: 'ui' })).rejects.toMatchObject({
      code: 'not_found',
    });
    await store.close();
  });

  it('emits an action.dispatched audit event with actor attribution for every command', async () => {
    const { core, store } = await makeCore();
    await store.startSession({ sessionId: 's-1', targetKey: 'port:3000' });
    core.registry.registerCommand({
      name: 'test.touch',
      description: 'test command',
      input: z.object({ sessionId: z.string() }),
      output: z.object({ done: z.boolean() }),
      surfaces: { palette: true },
      paletteTitle: 'Touch',
      handler: async () => ({ done: true }),
    });

    await core.command('test.touch', { sessionId: 's-1' }, { actor: 'mcp' });
    const audits = await store.query({ types: ['action.dispatched'], limit: 10 });
    expect(audits).toHaveLength(1);
    const audit = audits[0]!;
    expect(audit.actor).toBe('mcp');
    expect((audit.payload as { capability: string }).capability).toBe('test.touch');
    expect((audit.payload as { ok: boolean }).ok).toBe(true);
    await store.close();
  });

  it('audits failed commands too', async () => {
    const { core, store } = await makeCore();
    await store.startSession({ sessionId: 's-1', targetKey: 'port:3000' });
    core.registry.registerCommand({
      name: 'test.boom',
      description: 'always fails',
      input: z.object({}),
      output: z.object({}),
      handler: async () => {
        throw new CapabilityFault('internal', 'boom');
      },
    });
    await expect(core.command('test.boom', {}, { actor: 'palette' })).rejects.toThrow('boom');
    const audits = await store.query({ types: ['action.dispatched'], limit: 10 });
    expect((audits[0]!.payload as { ok: boolean }).ok).toBe(false);
    expect(audits[0]!.actor).toBe('palette');
    await store.close();
  });

  it('enforces output schemas — a lying handler is an internal error, not bad data downstream', async () => {
    const { core, store } = await makeCore();
    core.registry.registerQuery({
      name: 'test.liar',
      description: 'returns junk',
      input: z.object({}),
      output: z.object({ n: z.number() }),
      handler: async () => ({ n: 'not a number' }) as never,
    });
    await expect(core.query('test.liar', {}, { actor: 'ui' })).rejects.toMatchObject({
      code: 'invalid_output',
    });
    await store.close();
  });

  it('registration enforces invariant 2: MCP opt-out requires a written reason', async () => {
    const { core, store } = await makeCore();
    expect(() =>
      core.registry.registerQuery({
        name: 'test.hidden',
        description: 'sneaky',
        input: z.object({}),
        output: z.object({}),
        surfaces: { mcp: false },
        handler: async () => ({}),
      }),
    ).toThrow(/mcpExclusionReason/);
    await store.close();
  });

  it('subscriptions stream validated data and unsubscribe cleanly', async () => {
    const { core, store, clock } = await makeCore();
    await store.startSession({ sessionId: 's-1', targetKey: 'port:3000' });
    const got: unknown[] = [];
    const unsub = core.subscribe(
      'events.subscribe',
      { sessionId: 's-1', types: ['console.entry'] },
      { actor: 'ui' },
      (d) => got.push(d),
    );
    store.append({
      sessionId: 's-1',
      epoch: 0,
      tsWall: clock.wall(),
      tsMono: clock.mono(),
      actor: 'app',
      type: 'console.entry',
      payload: { level: 'log', source: 'page', text: 'hello' },
    });
    expect(got).toHaveLength(1);
    unsub();
    await store.close();
  });
});

describe('palette actions', () => {
  it('actions.list exposes palette-surfaced capabilities and act.dispatch routes to them', async () => {
    const { core, store } = await makeCore();
    await store.startSession({ sessionId: 's-1', targetKey: 'port:3000' });
    core.registry.registerCommand({
      name: 'test.greet',
      description: 'greets',
      input: z.object({ name: z.string() }),
      output: z.object({ greeting: z.string() }),
      surfaces: { palette: true },
      paletteTitle: 'Greet someone',
      handler: async (input) => ({ greeting: `hi ${input.name}` }),
    });

    const list = (await core.query('actions.list', {}, { actor: 'ui' })) as {
      actions: Array<{ id: string; title: string }>;
    };
    const ids = list.actions.map((a) => a.id);
    expect(ids).toContain('test.greet');

    const result = (await core.command(
      'act.dispatch',
      { actionId: 'test.greet', args: { name: 'coast' } },
      { actor: 'mcp' },
    )) as { ok: boolean; result: { greeting: string } };
    expect(result.result.greeting).toBe('hi coast');

    // Non-palette capabilities are not dispatchable as actions.
    await expect(
      core.command('act.dispatch', { actionId: 'events.query', args: {} }, { actor: 'mcp' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await store.close();
  });
});
