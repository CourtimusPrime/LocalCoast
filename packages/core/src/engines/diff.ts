/**
 * Diff engine (infra #6): structural JSON diff (object-key order-insensitive),
 * header/key-value diffs. Consumed by replay inline diff, diff mode,
 * cross-session request diffing, env-var diff.
 */

export interface JsonDelta {
  path: string;
  kind: 'added' | 'removed' | 'changed';
  before?: unknown;
  after?: unknown;
}

const MAX_DELTAS = 500;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function diffJson(before: unknown, after: unknown, path = '$'): JsonDelta[] {
  const out: JsonDelta[] = [];
  walk(before, after, path, out);
  return out;
}

function walk(a: unknown, b: unknown, path: string, out: JsonDelta[]): void {
  if (out.length >= MAX_DELTAS) return;
  if (Object.is(a, b)) return;

  if (isPlainObject(a) && isPlainObject(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const next = `${path}.${key}`;
      if (!(key in a)) out.push({ path: next, kind: 'added', after: bounded(b[key]) });
      else if (!(key in b)) out.push({ path: next, kind: 'removed', before: bounded(a[key]) });
      else walk(a[key], b[key], next, out);
      if (out.length >= MAX_DELTAS) return;
    }
    return;
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const next = `${path}[${i}]`;
      if (i >= a.length) out.push({ path: next, kind: 'added', after: bounded(b[i]) });
      else if (i >= b.length) out.push({ path: next, kind: 'removed', before: bounded(a[i]) });
      else walk(a[i], b[i], next, out);
      if (out.length >= MAX_DELTAS) return;
    }
    return;
  }

  if (typeof a === typeof b && JSON.stringify(a) === JSON.stringify(b)) return;
  out.push({ path, kind: 'changed', before: bounded(a), after: bounded(b) });
}

/** Cap leaf sizes so deltas stay transportable. */
function bounded(v: unknown): unknown {
  if (typeof v === 'string' && v.length > 512) return `${v.slice(0, 512)}…`;
  if (isPlainObject(v) || Array.isArray(v)) {
    const json = JSON.stringify(v);
    if (json.length > 1024) return `${json.slice(0, 1024)}…`;
  }
  return v;
}

/** Case-insensitive header comparison → names whose values differ. */
export function diffHeaders(
  before: Record<string, string>,
  after: Record<string, string>,
): string[] {
  const norm = (h: Record<string, string>) =>
    Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
  const a = norm(before);
  const b = norm(after);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort();
}

export interface BodyDiffResult {
  identical: boolean;
  summary: string;
  bodyDelta: JsonDelta[];
}

/** Body diff: structural when both sides parse as JSON, string compare otherwise. */
export function diffBodies(before: string, after: string): BodyDiffResult {
  if (before === after) return { identical: true, summary: 'identical', bodyDelta: [] };
  let aJson: unknown;
  let bJson: unknown;
  try {
    aJson = JSON.parse(before);
    bJson = JSON.parse(after);
  } catch {
    return {
      identical: false,
      summary: `bodies differ (${before.length}B → ${after.length}B, non-JSON)`,
      bodyDelta: [],
    };
  }
  const delta = diffJson(aJson, bJson);
  return {
    identical: delta.length === 0,
    summary: delta.length === 0 ? 'identical (JSON-equivalent)' : `${delta.length} JSON differences`,
    bodyDelta: delta,
  };
}
