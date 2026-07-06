/**
 * JSON-safe Buffer codec for the writer child-process channel. The child runs
 * on system Node while an Electron host runs a different V8 — 'advanced'
 * (structured-clone) IPC serialization is not wire-compatible across V8
 * versions, so the channel speaks JSON and Buffers travel as tagged base64.
 */

const TAG = '__lcBuf64';

export function encodeIpc(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { [TAG]: Buffer.from(value).toString('base64') };
  }
  if (Array.isArray(value)) return value.map(encodeIpc);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = encodeIpc(v);
    return out;
  }
  return value;
}

export function decodeIpc(value: unknown): unknown {
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj[TAG] === 'string' && Object.keys(obj).length === 1) {
      return Buffer.from(obj[TAG], 'base64');
    }
    if (Array.isArray(value)) return value.map(decodeIpc);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = decodeIpc(v);
    return out;
  }
  return value;
}
