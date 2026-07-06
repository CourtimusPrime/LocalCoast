import type { Assertion, AssertionResult } from '@localcoast/protocol-types';

/**
 * Assertion engine (infra #14). Evaluates the declarative DSL against a
 * session.observe result. `select` is a dotted path with [n] index and [*]
 * wildcard — deliberately smaller than JSONPath so agents emit it reliably.
 */

/** Resolve a select path to the set of matched values. */
export function selectPath(root: unknown, path: string): unknown[] {
  let current: unknown[] = [root];
  // Split on dots but keep [n]/[*] with their key.
  const segments = path.replace(/\[(\*|\d+)\]/g, '.[$1]').split('.').filter(Boolean);
  for (const seg of segments) {
    const next: unknown[] = [];
    const indexMatch = /^\[(\*|\d+)\]$/.exec(seg);
    for (const value of current) {
      if (indexMatch) {
        if (!Array.isArray(value)) continue;
        if (indexMatch[1] === '*') next.push(...value);
        else {
          const item = value[Number(indexMatch[1])];
          if (item !== undefined) next.push(item);
        }
      } else if (value !== null && typeof value === 'object') {
        const item = (value as Record<string, unknown>)[seg];
        if (item !== undefined) next.push(item);
      }
    }
    current = next;
  }
  return current;
}

export function evaluateAssertion(root: unknown, assertion: Assertion): AssertionResult {
  const matched = selectPath(root, assertion.select);
  const { op, value } = assertion;
  const first = matched[0];

  let pass = false;
  try {
    switch (op) {
      case 'exists':
        pass = matched.length > 0;
        break;
      case 'absent':
        pass = matched.length === 0;
        break;
      case 'count': {
        // Selecting a single array counts its elements (e.g. "recentErrors"
        // count 0); a wildcard select counts matches.
        const n = matched.length === 1 && Array.isArray(matched[0]) ? matched[0].length : matched.length;
        pass = n === Number(value);
        break;
      }
      case 'equals':
        pass = matched.length > 0 && matched.every((m) => deepEqual(m, value));
        break;
      case 'notEquals':
        pass = matched.length > 0 && matched.every((m) => !deepEqual(m, value));
        break;
      case 'contains':
        pass = matched.some((m) =>
          typeof m === 'string'
            ? m.includes(String(value))
            : Array.isArray(m)
              ? m.some((x) => deepEqual(x, value))
              : false,
        );
        break;
      case 'matches':
        pass = matched.some((m) => typeof m === 'string' && new RegExp(String(value)).test(m));
        break;
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte': {
        const n = Number(first);
        const t = Number(value);
        pass =
          matched.length > 0 &&
          ((op === 'gt' && n > t) ||
            (op === 'gte' && n >= t) ||
            (op === 'lt' && n < t) ||
            (op === 'lte' && n <= t));
        break;
      }
    }
  } catch (err) {
    return { assertion, pass: false, error: String(err) };
  }

  const countActual =
    matched.length === 1 && Array.isArray(matched[0]) ? matched[0].length : matched.length;
  return {
    assertion,
    pass,
    actual: op === 'count' ? countActual : boundedActual(matched),
  };
}

function boundedActual(matched: unknown[]): unknown {
  const value = matched.length === 1 ? matched[0] : matched;
  const json = JSON.stringify(value) ?? 'undefined';
  return json.length > 1024 ? `${json.slice(0, 1024)}…` : value;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) {
    // Coerce for scalar comparisons ("2" == 2 in an assertion is intended).
    if ((typeof a === 'number' || typeof a === 'string') && (typeof b === 'number' || typeof b === 'string')) {
      return String(a) === String(b);
    }
    return false;
  }
  if (a && b && typeof a === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return false;
}
