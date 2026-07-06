import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeJwt, extractJwt } from '../src/engines/jwt.js';
import { diffBodies, diffHeaders, diffJson } from '../src/engines/diff.js';
import {
  endpointKey,
  inferShape,
  mergeShape,
  shapeToJsonSchema,
  validateAgainstShape,
} from '../src/engines/schema-infer.js';
import { executeReplay } from '../src/engines/replay.js';

describe('diff engine', () => {
  it('reports added/removed/changed paths', () => {
    const delta = diffJson(
      { a: 1, b: { c: 'x' }, gone: true },
      { a: 2, b: { c: 'x', d: 'new' } },
    );
    expect(delta).toContainEqual({ path: '$.a', kind: 'changed', before: 1, after: 2 });
    expect(delta).toContainEqual({ path: '$.b.d', kind: 'added', after: 'new' });
    expect(delta).toContainEqual({ path: '$.gone', kind: 'removed', before: true });
  });

  it('is object-key-order insensitive', () => {
    expect(diffJson({ a: 1, b: 2 }, { b: 2, a: 1 })).toEqual([]);
  });

  it('diffs arrays positionally', () => {
    const delta = diffJson([1, 2], [1, 3, 4]);
    expect(delta).toContainEqual({ path: '$[1]', kind: 'changed', before: 2, after: 3 });
    expect(delta).toContainEqual({ path: '$[2]', kind: 'added', after: 4 });
  });

  it('diffs headers case-insensitively', () => {
    expect(diffHeaders({ 'Content-Type': 'a' }, { 'content-type': 'a', 'x-new': 'y' })).toEqual([
      'x-new',
    ]);
  });

  it('falls back to size summary for non-JSON bodies', () => {
    const result = diffBodies('<html>a</html>', '<html>b</html>');
    expect(result.identical).toBe(false);
    expect(result.summary).toContain('non-JSON');
  });
});

describe('jwt engine', () => {
  const jwt = (payload: Record<string, unknown>) =>
    `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;

  it('decodes header/payload and flags expiry', () => {
    const expired = decodeJwt(jwt({ sub: 'u1', exp: 1000 }), 2000);
    expect(expired?.payload.sub).toBe('u1');
    expect(expired?.expired).toBe(true);
    const live = decodeJwt(jwt({ exp: 3000 }), 2000);
    expect(live?.expired).toBe(false);
  });

  it('rejects non-JWTs', () => {
    expect(decodeJwt('not.a.jwt')).toBeNull();
    expect(decodeJwt('onlytwo.parts')).toBeNull();
  });

  it('extracts JWTs from bearer headers and storage values', () => {
    const token = jwt({ sub: 'x' });
    expect(extractJwt(`Bearer ${token}`)).toBe(token);
    expect(extractJwt('plain-string')).toBeNull();
  });
});

describe('schema inference', () => {
  it('accumulates shapes and marks divergent fields optional', () => {
    const merged = mergeShape(
      inferShape({ id: 1, name: 'a' }),
      inferShape({ id: 2, email: 'b@c' }),
    );
    const schema = shapeToJsonSchema(merged) as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(schema.properties).sort()).toEqual(['email', 'id', 'name']);
    expect(schema.required).toEqual(['id']);
  });

  it('flags drift against the accumulated shape', () => {
    const shape = mergeShape(
      inferShape({ items: [{ id: 1 }] }),
      inferShape({ items: [{ id: 2 }] }),
    );
    const problems = validateAgainstShape({ items: [{ id: 'now-a-string' }] }, shape);
    expect(problems.some((p) => p.includes('$.items[0].id'))).toBe(true);
    expect(validateAgainstShape({ items: [{ id: 3 }] }, shape)).toEqual([]);
  });

  it('normalizes endpoint keys', () => {
    expect(endpointKey('get', 'http://localhost:3000/api/users/123?tab=1')).toBe(
      'GET /api/users/:id',
    );
    expect(endpointKey('POST', 'http://localhost:3000/api/orders/550e8400-e29b-41d4-a716-446655440000')).toBe(
      'POST /api/orders/:id',
    );
  });
});

describe('replay engine', () => {
  let port = 0;
  const server = createServer((req, res) => {
    if (req.url === '/api/thing') {
      const version = req.headers['x-version'] ?? '1';
      res.writeHead(version === '1' ? 200 : 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version, cookie: req.headers.cookie ?? null }));
      return;
    }
    res.writeHead(404).end();
  });

  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => server.close());

  it('re-fires with cookie hydration and diffs against the original', async () => {
    const outcome = await executeReplay(
      {
        url: `http://127.0.0.1:${port}/api/thing`,
        method: 'GET',
        headers: { accept: 'application/json' },
        originalStatus: 200,
        originalBody: JSON.stringify({ version: '1', cookie: null }),
      },
      {},
      { cookieHeader: 'session=abc' },
    );
    expect(outcome.status).toBe(200);
    expect(outcome.diff.statusChanged).toBe(false);
    // Cookie hydration visible in the diff: server echoed it back.
    expect(outcome.diff.bodyDelta).toContainEqual(
      expect.objectContaining({ path: '$.cookie', kind: 'changed', after: 'session=abc' }),
    );
  });

  it('applies overrides and reports status change', async () => {
    const outcome = await executeReplay(
      {
        url: `http://127.0.0.1:${port}/api/thing`,
        method: 'GET',
        headers: {},
        originalStatus: 200,
        originalBody: '{}',
      },
      { headers: { 'x-version': '2' } },
    );
    expect(outcome.status).toBe(500);
    expect(outcome.diff.statusChanged).toBe(true);
    expect(outcome.diff.summary).toContain('200 → 500');
  });
});
