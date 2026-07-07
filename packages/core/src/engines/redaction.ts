/**
 * Redaction pass (invariant 8): every export/bundle passes through here before
 * leaving the process. Auth tokens, cookies, Authorization headers, JWTs, and
 * common secret-shaped values are masked. Conservative by construction — it is
 * far better to over-redact a bug bundle than to leak a token into a GitHub
 * issue.
 */

const SECRET_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'proxy-authorization',
]);

const SECRET_KEY_PATTERN =
  /(token|secret|password|passwd|api[-_]?key|auth|credential|session|bearer|private[-_]?key|client[-_]?secret)/i;

const JWT_PATTERN = /eyJ[\w-]+\.[\w-]+\.[\w-]+/g;
const BEARER_PATTERN = /(bearer\s+)[\w.\-~+/]+=*/gi;
// High-entropy-ish long alnum runs (AWS keys, hex secrets) — masked in string values.
const LONG_SECRET_PATTERN = /\b[A-Za-z0-9_\-]{32,}\b/g;
// Stateless twin for guard `.test()`: a /g regex advances lastIndex on .test(),
// which would corrupt subsequent redactValue calls and let real secrets slip.
const LONG_SECRET_TEST = new RegExp(LONG_SECRET_PATTERN.source);

export interface RedactionResult<T> {
  value: T;
  count: number;
}

export function redactString(input: string): { value: string; count: number } {
  let count = 0;
  let out = input.replace(JWT_PATTERN, () => {
    count++;
    return '«redacted-jwt»';
  });
  out = out.replace(BEARER_PATTERN, (_m, prefix: string) => {
    count++;
    return `${prefix}«redacted»`;
  });
  return { value: out, count };
}

/** Deep-redact an arbitrary JSON-ish value. Header maps and secret-named keys
 *  are masked by key; string leaves are scrubbed for embedded secrets. */
export function redactValue(input: unknown, keyHint = ''): RedactionResult<unknown> {
  let count = 0;

  if (typeof input === 'string') {
    if (keyHint && (SECRET_HEADER_NAMES.has(keyHint.toLowerCase()) || SECRET_KEY_PATTERN.test(keyHint))) {
      return { value: '«redacted»', count: 1 };
    }
    const scrubbed = redactString(input);
    let value = scrubbed.value;
    count += scrubbed.count;
    // Standalone long-secret values (not sentences) get masked wholesale.
    if (LONG_SECRET_TEST.test(input) && !input.includes(' ')) {
      value = input.replace(LONG_SECRET_PATTERN, () => {
        count++;
        return '«redacted»';
      });
    }
    return { value, count };
  }

  if (Array.isArray(input)) {
    const value = input.map((item) => {
      const r = redactValue(item, keyHint);
      count += r.count;
      return r.value;
    });
    return { value, count };
  }

  if (input !== null && typeof input === 'object') {
    const value: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
      const r = redactValue(v, k);
      count += r.count;
      value[k] = r.value;
    }
    return { value, count };
  }

  return { value: input, count };
}
