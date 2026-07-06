import type { Core } from '@localcoast/core';
import type { AgentComponentMessage } from '@localcoast/protocol-types';
import type { GuestCdp } from './cdp-mux.js';

/**
 * Component inspect mode host side (AD-3/AD-4). The isolated world streams
 * hover/pick coordinates over the page-agent binding (already schema-validated
 * by PageAgentHost); this controller resolves them through the component.at /
 * component.copyPath capabilities and pushes labels back into the isolated
 * world via Runtime.evaluate against the tracked 'localcoast' execution
 * context. Hover traffic never touches the event store — only a pick's
 * copyPath command leaves an audit trail.
 */

const ISOLATED_WORLD_NAME = 'localcoast';

interface TabState {
  cdp: GuestCdp;
  contextId: number | null;
  mainFrameId: string | null;
  sticky: boolean;
  resolving: boolean;
  pendingHover: { x: number; y: number; seq: number } | null;
  unsub: () => void;
}

interface ResolvedComponent {
  componentName?: string;
  sourcePath?: string;
  line?: number;
  copied?: boolean;
}

export class ComponentInspectController {
  private readonly tabs = new Map<string, TabState>();

  constructor(private readonly core: Core) {}

  attachTab(sessionId: string, cdp: GuestCdp): void {
    const st: TabState = {
      cdp,
      contextId: null,
      mainFrameId: null,
      sticky: false,
      resolving: false,
      pendingHover: null,
      unsub: () => undefined,
    };
    st.unsub = cdp.onEvent(({ cdpSessionId, method, params }) => {
      if (cdpSessionId !== null) return; // main target only (v1: no OOPIFs)
      if (method === 'Runtime.executionContextCreated') {
        const context = params.context as
          | { id?: number; name?: string; auxData?: { frameId?: string } }
          | undefined;
        if (
          context?.name === ISOLATED_WORLD_NAME &&
          (!st.mainFrameId || context.auxData?.frameId === st.mainFrameId)
        ) {
          if (process.env.LC_INSPECT_DEBUG) console.log(`[inspect] context tracked: ${context.id}`);
          st.contextId = context.id ?? null;
          // Sticky mode survives navigations: re-arm the fresh world.
          if (st.sticky) void this.pushMode(st, true);
        }
      } else if (method === 'Runtime.executionContextDestroyed') {
        if ((params.executionContextId as number | undefined) === st.contextId) {
          st.contextId = null;
        }
      } else if (method === 'Runtime.executionContextsCleared') {
        st.contextId = null;
      }
    });
    this.tabs.set(sessionId, st);
    void cdp
      .send(null, 'Page.getFrameTree')
      .then((r) => {
        const tree = r.frameTree as { frame?: { id?: string } } | undefined;
        st.mainFrameId = tree?.frame?.id ?? null;
      })
      .catch(() => undefined);
  }

  detachTab(sessionId: string): void {
    this.tabs.get(sessionId)?.unsub();
    this.tabs.delete(sessionId);
  }

  onAgentMessage(sessionId: string, msg: AgentComponentMessage): void {
    const st = this.tabs.get(sessionId);
    if (!st) return;
    if (process.env.LC_INSPECT_DEBUG) console.log(`[inspect] agent msg: ${msg.kind}`);
    switch (msg.kind) {
      case 'component.hover':
        st.pendingHover = { x: msg.x, y: msg.y, seq: msg.seq };
        if (!st.resolving) void this.drainHover(sessionId, st);
        break;
      case 'component.pick':
        void this.handlePick(sessionId, st, msg);
        break;
      case 'component.mode':
        st.sticky = msg.enabled; // Esc-exit in the page — keep toggle in sync
        break;
    }
  }

  /** Palette/MCP entry: enable/disable/toggle sticky inspect mode. */
  async setMode(sessionId: string, enabled?: boolean): Promise<{ enabled: boolean }> {
    const st = this.tabs.get(sessionId);
    if (!st) return { enabled: false };
    st.sticky = enabled ?? !st.sticky;
    await this.pushMode(st, st.sticky);
    return { enabled: st.sticky };
  }

  /** Latest-wins, one-in-flight hover resolver: coalesces bursts and
   *  serializes main-world __lcPickedFn access. */
  private async drainHover(sessionId: string, st: TabState): Promise<void> {
    st.resolving = true;
    try {
      while (st.pendingHover) {
        const hover = st.pendingHover;
        st.pendingHover = null;
        const resolved = (await this.core
          .query('component.at', { sessionId, x: hover.x, y: hover.y }, { actor: 'system' })
          .catch(() => null)) as ResolvedComponent | null;
        await this.pushLabel(st, {
          seq: hover.seq,
          name: resolved?.componentName,
          path: resolved?.sourcePath,
          line: resolved?.line,
        });
      }
    } finally {
      st.resolving = false;
    }
  }

  private async handlePick(
    sessionId: string,
    st: TabState,
    msg: Extract<AgentComponentMessage, { kind: 'component.pick' }>,
  ): Promise<void> {
    const resolved = (await this.core
      .command(
        'component.copyPath',
        {
          sessionId,
          x: msg.x,
          y: msg.y,
          format: 'nameAndPath',
          fallbackSelector: msg.selectorPath,
        },
        { actor: 'ui' },
      )
      .catch(() => null)) as ResolvedComponent | null;
    await this.pushLabel(st, {
      seq: msg.seq,
      name: resolved?.componentName,
      path: resolved?.sourcePath,
      line: resolved?.line,
      copied: resolved?.copied ?? false,
    });
  }

  private pushLabel(
    st: TabState,
    label: { seq: number; name?: string; path?: string; line?: number; copied?: boolean },
  ): Promise<void> {
    // JSON.stringify embedding is injection-safe: the fields are
    // schema-validated capability output, and the page never evals our data as
    // anything but a JS object literal inside its own hook (invariant 6).
    return this.isolatedEval(
      st,
      `window.__lcInspect && window.__lcInspect.setLabel(${JSON.stringify(label)})`,
    );
  }

  private pushMode(st: TabState, enabled: boolean): Promise<void> {
    return this.isolatedEval(
      st,
      `window.__lcInspect && window.__lcInspect.setMode(${enabled ? 'true' : 'false'})`,
    );
  }

  private async isolatedEval(st: TabState, expression: string): Promise<void> {
    if (st.contextId === null && st.mainFrameId) {
      // Lazy fallback: Chromium returns the existing world's context id for a
      // repeated (frameId, worldName) pair.
      try {
        const created = await st.cdp.send(null, 'Page.createIsolatedWorld', {
          frameId: st.mainFrameId,
          worldName: ISOLATED_WORLD_NAME,
        });
        st.contextId = (created.executionContextId as number | undefined) ?? null;
      } catch {
        return;
      }
    }
    if (st.contextId === null) {
      if (process.env.LC_INSPECT_DEBUG) console.log('[inspect] push skipped: no context');
      return;
    }
    try {
      const r = (await st.cdp.send(null, 'Runtime.evaluate', {
        expression,
        contextId: st.contextId,
        returnByValue: true,
      })) as { result?: { value?: unknown }; exceptionDetails?: unknown };
      if (process.env.LC_INSPECT_DEBUG)
        console.log(`[inspect] push ctx=${st.contextId} value=${JSON.stringify(r.result?.value)} exc=${JSON.stringify(r.exceptionDetails ?? null)}`);
    } catch (err) {
      if (process.env.LC_INSPECT_DEBUG) console.log(`[inspect] push failed: ${String(err)}`);
      st.contextId = null; // stale context (navigation raced us) — re-resolve next push
    }
  }
}
