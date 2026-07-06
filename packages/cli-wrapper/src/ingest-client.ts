import { readInstanceInfo } from '@localcoast/mcp';

/**
 * Tier-2 ingest client: the run-wrapper and node-agent POST structured events
 * to the live LocalCoast instance's HTTP ingest endpoint. Discovery reuses the
 * MCP instance.json (url host/port + token); events land in the same store as
 * everything else.
 */
export class IngestClient {
  private baseUrl: string | null = null;
  private token: string | null = null;
  private queue: unknown[] = [];
  private flushing = false;

  async connect(retries = 20): Promise<boolean> {
    for (let i = 0; i < retries; i++) {
      const instance = await readInstanceInfo();
      if (instance) {
        // instance.url is .../mcp; ingest shares the origin.
        this.baseUrl = instance.url.replace(/\/mcp$/, '');
        this.token = instance.token;
        return true;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  send(event: unknown): void {
    this.queue.push(event);
    void this.flush();
  }

  private async flush(): Promise<void> {
    if (this.flushing || !this.baseUrl || this.queue.length === 0) return;
    this.flushing = true;
    const batch = this.queue.splice(0, this.queue.length);
    try {
      await fetch(`${this.baseUrl}/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
        body: JSON.stringify({ events: batch }),
      });
    } catch {
      // Instance not up / transient — drop (Tier 2 is best-effort telemetry,
      // never blocks the wrapped process).
    } finally {
      this.flushing = false;
      if (this.queue.length > 0) void this.flush();
    }
  }
}
