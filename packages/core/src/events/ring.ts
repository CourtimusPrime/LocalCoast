import type { AnyEvent } from '@localcoast/protocol-types';

type Stored = AnyEvent & { id: number };

/**
 * Write-through hot ring (AD-6): the last ~90 s of events per session, kept in
 * memory on the store's thread. Serves live subscriptions and the
 * last-60-seconds bug-bundle path with zero DB reads.
 */
export class HotRing {
  private bySession = new Map<string, Stored[]>();

  constructor(private windowMs = 90_000) {}

  push(event: Stored): void {
    let arr = this.bySession.get(event.sessionId);
    if (!arr) {
      arr = [];
      this.bySession.set(event.sessionId, arr);
    }
    arr.push(event);
    // Evict by time window; events arrive in tsMono order per session.
    const cutoff = event.tsMono - this.windowMs;
    let drop = 0;
    while (drop < arr.length && arr[drop]!.tsMono < cutoff) drop++;
    if (drop > 0) arr.splice(0, drop);
  }

  recent(sessionId: string, ms: number, nowMono: number): Stored[] {
    const arr = this.bySession.get(sessionId) ?? [];
    const cutoff = nowMono - ms;
    return arr.filter((e) => e.tsMono >= cutoff);
  }

  dropSession(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}
