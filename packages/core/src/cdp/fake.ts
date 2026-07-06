import { z } from 'zod';
import type { CdpEvent, CdpEventListener, CdpTransport } from './transport.js';

/**
 * Fake CdpTransport for the core test suite. Two modes, composable:
 *  - canned responders keyed by method (with optional param matching)
 *  - fixture playback: recorded CDP traffic (see FixtureSchema) replayed in
 *    order; `send` calls are matched against recorded sends, interleaved
 *    `recv` entries emit as events up to the next expected send.
 */

export const CdpFixtureEntrySchema = z.discriminatedUnion('dir', [
  z.object({
    dir: z.literal('send'),
    cdpSessionId: z.string().nullable().default(null),
    method: z.string(),
    params: z.record(z.string(), z.unknown()).default({}),
    result: z.record(z.string(), z.unknown()).default({}),
  }),
  z.object({
    dir: z.literal('recv'),
    cdpSessionId: z.string().nullable().default(null),
    method: z.string(),
    params: z.record(z.string(), z.unknown()).default({}),
  }),
]);

export const CdpFixtureSchema = z.object({
  version: z.literal(1),
  name: z.string(),
  entries: z.array(CdpFixtureEntrySchema),
});
export type CdpFixture = z.infer<typeof CdpFixtureSchema>;

type Responder = (
  params: Record<string, unknown>,
  cdpSessionId: string | null,
) => Record<string, unknown> | Promise<Record<string, unknown>>;

export class FakeCdpTransport implements CdpTransport {
  private listeners = new Set<CdpEventListener>();
  private responders = new Map<string, Responder>();
  private fixture: CdpFixture | null = null;
  private cursor = 0;
  /** Every send() call, for assertions. */
  readonly sent: Array<{ cdpSessionId: string | null; method: string; params: Record<string, unknown> }> = [];
  closed = false;

  respondTo(method: string, responder: Responder | Record<string, unknown>): void {
    this.responders.set(
      method,
      typeof responder === 'function' ? responder : () => responder,
    );
  }

  loadFixture(fixture: unknown): void {
    this.fixture = CdpFixtureSchema.parse(fixture);
    this.cursor = 0;
  }

  /** Emit a CDP event to core, as the real mux would on debugger message. */
  emit(event: CdpEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /** Replay recv entries until the next send (or end of fixture). */
  drainRecv(): number {
    if (!this.fixture) return 0;
    let emitted = 0;
    while (this.cursor < this.fixture.entries.length) {
      const entry = this.fixture.entries[this.cursor]!;
      if (entry.dir === 'send') break;
      this.cursor++;
      emitted++;
      this.emit({ cdpSessionId: entry.cdpSessionId, method: entry.method, params: entry.params });
    }
    return emitted;
  }

  async send(
    cdpSessionId: string | null,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    if (this.closed) throw new Error('FakeCdpTransport closed');
    this.sent.push({ cdpSessionId, method, params });

    if (this.fixture) {
      this.drainRecv();
      const entry = this.fixture.entries[this.cursor];
      if (entry && entry.dir === 'send' && entry.method === method) {
        this.cursor++;
        const result = entry.result;
        // Events recorded between this send and the next one flow after the reply.
        queueMicrotask(() => this.drainRecv());
        return result;
      }
    }

    const responder = this.responders.get(method);
    if (responder) return responder(params, cdpSessionId);
    return {};
  }

  onEvent(listener: CdpEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.listeners.clear();
  }
}
