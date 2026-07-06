import { parentPort, workerData } from 'node:worker_threads';
import { SqliteWriter } from './writer.js';

/**
 * Writer worker entrypoint (AD-6): owns the better-sqlite3 handle so its
 * synchronous API never blocks the host thread. Protocol: every message is
 * `{ id, method, args }`; reply is `{ id, ok, result }` or `{ id, ok: false, error }`.
 */

if (!parentPort) throw new Error('writer-worker must run as a worker thread');

const writer = new SqliteWriter((workerData as { dbPath: string }).dbPath);

// getBlob returns a Buffer; structured clone turns it into Uint8Array on the
// other side — the store facade re-wraps it.
const methods = writer as unknown as Record<string, (...args: unknown[]) => unknown>;

parentPort.on('message', (msg: { id: number; method: string; args: unknown[] }) => {
  try {
    const fn = methods[msg.method];
    if (typeof fn !== 'function') throw new Error(`unknown writer method: ${msg.method}`);
    const result = fn.apply(writer, msg.args);
    parentPort!.postMessage({ id: msg.id, ok: true, result });
  } catch (err) {
    parentPort!.postMessage({ id: msg.id, ok: false, error: String(err) });
  }
});
