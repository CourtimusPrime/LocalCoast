import { WebContentsView, type BrowserWindow } from 'electron';
import type { TargetPreviewOutput } from '@localcoast/protocol-types';
import type { z } from 'zod';
import { GuestCdp } from './cdp-mux.js';
import { GUEST_PARTITION, type TabManager } from './tabs.js';

type PreviewResult = z.infer<typeof TargetPreviewOutput>;

interface CacheEntry {
  /** Absent for JSON endpoints (contentKind 'json') — no screenshot is taken. */
  base64?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  capturedAtWall: number;
  contentKind: 'page' | 'json';
}

/** Rendered viewport for offscreen captures (decoupled from the 1×1 native view). */
const VIEW_W = 1280;
const VIEW_H = 800;
/** CDP clip scale → thumbnail is VIEW × SCALE (≈320×200). */
const SCALE = 0.25;
const JPEG_QUALITY = 60;
/** A cached shot older than this is recaptured (unless the caller overrides). */
const CACHE_TTL_MS = 15_000;
/** A single offscreen navigation may not exceed this. */
const LOAD_TIMEOUT_MS = 6_000;
/** Wait after load for first paint — capturing at the load event alone yields white. */
const SETTLE_MS = 400;
/** Tear the pooled view down after this much idle to free memory. */
const IDLE_EVICT_MS = 60_000;

class PreviewTimeout extends Error {}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Server-list thumbnails (invariant 1: the preview is delivered as base64 data
 * through a registry query, never an embedded frame of the untrusted guest).
 *
 * Two capture paths:
 *  - ATTACHED server → screenshot straight off the live GuestTab's cdp (free).
 *  - DETECTED server → load it offscreen in ONE pooled, hidden WebContentsView
 *    and screenshot via CDP. The pool is reused across ports, captures are
 *    serialized, and results are cached with a TTL so the renderer's 3s poll
 *    never triggers a recapture storm.
 *
 * Never routes through TabManager.open — a preview is not an inspection session
 * and must stay entirely out of the event store.
 */
export class PreviewCapturer {
  private readonly cache = new Map<number, CacheEntry>();
  private readonly inflight = new Map<number, Promise<PreviewResult>>();
  /** Serializes offscreen captures onto the single pooled view. */
  private queue: Promise<unknown> = Promise.resolve();
  private view: WebContentsView | null = null;
  private cdp: GuestCdp | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(
    private readonly window: BrowserWindow,
    private readonly tabs: TabManager,
  ) {}

  async capture(port: number, maxAgeMs?: number): Promise<PreviewResult> {
    const maxAge = maxAgeMs ?? CACHE_TTL_MS;
    const cached = this.cache.get(port);
    if (cached && Date.now() - cached.capturedAtWall <= maxAge) return this.ok(port, cached);

    const existing = this.inflight.get(port);
    if (existing) return existing;

    const run = this.doCapture(port).finally(() => this.inflight.delete(port));
    this.inflight.set(port, run);
    return run;
  }

  private doCapture(port: number): Promise<PreviewResult> {
    const tab = this.tabs.list().find((t) => t.port === port);
    if (tab) return this.captureAttached(port, tab.cdp, tab.view.getBounds());
    return this.captureOffscreen(port);
  }

  // -- attached path ----------------------------------------------------------

  private async captureAttached(
    port: number,
    cdp: GuestCdp,
    bounds: { width: number; height: number },
  ): Promise<PreviewResult> {
    const width = bounds.width > 0 ? bounds.width : VIEW_W;
    const height = bounds.height > 0 ? bounds.height : VIEW_H;
    try {
      const shot = await this.screenshot(cdp, width, height);
      return this.store(port, shot, Math.round(width * SCALE), Math.round(height * SCALE));
    } catch {
      return this.unavailable(port, 'load_failed');
    }
  }

  // -- offscreen path (pooled, serialized) ------------------------------------

  private captureOffscreen(port: number): Promise<PreviewResult> {
    const run = this.queue.then(() => this.captureOffscreenNow(port));
    // Keep the chain alive regardless of any single capture's outcome.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async captureOffscreenNow(port: number): Promise<PreviewResult> {
    if (this.disposed) return this.unavailable(port, 'unsupported');
    this.clearIdleTimer();
    const { view, cdp } = await this.ensurePool();
    const url = `http://localhost:${port}/`;

    try {
      const load = view.webContents.loadURL(url);
      // Swallow a late rejection if the timeout wins the race below.
      void load.catch(() => undefined);
      await Promise.race([
        load,
        delay(LOAD_TIMEOUT_MS).then(() => {
          throw new PreviewTimeout();
        }),
      ]);
      await delay(SETTLE_MS);
      // A JSON endpoint renders as text; the card wants a "{/}" placeholder, not
      // a screenshot of raw JSON. Chrome reports the served type via contentType.
      const contentType = await view.webContents
        .executeJavaScript('document.contentType')
        .catch(() => '');
      if (typeof contentType === 'string' && contentType.includes('json')) {
        return this.storeJson(port);
      }
      const shot = await this.screenshot(cdp, VIEW_W, VIEW_H);
      return this.store(port, shot, Math.round(VIEW_W * SCALE), Math.round(VIEW_H * SCALE));
    } catch (err) {
      return this.unavailable(port, err instanceof PreviewTimeout ? 'timeout' : 'load_failed');
    } finally {
      // Drop the guest page so it can't keep running during the idle window.
      await view.webContents.loadURL('about:blank').catch(() => undefined);
      this.scheduleIdleEvict();
    }
  }

  private async ensurePool(): Promise<{ view: WebContentsView; cdp: GuestCdp }> {
    if (this.view && this.cdp) return { view: this.view, cdp: this.cdp };
    const view = new WebContentsView({
      webPreferences: {
        partition: GUEST_PARTITION, // reuse the localhost cert-trust proc (main.ts)
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    // Tuck a 1×1 invisible view into the tree; CDP capture works occluded, and
    // setBackgroundThrottling keeps it compositing while hidden.
    this.window.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 1, height: 1 });
    view.setVisible(false);
    view.webContents.setBackgroundThrottling(false);
    // about:blank first — CDP sent before the guest renderer exists never resolves.
    await view.webContents.loadURL('about:blank');
    const cdp = new GuestCdp(view.webContents);
    await cdp.attach();
    // Render at a real desktop viewport despite the 1×1 native bounds.
    await cdp
      .send(null, 'Emulation.setDeviceMetricsOverride', {
        width: VIEW_W,
        height: VIEW_H,
        deviceScaleFactor: 1,
        mobile: false,
      })
      .catch(() => undefined);
    this.view = view;
    this.cdp = cdp;
    return { view, cdp };
  }

  private async screenshot(cdp: GuestCdp, width: number, height: number): Promise<string> {
    const result = (await cdp.send(null, 'Page.captureScreenshot', {
      format: 'jpeg',
      quality: JPEG_QUALITY,
      clip: { x: 0, y: 0, width, height, scale: SCALE },
    })) as { data: string };
    return result.data;
  }

  // -- caching / result helpers ----------------------------------------------

  private store(port: number, base64: string, width: number, height: number): PreviewResult {
    const entry: CacheEntry = {
      base64,
      mimeType: 'image/jpeg',
      width,
      height,
      capturedAtWall: Date.now(),
      contentKind: 'page',
    };
    this.cache.set(port, entry);
    return this.ok(port, entry);
  }

  /** Cache + return a JSON-endpoint result: available, but no screenshot. */
  private storeJson(port: number): PreviewResult {
    const entry: CacheEntry = { capturedAtWall: Date.now(), contentKind: 'json' };
    this.cache.set(port, entry);
    return this.ok(port, entry);
  }

  private ok(port: number, entry: CacheEntry): PreviewResult {
    return {
      port,
      available: true,
      reason: 'ok',
      mimeType: entry.mimeType,
      base64: entry.base64,
      width: entry.width,
      height: entry.height,
      capturedAtWall: entry.capturedAtWall,
      contentKind: entry.contentKind,
    };
  }

  private unavailable(port: number, reason: 'load_failed' | 'timeout' | 'unsupported'): PreviewResult {
    return { port, available: false, reason };
  }

  // -- pooled-view lifecycle --------------------------------------------------

  private scheduleIdleEvict(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => void this.evictPool(), IDLE_EVICT_MS);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private async evictPool(): Promise<void> {
    const view = this.view;
    const cdp = this.cdp;
    this.view = null;
    this.cdp = null;
    if (cdp) await cdp.close().catch(() => undefined);
    if (view) {
      try {
        this.window.contentView.removeChildView(view);
      } catch {
        /* already gone */
      }
      try {
        view.webContents.close();
      } catch {
        /* already gone */
      }
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.clearIdleTimer();
    await this.evictPool();
    this.cache.clear();
    this.inflight.clear();
  }
}
