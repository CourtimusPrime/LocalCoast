import type { WebContents } from 'electron';
import type { CdpEvent, CdpEventListener, CdpTransport } from '@localcoast/core';

/**
 * cdp-mux (infra #2, invariant 4): the ONLY code allowed to touch
 * webContents.debugger. One debugger client can attach per WebContents, so a
 * single GuestCdp per guest multiplexes every consumer (capture, screenshots,
 * input, page-agent bindings, mocks) over one attach.
 *
 * Responsibilities:
 *  - single attach, re-attach on unexpected detach (crash / navigation loss)
 *  - Target.setAutoAttach (flattened) so OOPIFs, workers, and service workers
 *    surface as flattened sessions with their own cdpSessionId
 *  - Fetch.enable arbitration: consumers (mocks, replay, auth-injection)
 *    register URL patterns; the union is applied, and paused requests route to
 *    the first consumer whose pattern matches — Fetch stays fully disabled
 *    while no consumer needs it (AD-2: it pauses every matched request)
 */

export interface FetchConsumer {
  id: string;
  patterns: Array<{ urlPattern: string; requestStage?: 'Request' | 'Response' }>;
  /** Return true when handled (fulfilled/failed/continued); false to pass on. */
  onPaused(params: Record<string, unknown>, cdp: GuestCdp): Promise<boolean>;
}

export class GuestCdp implements CdpTransport {
  private listeners = new Set<CdpEventListener>();
  private fetchConsumers = new Map<string, FetchConsumer>();
  private enabledDomains = new Set<string>();
  /** Consumers with per-session CDP state (bindings, injected scripts) that the
   *  mux can't restore itself — fired after a crash re-attach so they re-install. */
  private reattachListeners = new Set<() => void>();
  private attached = false;
  private closing = false;

  constructor(private readonly wc: WebContents) {}

  async attach(): Promise<void> {
    if (this.attached) return;
    this.wc.debugger.attach('1.3');
    this.attached = true;

    this.wc.debugger.on('message', (_evt, method, params, sessionId) => {
      void this.route(sessionId || null, method, params as Record<string, unknown>);
    });

    this.wc.debugger.on('detach', (_evt, reason) => {
      this.attached = false;
      if (this.closing) return;
      // Unexpected detach (renderer crash, target swap): re-attach and restore
      // domain enables so consumers keep flowing without re-registration.
      void this.reattachWithRetry(reason);
    });

    await this.restoreState();
  }

  /** Register a callback fired after a crash re-attach so consumers can
   *  re-install per-session CDP state (bindings, injected scripts). */
  onReattach(cb: () => void): () => void {
    this.reattachListeners.add(cb);
    return () => this.reattachListeners.delete(cb);
  }

  private async reattachWithRetry(reason: string): Promise<void> {
    // Retry with backoff: a single failed attach used to leave the mux dead
    // forever (every consumer's send rejecting silently).
    for (const delay of [50, 150, 400, 1000]) {
      await new Promise((r) => setTimeout(r, delay));
      if (this.closing || this.attached) return;
      try {
        this.wc.debugger.attach('1.3');
        this.attached = true;
        await this.restoreState();
        for (const cb of this.reattachListeners) {
          try {
            cb();
          } catch (err) {
            console.error('cdp-mux: reattach listener threw:', err);
          }
        }
        return;
      } catch (err) {
        console.error(`cdp-mux: re-attach after detach (${reason}) failed, retrying:`, err);
      }
    }
    console.error(`cdp-mux: gave up re-attaching after detach (${reason})`);
  }

  private async restoreState(): Promise<void> {
    // Flattened auto-attach captures OOPIFs, workers, service workers (AD-2).
    await this.send(null, 'Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    }).catch(() => undefined);
    for (const domain of this.enabledDomains) {
      await this.send(null, `${domain}.enable`, {}).catch(() => undefined);
    }
    await this.applyFetchState();
  }

  private async route(
    cdpSessionId: string | null,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    if (method === 'Target.attachedToTarget') {
      // Resume sub-targets paused by waitForDebuggerOnStart; enable the same
      // domains there so worker/SW network traffic is captured and labeled.
      const sessionId = params.sessionId as string;
      for (const domain of this.enabledDomains) {
        await this.send(sessionId, `${domain}.enable`, {}).catch(() => undefined);
      }
      await this.send(sessionId, 'Runtime.runIfWaitingForDebugger', {}).catch(() => undefined);
    }
    if (method === 'Fetch.requestPaused') {
      await this.dispatchPaused(params, cdpSessionId);
      return;
    }
    const event: CdpEvent = { cdpSessionId, method, params };
    for (const listener of this.listeners) listener(event);
  }

  /** Track domain enables so re-attach and auto-attached sub-targets restore them. */
  async enableDomain(domain: string, params: Record<string, unknown> = {}): Promise<void> {
    this.enabledDomains.add(domain);
    await this.send(null, `${domain}.enable`, params);
  }

  send(
    cdpSessionId: string | null,
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 10_000,
  ): Promise<Record<string, unknown>> {
    if (!this.attached) return Promise.reject(new Error('cdp-mux: not attached'));
    const command = this.wc.debugger.sendCommand(method, params, cdpSessionId ?? undefined);
    // Guard: commands to a dead/starting renderer can hang forever. Clear the
    // timer on settle so it doesn't leak (one per send, dozens/sec under capture).
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`cdp-mux: ${method} timed out`)), timeoutMs);
      timer.unref?.();
    });
    return Promise.race([command as Promise<Record<string, unknown>>, timeout]).finally(() =>
      clearTimeout(timer),
    );
  }

  onEvent(listener: CdpEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // -- Fetch arbitration -------------------------------------------------------

  async registerFetchConsumer(consumer: FetchConsumer): Promise<void> {
    this.fetchConsumers.set(consumer.id, consumer);
    await this.applyFetchState();
  }

  async unregisterFetchConsumer(id: string): Promise<void> {
    this.fetchConsumers.delete(id);
    await this.applyFetchState();
  }

  private async applyFetchState(): Promise<void> {
    if (!this.attached) return;
    const patterns = [...this.fetchConsumers.values()].flatMap((c) => c.patterns);
    if (patterns.length === 0) {
      await this.send(null, 'Fetch.disable', {}).catch(() => undefined);
      return;
    }
    await this.send(null, 'Fetch.enable', { patterns });
  }

  private async dispatchPaused(
    params: Record<string, unknown>,
    _cdpSessionId: string | null,
  ): Promise<void> {
    for (const consumer of this.fetchConsumers.values()) {
      try {
        if (await consumer.onPaused(params, this)) return;
      } catch (err) {
        console.error(`cdp-mux: fetch consumer ${consumer.id} failed:`, err);
      }
    }
    // Nobody claimed it — let it through untouched.
    await this.send(null, 'Fetch.continueRequest', {
      requestId: params.requestId as string,
    }).catch(() => undefined);
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.attached) {
      try {
        this.wc.debugger.detach();
      } catch {
        // already gone
      }
      this.attached = false;
    }
    this.listeners.clear();
    this.fetchConsumers.clear();
  }
}
