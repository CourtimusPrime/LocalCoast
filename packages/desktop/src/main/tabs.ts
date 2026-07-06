import { WebContentsView, type BrowserWindow } from 'electron';
import type { EventStore } from '@localcoast/core';
import type { AgentComponentMessage } from '@localcoast/protocol-types';
import { GuestCdp } from './cdp-mux.js';
import { NetworkCapture } from './capture/network.js';
import { PageAgentHost } from './page-agent-host.js';
import { ResourceSampler } from './capture/sampler.js';
import { ScriptCatalog } from './script-catalog.js';

export const GUEST_PARTITION = 'persist:localcoast-guest';

export interface GuestTab {
  sessionId: string;
  targetKey: string;
  port: number;
  view: WebContentsView;
  cdp: GuestCdp;
  capture: NetworkCapture;
  agent: PageAgentHost;
  scripts: ScriptCatalog;
  sampler: ResourceSampler;
}

/**
 * Guest tab management (AD-1): one WebContentsView per open server, laid out
 * inside the host window below the tab strip and beside the DevTools sidebar.
 * Every guest attaches CDP through the mux and starts the capture pipeline
 * before first navigation, so nothing is missed.
 */
export class TabManager {
  private tabs = new Map<string, GuestTab>();
  private active: string | null = null;
  private counter = 0;
  /** Sessions whose next refresh navigation already had its epoch bumped by reload(). */
  private pendingReloadBump = new Set<string>();
  /** Set by main: guest right-click → Component Selection. */
  onGuestContextMenu: ((sessionId: string, x: number, y: number) => void) | null = null;
  /** Set by main: page-agent component inspect traffic (hover/pick/mode). */
  onComponentInspect: ((sessionId: string, msg: AgentComponentMessage) => void) | null = null;
  /** Lifecycle hooks for engines that track per-tab CDP consumers (mocks, …). */
  onTabOpened: ((sessionId: string, cdp: GuestCdp) => void) | null = null;
  onTabClosed: ((sessionId: string) => void) | null = null;
  /** Layout chrome: [top tab strip, right sidebar] heights/widths in px. */
  layout = { top: 76, right: 420 };
  /** Split view: two sessions side by side, else null. */
  private split: { left: string; right: string } | null = null;
  /** Per-session fixed width override (breakpoint tester). */
  private guestWidths = new Map<string, { width: number; height?: number }>();

  constructor(
    private readonly window: BrowserWindow,
    private readonly store: EventStore,
  ) {
    window.on('resize', () => this.applyBounds());
  }

  list(): GuestTab[] {
    return [...this.tabs.values()];
  }

  get(sessionId: string): GuestTab | undefined {
    return this.tabs.get(sessionId);
  }

  activeTab(): GuestTab | undefined {
    return this.active ? this.tabs.get(this.active) : undefined;
  }

  async open(port: number): Promise<GuestTab> {
    const targetKey = `port:${port}`;
    for (const tab of this.tabs.values()) {
      if (tab.targetKey === targetKey) {
        this.activate(tab.sessionId);
        return tab;
      }
    }

    const sessionId = `s-${port}-${++this.counter}-${Date.now().toString(36)}`;
    const view = new WebContentsView({
      webPreferences: {
        partition: GUEST_PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });

    const cdp = new GuestCdp(view.webContents);
    const capture = new NetworkCapture(cdp, this.store, sessionId, port);
    const agent = new PageAgentHost(cdp, this.store, sessionId);
    const scripts = new ScriptCatalog(cdp);
    const sampler = new ResourceSampler(cdp, this.store, sessionId);
    const tab: GuestTab = { sessionId, targetKey, port, view, cdp, capture, agent, scripts, sampler };
    this.tabs.set(sessionId, tab);

    await this.store.startSession({ sessionId, targetKey });
    // Spin the renderer up on about:blank first — CDP commands sent before the
    // renderer process exists never resolve. Attach + enable capture BEFORE
    // the real navigation (AD-1: guaranteed pre-load instrumentation).
    await view.webContents.loadURL('about:blank');
    await cdp.attach();
    await capture.start();
    await agent.start();
    await scripts.start();
    sampler.start();
    agent.onComponentMessage = (msg) => this.onComponentInspect?.(sessionId, msg);
    this.onTabOpened?.(sessionId, cdp);
    console.log(`[tabs] :${port} attached, capture + page-agent live (${sessionId})`);

    // Component Selection entry point: right-click in the guest.
    view.webContents.on('context-menu', (_evt, params) => {
      this.onGuestContextMenu?.(sessionId, params.x, params.y);
    });

    const url = `http://localhost:${port}/`;
    this.store.appendNow({
      sessionId,
      actor: 'system',
      type: 'session.attached',
      payload: { url, targetType: 'page', port },
    });

    // Epoch semantics (invariant 7): bump only on true reloads. Guest-initiated
    // reloads (location.reload / Cmd+R inside the guest) surface here too.
    view.webContents.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      const current = view.webContents.getURL();
      const isRefresh = current !== '' && current !== 'about:blank' && details.url === current;
      void (async () => {
        // Guest-initiated refreshes (location.reload / in-guest Cmd+R) bump
        // here; LocalCoast-initiated reloads already bumped in reload().
        if (isRefresh && !this.pendingReloadBump.delete(sessionId)) {
          await this.store.bumpEpoch(sessionId);
        }
        this.store.appendNow({
          sessionId,
          actor: 'app',
          type: 'session.navigated',
          payload: { url: details.url, isRefresh },
        });
      })();
    });

    view.webContents.on('render-process-gone', (_evt, details) => {
      this.store.appendNow({
        sessionId,
        actor: 'system',
        type: 'console.entry',
        payload: {
          level: 'error',
          source: 'localcoast',
          text: `guest renderer gone: ${details.reason}`,
        },
      });
    });

    this.window.contentView.addChildView(view);
    this.activate(sessionId);
    await view.webContents.loadURL(url).catch((err) => {
      this.store.appendNow({
        sessionId,
        actor: 'system',
        type: 'console.entry',
        payload: { level: 'error', source: 'localcoast', text: `load failed: ${err}` },
      });
    });
    return tab;
  }

  async close(sessionId: string): Promise<void> {
    const tab = this.tabs.get(sessionId);
    if (!tab) return;
    tab.capture.stop();
    tab.agent.stop();
    tab.scripts.stop();
    tab.sampler.stop();
    this.onTabClosed?.(sessionId);
    await tab.cdp.close();
    this.window.contentView.removeChildView(tab.view);
    tab.view.webContents.close();
    this.tabs.delete(sessionId);
    this.store.appendNow({
      sessionId,
      actor: 'system',
      type: 'session.detached',
      payload: { reason: 'tab closed' },
    });
    await this.store.endSession(sessionId);
    if (this.active === sessionId) {
      this.active = this.tabs.keys().next().value ?? null;
      this.applyBounds();
    }
  }

  activate(sessionId: string): void {
    if (!this.tabs.has(sessionId)) return;
    this.active = sessionId;
    this.applyBounds();
  }

  /** LocalCoast-initiated reload — THE canonical epoch bump (invariant 7). */
  async reload(sessionId: string): Promise<void> {
    const tab = this.tabs.get(sessionId);
    if (!tab) return;
    await this.store.bumpEpoch(sessionId);
    this.pendingReloadBump.add(sessionId);
    tab.view.webContents.reload();
  }

  setLayout(layout: Partial<{ top: number; right: number }>): void {
    this.layout = { ...this.layout, ...layout };
    this.applyBounds();
  }

  setGuestWidth(sessionId: string, width: number, height?: number): void {
    this.guestWidths.set(sessionId, { width, height });
    this.applyBounds();
  }

  setSplit(left: string, right: string): void {
    this.split = { left, right };
    this.applyBounds();
  }

  clearSplit(): void {
    this.split = null;
    this.applyBounds();
  }

  private applyBounds(): void {
    const [width, height] = this.window.getContentSize();
    const contentW = Math.max(0, (width ?? 0) - this.layout.right);
    const contentH = Math.max(0, (height ?? 0) - this.layout.top);

    if (this.split && this.tabs.has(this.split.left) && this.tabs.has(this.split.right)) {
      const half = Math.floor(contentW / 2);
      for (const tab of this.tabs.values()) {
        const isLeft = tab.sessionId === this.split.left;
        const isRight = tab.sessionId === this.split.right;
        tab.view.setVisible(isLeft || isRight);
        if (isLeft) tab.view.setBounds({ x: 0, y: this.layout.top, width: half, height: contentH });
        else if (isRight) tab.view.setBounds({ x: half, y: this.layout.top, width: contentW - half, height: contentH });
      }
      return;
    }

    for (const tab of this.tabs.values()) {
      const isActive = tab.sessionId === this.active;
      tab.view.setVisible(isActive);
      if (isActive) {
        const override = this.guestWidths.get(tab.sessionId);
        tab.view.setBounds({
          x: 0,
          y: this.layout.top,
          width: override ? Math.min(override.width, contentW) : contentW,
          height: override?.height ? Math.min(override.height, contentH) : contentH,
        });
      }
    }
  }
}
