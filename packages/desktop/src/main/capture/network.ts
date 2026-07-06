import { levelToConsole, parseStructuredLog, sniffHmrFrame, type EventStore } from '@localcoast/core';
import type { ResourceTypeSchema } from '@localcoast/protocol-types';
import type { z } from 'zod';
import type { GuestCdp } from '../cdp-mux.js';

type ResourceType = z.infer<typeof ResourceTypeSchema>;

/**
 * Network capture pipeline (AD-2): passive `Network` domain always on, bodies
 * fetched EAGERLY on loadingFinished because Chromium evicts them from its
 * buffers, console + errors via Runtime/Log. Every event lands in the store
 * with the session's current epoch.
 */

const CDP_TO_RESOURCE: Record<string, ResourceType> = {
  Document: 'document',
  Stylesheet: 'stylesheet',
  Image: 'image',
  Media: 'media',
  Font: 'font',
  Script: 'script',
  XHR: 'xhr',
  Fetch: 'fetch',
  EventSource: 'eventsource',
  WebSocket: 'websocket',
  Manifest: 'manifest',
};

const MAX_BODY_BYTES = 4 * 1024 * 1024;

export class NetworkCapture {
  private unsubscribe: (() => void) | null = null;
  private requestUrls = new Map<string, string>();
  /** requestId → true for WS connections that look like HMR sockets. */
  private hmrSockets = new Map<string, number>();

  constructor(
    private readonly cdp: GuestCdp,
    private readonly store: EventStore,
    private readonly sessionId: string,
    private readonly port?: number,
  ) {}

  async start(): Promise<void> {
    await this.cdp.enableDomain('Network', {
      maxTotalBufferSize: 100 * 1024 * 1024,
      maxResourceBufferSize: 20 * 1024 * 1024,
    });
    await this.cdp.enableDomain('Page');
    await this.cdp.enableDomain('Runtime');
    await this.cdp.enableDomain('Log');
    // Accessibility + DOM back session.observe's a11y tree and component-at hit test.
    await this.cdp.enableDomain('DOM').catch(() => undefined);
    await this.cdp.enableDomain('Accessibility').catch(() => undefined);
    this.unsubscribe = this.cdp.onEvent(({ cdpSessionId, method, params }) => {
      void this.handle(cdpSessionId, method, params).catch((err) => {
        console.error(`network capture: ${method} handler failed:`, err);
      });
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private base(cdpSessionId: string | null) {
    return {
      sessionId: this.sessionId,
      targetId: cdpSessionId ?? undefined,
      actor: 'app' as const,
    };
  }

  private async handle(
    cdpSessionId: string | null,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    switch (method) {
      case 'Network.requestWillBeSent': {
        const req = params.request as {
          url: string;
          method: string;
          headers: Record<string, string>;
          postData?: string;
        };
        if (req.url.startsWith('devtools://')) return;
        const requestId = params.requestId as string;
        this.requestUrls.set(requestId, req.url);
        const initiator = params.initiator as
          | { type: string; stack?: { callFrames: Array<Record<string, unknown>> } }
          | undefined;

        // Request bodies: inline when small, else fetched eagerly. GraphQL
        // requests get parsed into named operations (PLAN: never opaque
        // `POST /graphql` rows).
        let postData = req.postData;
        if (!postData && params.hasPostData) {
          try {
            const fetched = (await this.cdp.send(cdpSessionId, 'Network.getRequestPostData', {
              requestId,
            })) as { postData?: string };
            postData = fetched.postData;
          } catch {
            /* body not retrievable */
          }
        }
        let requestBlobId: string | undefined;
        let graphqlOperation: string | undefined;
        let graphqlKind: 'query' | 'mutation' | 'subscription' | undefined;
        if (postData) {
          requestBlobId = await this.store.putBlob(Buffer.from(postData, 'utf8'));
          try {
            const parsed = JSON.parse(postData) as { operationName?: string; query?: string };
            if (typeof parsed.query === 'string') {
              const m = /^\s*(query|mutation|subscription)\b\s*(\w+)?/.exec(parsed.query);
              if (m || parsed.operationName) {
                graphqlKind = (m?.[1] as typeof graphqlKind) ?? 'query';
                graphqlOperation =
                  parsed.operationName ?? m?.[2] ?? `anonymous ${graphqlKind}`;
              }
            }
          } catch {
            /* not JSON — not GraphQL */
          }
        }

        this.store.appendNow({
          ...this.base(cdpSessionId),
          type: 'network.request',
          requestId,
          blobId: requestBlobId,
          payload: {
            url: req.url,
            method: req.method,
            headers: req.headers,
            resourceType: CDP_TO_RESOURCE[params.type as string] ?? 'other',
            documentUrl: (params.documentURL as string | undefined) || undefined,
            hasPostData: Boolean(postData) || Boolean(params.hasPostData),
            postDataSize: postData ? Buffer.byteLength(postData) : undefined,
            graphqlOperation,
            graphqlKind,
            initiator: initiator
              ? {
                  kind:
                    initiator.type === 'parser' || initiator.type === 'script' || initiator.type === 'preload'
                      ? (initiator.type as 'parser' | 'script' | 'preload')
                      : 'other',
                  stack: initiator.stack?.callFrames.slice(0, 20).map((f) => ({
                    functionName: (f.functionName as string) || undefined,
                    url: (f.url as string) || undefined,
                    line: f.lineNumber as number,
                    column: f.columnNumber as number,
                  })),
                }
              : undefined,
          },
        });
        break;
      }

      case 'Network.responseReceived': {
        const res = params.response as {
          url: string;
          status: number;
          statusText?: string;
          headers: Record<string, string>;
          mimeType?: string;
          fromServiceWorker?: boolean;
          fromDiskCache?: boolean;
          remoteIPAddress?: string;
          timing?: Record<string, number>;
        };
        const timing = res.timing;
        this.store.appendNow({
          ...this.base(cdpSessionId),
          type: 'network.response',
          requestId: params.requestId as string,
          payload: {
            url: res.url,
            status: res.status,
            statusText: res.statusText,
            headers: res.headers,
            mimeType: res.mimeType,
            fromServiceWorker: res.fromServiceWorker ?? false,
            fromCache: res.fromDiskCache ?? false,
            remoteAddress: res.remoteIPAddress,
            timing: timing
              ? {
                  dnsMs: nonNeg(timing.dnsEnd, timing.dnsStart),
                  connectMs: nonNeg(timing.connectEnd, timing.connectStart),
                  tlsMs: nonNeg(timing.sslEnd, timing.sslStart),
                  ttfbMs: nonNeg(timing.receiveHeadersEnd, 0),
                }
              : undefined,
          },
        });
        break;
      }

      case 'Network.loadingFinished': {
        const requestId = params.requestId as string;
        if (!this.requestUrls.has(requestId)) return;
        // Bodies evict from Chromium buffers — persist immediately (AD-2).
        let blobId: string | undefined;
        let truncated = false;
        try {
          const body = (await this.cdp.send(cdpSessionId, 'Network.getResponseBody', {
            requestId,
          })) as { body: string; base64Encoded: boolean };
          let buf = body.base64Encoded
            ? Buffer.from(body.body, 'base64')
            : Buffer.from(body.body, 'utf8');
          if (buf.byteLength > MAX_BODY_BYTES) {
            buf = buf.subarray(0, MAX_BODY_BYTES);
            truncated = true;
          }
          if (buf.byteLength > 0) blobId = await this.store.putBlob(buf);
        } catch {
          // Some resources (204s, opaque, cached) have no retrievable body.
        }
        this.store.appendNow({
          ...this.base(cdpSessionId),
          type: 'network.finished',
          requestId,
          blobId,
          payload: {
            encodedDataLength: (params.encodedDataLength as number) ?? 0,
            bodyTruncated: truncated || undefined,
          },
        });
        this.requestUrls.delete(requestId);
        break;
      }

      case 'Network.loadingFailed': {
        const requestId = params.requestId as string;
        if (!this.requestUrls.has(requestId)) return;
        this.store.appendNow({
          ...this.base(cdpSessionId),
          type: 'network.failed',
          requestId,
          payload: {
            errorText: (params.errorText as string) ?? 'unknown',
            canceled: (params.canceled as boolean) ?? false,
          },
        });
        this.requestUrls.delete(requestId);
        break;
      }

      case 'Network.webSocketCreated': {
        const url = params.url as string;
        // Vite/webpack/Next HMR sockets — sniff their frames for build status.
        if (/\/(?:vite-hmr|__webpack_hmr|_next\/webpack-hmr|ws)\b/.test(url) || /token=|vite/.test(url)) {
          this.hmrSockets.set(params.requestId as string, this.port ?? 0);
        }
        this.store.appendNow({
          ...this.base(cdpSessionId),
          type: 'network.ws.created',
          requestId: params.requestId as string,
          payload: { url },
        });
        break;
      }

      case 'Network.webSocketFrameSent':
      case 'Network.webSocketFrameReceived': {
        const frame = (params.response ?? {}) as { opcode?: number; payloadData?: string };
        const data = frame.payloadData ?? '';
        // HMR sniffing (AD-8 Tier 0): parse received frames on HMR sockets.
        if (method === 'Network.webSocketFrameReceived' && this.hmrSockets.has(params.requestId as string)) {
          for (const signal of sniffHmrFrame(data)) {
            if (signal.kind === 'build.status') {
              this.store.appendNow({
                ...this.base(cdpSessionId),
                type: 'build.status',
                payload: { state: signal.state ?? 'ok', port: this.port, tool: signal.tool },
              });
            } else if (signal.kind === 'hmr.update') {
              this.store.appendNow({
                ...this.base(cdpSessionId),
                type: 'hmr.update',
                payload: { kind: signal.updateKind ?? 'hot', file: signal.file, modules: signal.modules, port: this.port, tool: signal.tool },
              });
            } else if (signal.kind === 'build.error') {
              this.store.appendNow({
                ...this.base(cdpSessionId),
                type: 'build.error',
                payload: {
                  message: signal.message ?? 'build error',
                  file: signal.errorFile,
                  line: signal.errorLine,
                  severity: 'error',
                  source: 'build',
                },
              });
            }
          }
        }
        this.store.appendNow({
          ...this.base(cdpSessionId),
          type:
            method === 'Network.webSocketFrameSent'
              ? 'network.ws.frameSent'
              : 'network.ws.frameReceived',
          requestId: params.requestId as string,
          payload: {
            opcode: frame.opcode,
            payloadSize: Buffer.byteLength(data),
            payloadPreview: data.slice(0, 256) || undefined,
          },
        });
        break;
      }

      case 'Network.webSocketClosed':
        this.store.appendNow({
          ...this.base(cdpSessionId),
          type: 'network.ws.closed',
          requestId: params.requestId as string,
          payload: {},
        });
        break;

      case 'Network.eventSourceMessageReceived': {
        const data = (params.data as string) ?? '';
        this.store.appendNow({
          ...this.base(cdpSessionId),
          type: 'network.sse.event',
          requestId: params.requestId as string,
          payload: {
            eventName: (params.eventName as string) || undefined,
            dataSize: Buffer.byteLength(data),
            dataPreview: data.slice(0, 256) || undefined,
          },
        });
        break;
      }

      case 'Runtime.consoleAPICalled': {
        const level = params.type as string;
        const args = (params.args as Array<{ value?: unknown; description?: string }>) ?? [];
        const text = args
          .map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? '')))
          .join(' ');
        // Structured log detection (pino/winston/bunyan JSON lines).
        const structured = parseStructuredLog(text);
        this.store.appendNow({
          ...this.base(cdpSessionId),
          type: 'console.entry',
          payload: {
            level: structured
              ? levelToConsole(structured.levelLabel)
              : level === 'warning'
                ? 'warn'
                : isLogLevel(level)
                  ? level
                  : 'log',
            source: 'page',
            text: (structured?.message ?? text).slice(0, 8192),
            args: args.slice(0, 16).map((a) => a.value ?? a.description ?? null),
            structured: structured
              ? {
                  levelLabel: structured.levelLabel,
                  serviceName: structured.serviceName,
                  fields: structured.fields,
                }
              : undefined,
          },
        });
        break;
      }

      case 'Runtime.exceptionThrown': {
        const details = params.exceptionDetails as {
          text?: string;
          exception?: { description?: string };
          url?: string;
          lineNumber?: number;
          columnNumber?: number;
        };
        const message = details.exception?.description ?? details.text ?? 'uncaught exception';
        this.store.appendNow({
          ...this.base(cdpSessionId),
          type: 'error.uncaught',
          payload: {
            message: message.slice(0, 4096),
            rawStack: details.exception?.description,
            url: details.url,
            line: details.lineNumber,
            column: details.columnNumber,
            fingerprint: fingerprint(message),
          },
        });
        break;
      }

      case 'Page.lifecycleEvent': {
        const name = params.name as string;
        if (name === 'DOMContentLoaded' || name === 'load' || name === 'networkIdle') {
          this.store.appendNow({
            ...this.base(cdpSessionId),
            type: 'page.lifecycle',
            payload: {
              phase: name === 'DOMContentLoaded' ? 'domContentLoaded' : (name as 'load' | 'networkIdle'),
            },
          });
        }
        break;
      }
    }
  }
}

function nonNeg(end?: number, start?: number): number | undefined {
  if (end === undefined || start === undefined || end < 0 || start < 0) return undefined;
  return Math.max(0, end - start);
}

function isLogLevel(level: string): level is 'debug' | 'log' | 'info' | 'warn' | 'error' {
  return ['debug', 'log', 'info', 'warn', 'error'].includes(level);
}

/** Stable-ish fingerprint: first line of the message, normalized. */
function fingerprint(message: string): string {
  return message.split('\n')[0]!.replace(/\d+/g, 'N').slice(0, 200);
}
