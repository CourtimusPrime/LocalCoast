import { describe, expect, it } from 'vitest';
import { redactValue } from '../src/engines/redaction.js';
import { levelToConsole, parseStructuredLog } from '../src/engines/log-parse.js';
import { sniffHmrFrame } from '../src/engines/hmr-parse.js';

describe('redaction pass (invariant 8)', () => {
  it('masks auth headers, cookies, and JWTs by key and by content', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.sig';
    const { value, count } = redactValue({
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      cookie: 'session=abc123',
      body: `token is ${jwt} ok`,
      note: 'nothing secret here',
    }) as { value: Record<string, unknown>; count: number };
    const headers = value.headers as Record<string, string>;
    expect(headers.authorization).toBe('«redacted»');
    expect(headers['content-type']).toBe('application/json');
    expect(value.cookie).toBe('«redacted»');
    expect(value.body).toContain('«redacted-jwt»');
    expect(value.note).toBe('nothing secret here');
    expect(count).toBeGreaterThanOrEqual(3);
  });

  it('masks secret-named keys and standalone high-entropy values', () => {
    const { value } = redactValue({
      apiKey: 'AKIAIOSFODNN7EXAMPLEKEY1234567890',
      password: 'hunter2',
      count: 5,
    }) as { value: Record<string, unknown> };
    expect(value.apiKey).toBe('«redacted»');
    expect(value.password).toBe('«redacted»');
    expect(value.count).toBe(5);
  });
});

describe('structured log parsing', () => {
  it('parses pino numeric levels', () => {
    const parsed = parseStructuredLog('{"level":30,"time":1700000000000,"msg":"server started","port":3000}');
    expect(parsed?.levelLabel).toBe('info');
    expect(parsed?.message).toBe('server started');
    expect(parsed?.fields.port).toBe(3000);
    expect(levelToConsole(parsed?.levelLabel)).toBe('info');
  });

  it('parses winston string levels with service name', () => {
    const parsed = parseStructuredLog('{"level":"error","message":"db down","service":"api","code":"ECONN"}');
    expect(parsed?.levelLabel).toBe('error');
    expect(parsed?.serviceName).toBe('api');
    expect(parsed?.fields.code).toBe('ECONN');
  });

  it('rejects plain text and non-log JSON', () => {
    expect(parseStructuredLog('server started on 3000')).toBeNull();
    expect(parseStructuredLog('{"x":1}')).toBeNull();
  });
});

describe('HMR sniff parsers', () => {
  it('parses vite hot update', () => {
    const signals = sniffHmrFrame(JSON.stringify({ type: 'update', updates: [{ path: '/src/App.tsx' }] }));
    expect(signals).toContainEqual(expect.objectContaining({ kind: 'hmr.update', tool: 'vite', updateKind: 'hot', file: '/src/App.tsx' }));
  });

  it('parses vite error into build.status + build.error', () => {
    const signals = sniffHmrFrame(JSON.stringify({ type: 'error', err: { message: 'Unexpected token', id: '/src/x.ts', loc: { line: 12 } } }));
    expect(signals.some((s) => s.kind === 'build.status' && s.state === 'error')).toBe(true);
    expect(signals.some((s) => s.kind === 'build.error' && s.errorLine === 12)).toBe(true);
  });

  it('parses webpack ok/invalid/errors', () => {
    expect(sniffHmrFrame(JSON.stringify({ type: 'invalid' }))[0]).toMatchObject({ state: 'building' });
    expect(sniffHmrFrame(JSON.stringify({ type: 'ok' }))[0]).toMatchObject({ state: 'ok' });
    const errs = sniffHmrFrame(JSON.stringify({ type: 'errors', data: ['TS2322 error'] }));
    expect(errs.some((s) => s.kind === 'build.error')).toBe(true);
  });

  it('parses next building/built', () => {
    expect(sniffHmrFrame(JSON.stringify({ action: 'building' }))[0]).toMatchObject({ tool: 'next', state: 'building' });
    const built = sniffHmrFrame(JSON.stringify({ action: 'built', errors: [] }));
    expect(built.some((s) => s.kind === 'hmr.update')).toBe(true);
  });

  it('ignores non-HMR frames', () => {
    expect(sniffHmrFrame('ping')).toEqual([]);
    expect(sniffHmrFrame(JSON.stringify({ type: 'connected' }))).toEqual([]);
  });
});
