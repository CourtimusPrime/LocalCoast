import { describe, expect, it } from 'vitest';
import {
  AnyArtifactSchema,
  AnyEventSchema,
  defaultMcpToolName,
  EVENT_TYPES,
  EventsQueryInput,
  FixtureSchema,
  InstanceInfoSchema,
  NetworkListInput,
  ScenarioSchema,
  SessionObserveInput,
  SnapshotDocumentSchema,
} from '../src/index.js';

const envelope = {
  sessionId: 's-1',
  epoch: 0,
  tsWall: 1_700_000_000_000,
  tsMono: 12.5,
  actor: 'app' as const,
};

describe('event taxonomy', () => {
  it('round-trips a network.request event', () => {
    const evt = {
      ...envelope,
      type: 'network.request' as const,
      requestId: 'r-1',
      payload: {
        url: 'http://localhost:3000/api/users',
        method: 'GET',
        headers: { accept: 'application/json' },
        resourceType: 'fetch' as const,
      },
    };
    const parsed = AnyEventSchema.parse(evt);
    expect(parsed).toMatchObject(evt);
  });

  it('rejects a payload that does not match its type', () => {
    const evt = {
      ...envelope,
      type: 'network.request',
      payload: { status: 200 },
    };
    expect(() => AnyEventSchema.parse(evt)).toThrow();
  });

  it('rejects unknown event types', () => {
    expect(() =>
      AnyEventSchema.parse({ ...envelope, type: 'made.up', payload: {} }),
    ).toThrow();
  });

  it('exposes a complete EVENT_TYPES list', () => {
    expect(EVENT_TYPES).toContain('console.entry');
    expect(EVENT_TYPES).toContain('storage.op');
    expect(EVENT_TYPES.length).toBeGreaterThanOrEqual(30);
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
  });
});

describe('capability IO defaults', () => {
  it('events.query applies epoch=current and pagination defaults', () => {
    const parsed = EventsQueryInput.parse({});
    expect(parsed.epoch).toBe('current');
    expect(parsed.limit).toBe(100);
  });

  it('network.list accepts explicit numeric epoch', () => {
    const parsed = NetworkListInput.parse({ epoch: 3, limit: 10 });
    expect(parsed.epoch).toBe(3);
  });

  it('session.observe fills include + budgets from empty input', () => {
    const parsed = SessionObserveInput.parse({ sessionId: 's-1' });
    expect(parsed.include.a11y).toBe(true);
    expect(parsed.budgets.consoleEntries).toBe(50);
  });
});

describe('artifacts', () => {
  it('round-trips a fixture', () => {
    const fixture = {
      version: 1,
      kind: 'fixture',
      name: 'logged-in-admin',
      mocks: [
        {
          pattern: { urlPattern: 'http://localhost:3000/api/me' },
          response: { status: 200, headers: {}, body: '{"role":"admin"}', bodyEncoding: 'utf8', latencyMs: 0 },
        },
      ],
      authTokens: [],
    };
    const parsed = FixtureSchema.parse(fixture);
    expect(parsed.name).toBe('logged-in-admin');
    expect(AnyArtifactSchema.parse(parsed).kind).toBe('fixture');
  });

  it('round-trips a scenario with discriminated steps', () => {
    const scenario = ScenarioSchema.parse({
      version: 1,
      kind: 'scenario',
      name: 'add-to-cart',
      steps: [
        { action: 'navigate', url: 'http://localhost:3000' },
        { action: 'click', selector: '[data-testid="add"]' },
        {
          action: 'waitFor',
          assertion: { select: 'recentErrors', op: 'count', value: 0 },
        },
      ],
    });
    expect(scenario.steps).toHaveLength(3);
  });

  it('snapshot document defaults prod-build to false', () => {
    const snap = SnapshotDocumentSchema.parse({
      version: 1,
      kind: 'snapshot',
      snapshotId: 'snap-1',
      createdAtWall: Date.now(),
      url: 'http://localhost:3000/checkout',
      storage: {},
    });
    expect(snap.prodBuild).toBe(false);
    expect(snap.storage.localStorage).toEqual({});
  });
});

describe('discovery + mcp naming', () => {
  it('validates instance.json shape', () => {
    const info = InstanceInfoSchema.parse({
      version: 1,
      url: 'http://127.0.0.1:4820/mcp',
      port: 4820,
      pid: 1234,
      token: 'tok',
      startedAtWall: Date.now(),
    });
    expect(info.port).toBe(4820);
  });

  it('maps dotted capability names to lc_ tool names', () => {
    expect(defaultMcpToolName('session.observe')).toBe('lc_session_observe');
    expect(defaultMcpToolName('network.mock.set')).toBe('lc_network_mock_set');
  });
});
