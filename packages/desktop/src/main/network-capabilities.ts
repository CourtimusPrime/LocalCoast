import { shell } from 'electron';
import { isAbsolute, join } from 'node:path';
import {
  CapabilityFault,
  decodeJwt,
  executeReplay,
  extractJwt,
  type Core,
  type ProcessInspector,
} from '@localcoast/core';
import {
  AuthInjectInput,
  AuthInjectOutput,
  AuthTokensInput,
  AuthTokensOutput,
  CookieSetInput,
  CookieSetOutput,
  EditorOpenInput,
  EditorOpenOutput,
  MockClearInput,
  MockClearOutput,
  MockListInput,
  MockListOutput,
  MockSetInput,
  MockSetOutput,
  NetworkReplayInput,
  NetworkReplayOutput,
  WsSendInput,
  WsSendOutput,
  WsSocketsInput,
  WsSocketsOutput,
  type JwtInfoSchema,
} from '@localcoast/protocol-types';
import type { z } from 'zod';
import type { MockEngine } from './mocks.js';
import type { TabManager } from './tabs.js';

type JwtInfo = z.infer<typeof JwtInfoSchema>;

/** Phase-5 network suite: replay, mocks, WS send, tokens, cookies, editor. */
export function registerNetworkCapabilities(
  core: Core,
  tabs: TabManager,
  mocks: MockEngine,
  inspector: ProcessInspector,
): void {
  const requireTab = (sessionId: string) => {
    const tab = tabs.get(sessionId);
    if (!tab) throw new CapabilityFault('target_gone', `no open tab ${sessionId}`);
    return tab;
  };

  // -- replay -----------------------------------------------------------------

  core.registry.registerCommand({
    name: 'network.replay',
    description:
      'Re-fire a captured request with optional header/body/url/method overrides. Host mode hydrates cookies from the live session via CDP (incl. HttpOnly); inPage mode runs fetch inside the page for service-worker-path semantics. Returns the new response plus an inline structural diff against the original.',
    input: NetworkReplayInput,
    output: NetworkReplayOutput,
    surfaces: { palette: true },
    paletteTitle: 'Replay request…',
    handler: async (input) => {
      const detail = (await core.query('network.get', { requestId: input.requestId }, { actor: 'system' })) as {
        summary: { sessionId: string; url: string; method: string; status?: number };
        requestHeaders?: Record<string, string>;
        responseHeaders?: Record<string, string>;
        requestBody?: { encoding: string; data: string };
        responseBody?: { encoding: string; data: string; evicted: boolean };
      };
      const tab = requireTab(detail.summary.sessionId);
      const url = input.overrides.url ?? detail.summary.url;

      if (input.mode === 'inPage') {
        const spec = {
          url,
          method: input.overrides.method ?? detail.summary.method,
          headers: input.overrides.headers ?? {},
          body: input.overrides.body ?? detail.requestBody?.data,
        };
        const started = performance.now();
        const result = (await tab.cdp.send(null, 'Runtime.evaluate', {
          expression: `(async () => {
            const r = await fetch(${JSON.stringify(spec.url)}, {
              method: ${JSON.stringify(spec.method)},
              headers: ${JSON.stringify(spec.headers)},
              body: ${spec.method === 'GET' || spec.method === 'HEAD' ? 'undefined' : JSON.stringify(spec.body ?? null)},
              credentials: 'include',
            });
            const body = await r.text();
            return JSON.stringify({ status: r.status, headers: Object.fromEntries(r.headers.entries()), body });
          })()`,
          awaitPromise: true,
          returnByValue: true,
        })) as { result?: { value?: string }; exceptionDetails?: { text?: string } };
        if (!result.result?.value) {
          throw new CapabilityFault('internal', `in-page replay failed: ${result.exceptionDetails?.text ?? 'no result'}`);
        }
        const parsed = JSON.parse(result.result.value) as {
          status: number;
          headers: Record<string, string>;
          body: string;
        };
        const { diffBodies, diffHeaders } = await import('@localcoast/core');
        const bodyDiff = diffBodies(detail.responseBody?.data ?? '', parsed.body);
        const statusChanged = detail.summary.status !== undefined && detail.summary.status !== parsed.status;
        return {
          status: parsed.status,
          headers: parsed.headers,
          body: { encoding: 'utf8' as const, data: parsed.body, truncated: false, evicted: false },
          durationMs: performance.now() - started,
          diff: {
            identical: bodyDiff.identical && !statusChanged,
            summary: statusChanged
              ? `status ${detail.summary.status} → ${parsed.status}; ${bodyDiff.summary}`
              : bodyDiff.summary,
            bodyDelta: bodyDiff.bodyDelta,
            statusChanged,
            headersChanged: detail.responseHeaders ? diffHeaders(detail.responseHeaders, parsed.headers) : [],
          },
        };
      }

      // Host mode: undici with CDP-hydrated cookies for the target URL.
      const cookieResult = (await tab.cdp.send(null, 'Network.getCookies', { urls: [url] })) as {
        cookies?: Array<{ name: string; value: string }>;
      };
      const cookieHeader = (cookieResult.cookies ?? [])
        .map((c) => `${c.name}=${c.value}`)
        .join('; ');
      const outcome = await executeReplay(
        {
          url: detail.summary.url,
          method: detail.summary.method,
          headers: detail.requestHeaders ?? {},
          body: detail.requestBody?.data,
          originalStatus: detail.summary.status,
          originalHeaders: detail.responseHeaders,
          originalBody: detail.responseBody?.evicted ? undefined : detail.responseBody?.data,
        },
        input.overrides,
        { cookieHeader: cookieHeader || undefined },
      );
      return {
        status: outcome.status,
        headers: outcome.headers,
        body: { encoding: 'utf8' as const, data: outcome.bodyText, truncated: false, evicted: false },
        durationMs: outcome.durationMs,
        diff: outcome.diff,
      };
    },
  });

  // -- mocks ---------------------------------------------------------------------

  core.registry.registerCommand({
    name: 'network.mock.set',
    description:
      'Intercept matching requests (glob URL pattern + optional method) and serve a defined response with status/headers/body/latency. Persists across page reloads. Mocked responses carry an x-localcoast-mock header and badge in the Network panel.',
    input: MockSetInput,
    output: MockSetOutput,
    surfaces: { palette: true },
    paletteTitle: 'Mock a request pattern…',
    handler: async (input) => ({
      mockId: await mocks.set({ name: input.name, pattern: input.pattern, response: input.response }),
    }),
  });

  core.registry.registerQuery({
    name: 'network.mock.list',
    description: 'List active mock intercepts with hit counts.',
    input: MockListInput,
    output: MockListOutput,
    handler: async () => ({
      mocks: mocks.list().map((r) => ({
        mockId: r.mockId,
        name: r.name,
        pattern: r.pattern,
        response: r.response,
        hitCount: r.hitCount,
      })),
    }),
  });

  core.registry.registerCommand({
    name: 'network.mock.clear',
    description: 'Remove one mock by id, or all mocks when no id is given.',
    input: MockClearInput,
    output: MockClearOutput,
    surfaces: { palette: true },
    paletteTitle: 'Clear mocks',
    handler: async (input) => ({ cleared: await mocks.clear(input.mockId) }),
  });

  // -- websocket send-into-socket ---------------------------------------------------

  core.registry.registerQuery({
    name: 'network.ws.sockets',
    description: 'Open WebSocket connections in a guest tab (from the page-agent socket registry).',
    input: WsSocketsInput,
    output: WsSocketsOutput,
    handler: async (input) => {
      const tab = requireTab(input.sessionId);
      const result = (await tab.cdp.send(null, 'Runtime.evaluate', {
        expression: `JSON.stringify(window.__localcoastSockets
          ? [...window.__localcoastSockets.entries()].map(([socketId, ws]) => ({ socketId, url: ws.url }))
          : [])`,
        returnByValue: true,
      })) as { result?: { value?: string } };
      return { sockets: JSON.parse(result.result?.value ?? '[]') as Array<{ socketId: number; url: string }> };
    },
  });

  core.registry.registerCommand({
    name: 'network.ws.send',
    description:
      'Send an arbitrary message INTO an open page WebSocket (no CDP method exists for this — goes through the page-agent constructor-wrap registry).',
    input: WsSendInput,
    output: WsSendOutput,
    surfaces: { palette: true },
    paletteTitle: 'Send into WebSocket…',
    handler: async (input) => {
      const tab = requireTab(input.sessionId);
      const result = (await tab.cdp.send(null, 'Runtime.evaluate', {
        expression: `(() => {
          const ws = window.__localcoastSockets && window.__localcoastSockets.get(${input.socketId});
          if (!ws) return JSON.stringify({ ok: false, error: 'no such socket' });
          if (ws.readyState !== 1) return JSON.stringify({ ok: false, error: 'socket not open (state ' + ws.readyState + ')' });
          ws.send(${JSON.stringify(input.data)});
          return JSON.stringify({ ok: true });
        })()`,
        returnByValue: true,
      })) as { result?: { value?: string } };
      return JSON.parse(result.result?.value ?? '{"ok":false,"error":"evaluate failed"}') as {
        ok: boolean;
        error?: string;
      };
    },
  });

  // -- token vault / auth --------------------------------------------------------------

  core.registry.registerQuery({
    name: 'auth.tokens',
    description:
      'Token Vault: every JWT found in localStorage, sessionStorage, cookies, and recent Authorization headers — decoded (header, claims, iat/exp/nbf) with expiry status. Inspection only; signatures are not verified.',
    input: AuthTokensInput,
    output: AuthTokensOutput,
    handler: async (input) => {
      const state = (await core.query('storage.state', { sessionId: input.sessionId }, { actor: 'system' })) as {
        localStorage: Array<{ key: string; value: string }>;
        sessionStorage: Array<{ key: string; value: string }>;
        cookies: Array<{ name: string; value: string }>;
      };
      const tokens: JwtInfo[] = [];
      const push = (source: JwtInfo['source'], sourceKey: string, value: string) => {
        const raw = extractJwt(value);
        if (!raw) return;
        const decoded = decodeJwt(raw);
        if (!decoded) return;
        if (tokens.some((t) => t.raw === raw)) return;
        tokens.push({
          source,
          sourceKey,
          raw,
          header: decoded.header,
          payload: decoded.payload,
          iat: decoded.iat,
          exp: decoded.exp,
          nbf: decoded.nbf,
          expired: decoded.expired,
        });
      };
      for (const e of state.localStorage) push('localStorage', e.key, e.value);
      for (const e of state.sessionStorage) push('sessionStorage', e.key, e.value);
      for (const c of state.cookies) push('cookie', c.name, c.value);
      const requests = await core.store.query({
        sessionId: input.sessionId,
        types: ['network.request'],
        limit: 200,
      });
      for (const evt of requests) {
        if (evt.type !== 'network.request') continue;
        const auth = Object.entries(evt.payload.headers).find(
          ([k]) => k.toLowerCase() === 'authorization',
        );
        if (auth) push('authorizationHeader', evt.payload.url, auth[1]);
      }
      return { tokens };
    },
  });

  core.registry.registerCommand({
    name: 'auth.inject',
    description:
      'Auth State Injection: place a token into the session without a login flow — localStorage/sessionStorage key, cookie (with flags), or an Authorization header rewrite applied to all subsequent requests. For testing role-based access without test accounts.',
    input: AuthInjectInput,
    output: AuthInjectOutput,
    surfaces: { palette: true },
    paletteTitle: 'Inject auth token…',
    handler: async (input) => {
      const tab = requireTab(input.sessionId);
      switch (input.placement) {
        case 'localStorage':
        case 'sessionStorage':
          await tab.cdp.send(null, 'Runtime.evaluate', {
            expression: `${input.placement}.setItem(${JSON.stringify(input.key)}, ${JSON.stringify(input.token)})`,
          });
          return { ok: true };
        case 'cookie': {
          const url = tab.view.webContents.getURL();
          await tab.cdp.send(null, 'Network.setCookie', {
            name: input.key,
            value: input.token,
            url,
            ...input.cookieFlags,
          });
          return { ok: true };
        }
        case 'authorizationHeader': {
          // Header rewrite via the Fetch arbitration: continue every request
          // with an added Authorization header.
          await tab.cdp.registerFetchConsumer({
            id: 'auth-inject',
            patterns: [{ urlPattern: '*', requestStage: 'Request' }],
            onPaused: async (params, guest) => {
              const request = params.request as { headers: Record<string, string> };
              await guest.send(null, 'Fetch.continueRequest', {
                requestId: params.requestId as string,
                headers: [
                  ...Object.entries(request.headers).map(([name, value]) => ({ name, value })),
                  { name: 'Authorization', value: `Bearer ${input.token}` },
                ],
              });
              return true;
            },
          });
          return { ok: true };
        }
      }
    },
  });

  // -- cookie edit-in-place ----------------------------------------------------------------

  core.registry.registerCommand({
    name: 'cookie.set',
    description:
      'Cookie edit-in-place: set/overwrite a cookie including HttpOnly, Secure, and SameSite flags via CDP. Takes effect immediately, no reload.',
    input: CookieSetInput,
    output: CookieSetOutput,
    surfaces: { palette: true },
    paletteTitle: 'Edit cookie…',
    handler: async (input) => {
      const tab = requireTab(input.sessionId);
      await tab.cdp.send(null, 'Network.setCookie', {
        name: input.cookie.name,
        value: input.cookie.value,
        url: tab.view.webContents.getURL(),
        domain: input.cookie.domain,
        path: input.cookie.path,
        expires: input.cookie.expires,
        httpOnly: input.cookie.httpOnly,
        secure: input.cookie.secure,
        sameSite: input.cookie.sameSite,
      });
      return { ok: true };
    },
  });

  // -- editor opener (infra #10) --------------------------------------------------------------

  core.registry.registerCommand({
    name: 'editor.open',
    description:
      'Open a source path (optionally :line) in the configured editor via its URL scheme (vscode:// by default; LOCALCOAST_EDITOR=cursor|zed|vscode overrides). Relative paths resolve against the target project root.',
    input: EditorOpenInput,
    output: EditorOpenOutput,
    surfaces: { palette: true },
    paletteTitle: 'Open file in editor…',
    handler: async (input) => {
      let path = input.path;
      if (!isAbsolute(path) && input.sessionId) {
        const tab = tabs.get(input.sessionId);
        if (tab) {
          const servers = await inspector.listListeningServers();
          const root = servers.find((s) => s.port === tab.port)?.cwd;
          if (root) path = join(root, path);
        }
      }
      const editor = process.env.LOCALCOAST_EDITOR ?? 'vscode';
      const scheme = editor === 'vscode' ? 'vscode' : editor;
      const uri = `${scheme}://file${path}${input.line ? `:${input.line}` : ''}`;
      await shell.openExternal(uri);
      return { ok: true, uri };
    },
  });
}
