import { decodeIpc, encodeIpc } from './ipc-codec.js';
import { SqliteWriter } from './writer.js';

/**
 * Writer child-process entrypoint: same protocol as writer-worker, but spoken
 * over process IPC ('advanced' serialization, so Buffers survive). Used by
 * Electron hosts where better-sqlite3's Node-ABI prebuild cannot load in the
 * main process. Usage: node writer-child.js <dbPath>
 */

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('writer-child: missing dbPath argument');
  process.exit(1);
}
if (!process.send) {
  console.error('writer-child: must be spawned with an IPC channel');
  process.exit(1);
}

const writer = new SqliteWriter(dbPath);
const methods = writer as unknown as Record<string, (...args: unknown[]) => unknown>;

process.on('message', (msg: { id: number; method: string; args: unknown[] }) => {
  try {
    const fn = methods[msg.method];
    if (typeof fn !== 'function') throw new Error(`unknown writer method: ${msg.method}`);
    const result = fn.apply(writer, decodeIpc(msg.args) as unknown[]);
    process.send!({ id: msg.id, ok: true, result: encodeIpc(result) });
    if (msg.method === 'close') process.exit(0);
  } catch (err) {
    process.send!({ id: msg.id, ok: false, error: String(err) });
  }
});

process.on('disconnect', () => {
  try {
    writer.close();
  } finally {
    process.exit(0);
  }
});
