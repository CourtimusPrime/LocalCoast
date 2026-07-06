import { randomBytes } from 'node:crypto';
import type { GuestCdp } from './cdp-mux.js';

/**
 * Mock intercepts (AD-2): a Fetch-domain consumer on the mux. Rules live in
 * the main process so they persist across guest reloads; Fetch.enable only
 * carries the union of active rule patterns and is fully disabled when no
 * rules exist (it pauses every matched request — keep it opt-in per pattern).
 * Fulfilled responses carry `x-localcoast-mock` so capture/panels can badge.
 */

export interface MockRule {
  mockId: string;
  name?: string;
  pattern: { urlPattern: string; method?: string };
  response: {
    status: number;
    headers: Record<string, string>;
    body: string;
    bodyEncoding: 'utf8' | 'base64';
    latencyMs: number;
  };
  hitCount: number;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

export class MockEngine {
  private rules = new Map<string, MockRule>();
  private tabs = new Map<string, GuestCdp>();

  async attachTab(sessionId: string, cdp: GuestCdp): Promise<void> {
    this.tabs.set(sessionId, cdp);
    await this.sync();
  }

  async detachTab(sessionId: string): Promise<void> {
    this.tabs.delete(sessionId);
  }

  async set(rule: Omit<MockRule, 'mockId' | 'hitCount'>): Promise<string> {
    const mockId = `mock-${randomBytes(6).toString('hex')}`;
    this.rules.set(mockId, { ...rule, mockId, hitCount: 0 });
    await this.sync();
    return mockId;
  }

  list(): MockRule[] {
    return [...this.rules.values()];
  }

  async clear(mockId?: string): Promise<number> {
    let cleared: number;
    if (mockId) {
      cleared = this.rules.delete(mockId) ? 1 : 0;
    } else {
      cleared = this.rules.size;
      this.rules.clear();
    }
    await this.sync();
    return cleared;
  }

  /** Re-arbitrate Fetch state on every attached tab. */
  private async sync(): Promise<void> {
    const patterns = [...this.rules.values()].map((r) => ({
      urlPattern: r.pattern.urlPattern,
      requestStage: 'Request' as const,
    }));
    for (const cdp of this.tabs.values()) {
      if (patterns.length === 0) {
        await cdp.unregisterFetchConsumer('mocks').catch(() => undefined);
      } else {
        await cdp
          .registerFetchConsumer({
            id: 'mocks',
            patterns,
            onPaused: (params, guest) => this.onPaused(params, guest),
          })
          .catch(() => undefined);
      }
    }
  }

  private async onPaused(params: Record<string, unknown>, cdp: GuestCdp): Promise<boolean> {
    const request = params.request as { url: string; method: string };
    const rule = [...this.rules.values()].find(
      (r) =>
        globToRegExp(r.pattern.urlPattern).test(request.url) &&
        (!r.pattern.method || r.pattern.method.toUpperCase() === request.method.toUpperCase()),
    );
    if (!rule) return false;

    rule.hitCount++;
    if (rule.response.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, rule.response.latencyMs));
    }
    const bodyBase64 =
      rule.response.bodyEncoding === 'base64'
        ? rule.response.body
        : Buffer.from(rule.response.body, 'utf8').toString('base64');
    await cdp.send(null, 'Fetch.fulfillRequest', {
      requestId: params.requestId as string,
      responseCode: rule.response.status,
      responseHeaders: [
        ...Object.entries(rule.response.headers).map(([name, value]) => ({ name, value })),
        { name: 'x-localcoast-mock', value: rule.mockId },
      ],
      body: bodyBase64,
    });
    return true;
  }
}
