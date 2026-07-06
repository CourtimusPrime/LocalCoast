import { randomBytes } from 'node:crypto';
import type { EventStore } from '@localcoast/core';
import { AgentBatchSchema, type AgentComponentMessage } from '@localcoast/protocol-types';
import { getIsolatedWorldSource, getMainWorldSource } from '@localcoast/page-agent';
import type { GuestCdp } from './cdp-mux.js';

/**
 * Page-agent host side (AD-4): registers both world scripts via
 * Page.addScriptToEvaluateOnNewDocument (guaranteed pre-app-code), exposes a
 * nonce-named main-world binding plus a stable isolated-world binding, and
 * validates EVERY binding payload against protocol-types schemas before
 * anything reaches the store — the inspected page is untrusted (invariant 6).
 * Traffic flows page → CDP → main process; the renderer is never involved
 * (invariant 5).
 */

const ISOLATED_WORLD_NAME = 'localcoast';

export class PageAgentHost {
  private unsubscribe: (() => void) | null = null;
  private readonly mainBinding = `__lc_${randomBytes(12).toString('hex')}`;
  private readonly isolatedBinding = '__localcoast_isolated__';
  /** Component inspect messages are ephemeral UI traffic — routed to the
   *  controller, never appended to the store. */
  onComponentMessage: ((msg: AgentComponentMessage) => void) | null = null;

  constructor(
    private readonly cdp: GuestCdp,
    private readonly store: EventStore,
    private readonly sessionId: string,
  ) {}

  async start(): Promise<void> {
    await this.cdp.send(null, 'Runtime.addBinding', { name: this.mainBinding });
    await this.cdp.send(null, 'Runtime.addBinding', {
      name: this.isolatedBinding,
      executionContextName: ISOLATED_WORLD_NAME,
    });
    await this.cdp.send(null, 'Page.addScriptToEvaluateOnNewDocument', {
      source: getMainWorldSource(this.mainBinding),
      runImmediately: true,
    });
    await this.cdp.send(null, 'Page.addScriptToEvaluateOnNewDocument', {
      source: getIsolatedWorldSource(this.isolatedBinding),
      worldName: ISOLATED_WORLD_NAME,
      runImmediately: true,
    });

    this.unsubscribe = this.cdp.onEvent(({ method, params }) => {
      if (method !== 'Runtime.bindingCalled') return;
      const name = params.name as string;
      if (name !== this.mainBinding && name !== this.isolatedBinding) return;
      this.ingest(params.payload as string);
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private ingest(payload: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return; // hostile/corrupt — drop
    }
    const result = AgentBatchSchema.safeParse(parsed);
    if (!result.success) return; // schema-invalid from an untrusted page — drop
    const batch = result.data;

    for (const msg of batch.messages) {
      // Rebase guest performance.now() onto wall time via the timeOrigin hint.
      const tsWall = batch.epochHint !== undefined ? batch.epochHint + msg.t : Date.now();
      const common = {
        sessionId: this.sessionId,
        epoch: this.store.currentEpoch(this.sessionId),
        tsWall,
        tsMono: performance.now(),
        actor: 'app' as const,
      };
      switch (msg.kind) {
        case 'storage.op':
          this.store.append({
            ...common,
            type: 'storage.op',
            payload: {
              area: msg.area,
              op: msg.op,
              key: msg.key,
              valueSize: msg.valueSize,
              valuePreview: msg.valuePreview,
              stack: msg.stack,
            },
          });
          break;
        case 'state.route':
          this.store.append({
            ...common,
            type: 'state.route',
            payload: { from: msg.from, to: msg.to, kind: msg.routeKind },
          });
          break;
        case 'framework.detected':
          void this.store.setSessionMeta(this.sessionId, {
            framework: msg.framework,
            frameworkVersion: msg.version,
            devBuild: msg.devBuild,
          });
          break;
        case 'agent.error':
          this.store.append({
            ...common,
            type: 'console.entry',
            payload: { level: 'warn', source: 'localcoast', text: `page-agent: ${msg.message}` },
          });
          break;
        case 'state.action':
          this.store.append({
            ...common,
            type: 'state.action',
            payload: {
              storeId: msg.storeId,
              actionType: msg.actionType,
              payloadPreview: msg.payloadPreview,
            },
          });
          break;
        case 'state.commit':
          this.store.append({
            ...common,
            type: 'state.commit',
            payload: { framework: msg.framework, renderCount: msg.count },
          });
          break;
        case 'perf.longTask':
          this.store.append({
            ...common,
            type: 'perf.longTask',
            payload: { durationMs: msg.durationMs },
          });
          break;
        case 'ws':
          // CDP Network capture already records ws lifecycle; the page-side
          // registry exists for send-into-socket (phase 5) — nothing to store.
          break;
        case 'component.hover':
        case 'component.pick':
        case 'component.mode':
          this.onComponentMessage?.(msg);
          break;
      }
    }
  }
}
