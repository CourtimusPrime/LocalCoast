/** JWT inspection (Token Vault). Decode-only — this is an inspector, not a verifier. */

export interface DecodedJwt {
  raw: string;
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  iat?: number;
  exp?: number;
  nbf?: number;
  expired: boolean;
}

function b64urlJson(part: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function decodeJwt(raw: string, nowSec = Date.now() / 1000): DecodedJwt | null {
  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  const header = b64urlJson(parts[0]!);
  const payload = b64urlJson(parts[1]!);
  if (!header || !payload || typeof header.alg !== 'string') return null;
  const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
  const exp = num(payload.exp);
  return {
    raw,
    header,
    payload,
    iat: num(payload.iat),
    exp,
    nbf: num(payload.nbf),
    expired: exp !== undefined && exp < nowSec,
  };
}

/** Scan a string (storage value, header) for a bearer/raw JWT. */
export function extractJwt(value: string): string | null {
  const match = /(?:^|\s)(eyJ[\w-]+\.[\w-]+\.[\w-]+)/.exec(value.replace(/^Bearer\s+/i, ' '));
  return match?.[1] ?? null;
}
