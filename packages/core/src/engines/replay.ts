import { diffBodies, diffHeaders, type BodyDiffResult } from './diff.js';

/**
 * Request replay engine (AD-2): host-side re-fire via fetch (undici) with
 * caller-supplied cookie hydration. The in-page mode (HttpOnly-credentialed /
 * service-worker-path semantics) lives with the CDP host — this engine is the
 * transport-independent part: build request, execute, diff against original.
 */

export interface ReplaySource {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  originalStatus?: number;
  originalHeaders?: Record<string, string>;
  originalBody?: string;
}

export interface ReplayOverrides {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface ReplayOutcome {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  durationMs: number;
  diff: {
    identical: boolean;
    summary: string;
    bodyDelta: BodyDiffResult['bodyDelta'];
    statusChanged: boolean;
    headersChanged: string[];
  };
}

const STRIP_REQUEST_HEADERS = new Set([
  'content-length',
  'host',
  'connection',
  'accept-encoding',
]);

export async function executeReplay(
  source: ReplaySource,
  overrides: ReplayOverrides,
  opts: { cookieHeader?: string; timeoutMs?: number } = {},
): Promise<ReplayOutcome> {
  const url = overrides.url ?? source.url;
  const method = (overrides.method ?? source.method).toUpperCase();
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...source.headers, ...(overrides.headers ?? {}) })) {
    if (!STRIP_REQUEST_HEADERS.has(k.toLowerCase())) headers[k] = v;
  }
  if (opts.cookieHeader) headers.cookie = opts.cookieHeader;
  const body = overrides.body ?? source.body;

  const started = performance.now();
  const response = await fetch(url, {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : body,
    redirect: 'manual',
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  });
  const bodyText = await response.text();
  const durationMs = performance.now() - started;

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((v, k) => (responseHeaders[k] = v));

  const bodyDiff = diffBodies(source.originalBody ?? '', bodyText);
  const statusChanged =
    source.originalStatus !== undefined && source.originalStatus !== response.status;
  const headersChanged = source.originalHeaders
    ? diffHeaders(source.originalHeaders, responseHeaders).filter(
        // Volatile headers are noise, not contract drift.
        (h) => !['date', 'etag', 'last-modified', 'set-cookie', 'age', 'expires'].includes(h),
      )
    : [];

  return {
    status: response.status,
    headers: responseHeaders,
    bodyText,
    durationMs,
    diff: {
      identical: bodyDiff.identical && !statusChanged,
      summary: statusChanged
        ? `status ${source.originalStatus} → ${response.status}; ${bodyDiff.summary}`
        : bodyDiff.summary,
      bodyDelta: bodyDiff.bodyDelta,
      statusChanged,
      headersChanged,
    },
  };
}
