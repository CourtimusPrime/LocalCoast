/**
 * Node agent (AD-8 Tier 2): `NODE_OPTIONS=--require @localcoast/node-agent`.
 * Hooks DB drivers (pg / mysql2 / Prisma $on('query')) and outbound http/undici
 * to feed the DB Query Inspector (with N+1 detection) and the full-fidelity
 * service graph. Uses AsyncLocalStorage so queries attribute to the request
 * that triggered them. Best-effort: if a driver isn't installed, its hook is
 * simply never armed.
 *
 * This file is CommonJS-required into the target process, so it must not import
 * anything ESM-only; it talks to the live instance over plain fetch.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import Module from 'node:module';
import { IngestClient } from './ingest-client.js';

const ingest = new IngestClient();
void ingest.connect(4);

const requestContext = new AsyncLocalStorage<{ traceId: string }>();

/** Normalize SQL for N+1 grouping: literals → ?, whitespace collapsed. */
function normalizeSql(sql: string): string {
  return sql
    .replace(/'[^']*'/g, '?')
    .replace(/\b\d+\b/g, '?')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

const recentQueryShapes = new Map<string, number>();
function duplicateGroup(sql: string): string | undefined {
  const shape = normalizeSql(sql);
  const count = (recentQueryShapes.get(shape) ?? 0) + 1;
  recentQueryShapes.set(shape, count);
  // Reset the window periodically so cross-page-load counts don't accumulate.
  if (recentQueryShapes.size > 500) recentQueryShapes.clear();
  return count > 1 ? shape : undefined;
}

function emitQuery(sql: string, durationMs: number | undefined, driver: string, rowCount?: number): void {
  ingest.send({
    type: 'db.query',
    actor: 'app',
    traceId: requestContext.getStore()?.traceId,
    payload: { sql: sql.slice(0, 2048), driver, durationMs, rowCount, duplicateGroup: duplicateGroup(sql) },
  });
}

const originalRequire = Module.prototype.require;
// Patch require so we hook drivers the moment the app loads them.
(Module.prototype as unknown as { require: typeof originalRequire }).require = function patchedRequire(
  this: NodeModule,
  id: string,
) {
  const loaded = originalRequire.call(this, id) as unknown;
  try {
    if (id === 'pg') hookPg(loaded);
    else if (id === 'mysql2' || id === 'mysql2/promise') hookMysql2(loaded);
  } catch {
    /* driver shape unexpected — skip */
  }
  return loaded;
} as typeof originalRequire;

function hookPg(pg: unknown): void {
  const client = (pg as { Client?: { prototype: { query: (...a: unknown[]) => unknown } } }).Client;
  if (!client) return;
  const original = client.prototype.query;
  client.prototype.query = function query(this: unknown, ...args: unknown[]) {
    const text = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string })?.text ?? '';
    const started = performance.now();
    const result = original.apply(this, args) as { then?: (cb: (r: unknown) => unknown) => unknown };
    if (result && typeof result.then === 'function') {
      return (result as Promise<{ rowCount?: number }>).then((r) => {
        emitQuery(text, performance.now() - started, 'pg', r?.rowCount);
        return r;
      });
    }
    emitQuery(text, performance.now() - started, 'pg');
    return result;
  };
}

function hookMysql2(mysql: unknown): void {
  const proto = (mysql as { Connection?: { prototype: { query: (...a: unknown[]) => unknown } } }).Connection?.prototype;
  if (!proto) return;
  const original = proto.query;
  proto.query = function query(this: unknown, ...args: unknown[]) {
    const sql = typeof args[0] === 'string' ? args[0] : (args[0] as { sql?: string })?.sql ?? '';
    const started = performance.now();
    emitQuery(sql, performance.now() - started, 'mysql2');
    return original.apply(this, args);
  };
}

/** Prisma exposes $on('query') — apps opt in by importing this helper. */
export function attachPrisma(prisma: { $on: (e: string, cb: (ev: { query: string; duration: number }) => void) => void }): void {
  prisma.$on('query', (ev) => emitQuery(ev.query, ev.duration, 'prisma'));
}

// Outbound http hook → service graph edges (Tier 2 fidelity).
const http = originalRequire.call(module, 'node:http') as { request: (...a: unknown[]) => unknown };
const originalHttpRequest = http.request;
http.request = function request(this: unknown, ...args: unknown[]) {
  const opts = args[0];
  const url =
    typeof opts === 'string'
      ? opts
      : `${(opts as { protocol?: string })?.protocol ?? 'http:'}//${(opts as { hostname?: string; host?: string })?.hostname ?? (opts as { host?: string })?.host ?? ''}${(opts as { path?: string })?.path ?? ''}`;
  ingest.send({ type: 'trace.span', actor: 'app', payload: { name: `http ${url}`.slice(0, 256), startTsWall: Date.now(), endTsWall: Date.now(), attrs: { url } } });
  return originalHttpRequest.apply(this, args);
} as typeof originalHttpRequest;

/** Wrap a request handler so its DB queries attribute to a trace id. */
export function withRequestContext<T>(traceId: string, fn: () => T): T {
  return requestContext.run({ traceId }, fn);
}
