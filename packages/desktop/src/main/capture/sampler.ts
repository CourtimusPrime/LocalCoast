import type { EventStore } from '@localcoast/core';
import type { GuestCdp } from '../cdp-mux.js';

/**
 * Resource sampler (spec: Memory and Resource Monitoring). Runs continuously
 * in the background per tab so anomalies are visible without a manual
 * recording session: JS heap (Runtime.getHeapUsage), DOM node + listener
 * counts (Memory.getDOMCounters). Values land in the fixed-shape `samples`
 * table (never `events`).
 */
export class ResourceSampler {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly cdp: GuestCdp,
    private readonly store: EventStore,
    private readonly sessionId: string,
    private readonly intervalMs = 1000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sample(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async sample(): Promise<void> {
    const tsWall = Date.now();
    const tsMono = performance.now();
    try {
      const heap = (await this.cdp.send(null, 'Runtime.getHeapUsage', {})) as { usedSize?: number };
      if (typeof heap.usedSize === 'number') {
        this.store.addSample({ sessionId: this.sessionId, kind: 'heapBytes', tsWall, tsMono, value: heap.usedSize, resolution: 0 });
      }
    } catch {
      /* target busy/gone this tick */
    }
    try {
      const counters = (await this.cdp.send(null, 'Memory.getDOMCounters', {})) as {
        nodes?: number;
        jsEventListeners?: number;
      };
      if (typeof counters.nodes === 'number') {
        this.store.addSample({ sessionId: this.sessionId, kind: 'domNodes', tsWall, tsMono, value: counters.nodes, resolution: 0 });
      }
      if (typeof counters.jsEventListeners === 'number') {
        this.store.addSample({ sessionId: this.sessionId, kind: 'listeners', tsWall, tsMono, value: counters.jsEventListeners, resolution: 0 });
      }
    } catch {
      /* Memory domain unavailable */
    }
  }
}
