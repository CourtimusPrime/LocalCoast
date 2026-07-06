import { IngestClient } from './ingest-client.js';

/**
 * `@localcoast/reporter` (AD-8 Tier 1): a one-line opt-in reporter for
 * Vitest/Jest/Playwright. Emits test.run / test.result events to the live
 * instance so the Test Runner Integration panel and the MCP surface see pass/
 * fail without terminal parsing. Duck-typed to the common reporter shape so a
 * single class serves all three.
 */
export class LocalCoastReporter {
  private ingest = new IngestClient();
  private runner: 'vitest' | 'jest' | 'playwright';
  private total = 0;
  private passed = 0;
  private failed = 0;

  constructor(runner: 'vitest' | 'jest' | 'playwright' = 'vitest') {
    this.runner = runner;
    void this.ingest.connect(4);
  }

  onRunStart(): void {
    this.total = this.passed = this.failed = 0;
    this.ingest.send({ type: 'test.run', actor: 'app', payload: { runner: this.runner, status: 'started' } });
  }

  /** Vitest: onTaskUpdate; Jest: onTestResult; Playwright: onTestEnd. */
  reportResult(result: { name: string; file?: string; status: 'passed' | 'failed' | 'skipped'; durationMs?: number; error?: string }): void {
    this.total++;
    if (result.status === 'passed') this.passed++;
    else if (result.status === 'failed') this.failed++;
    this.ingest.send({ type: 'test.result', actor: 'app', payload: result });
  }

  onRunComplete(): void {
    this.ingest.send({
      type: 'test.run',
      actor: 'app',
      payload: { runner: this.runner, status: 'finished', total: this.total, passed: this.passed, failed: this.failed },
    });
  }

  // -- Vitest Reporter interface adapters --
  onFinished(files: Array<{ name: string; tasks?: Array<{ name: string; result?: { state?: string; duration?: number; errors?: Array<{ message: string }> } }> }> = []): void {
    for (const file of files) {
      for (const task of file.tasks ?? []) {
        const state = task.result?.state;
        this.reportResult({
          name: task.name,
          file: file.name,
          status: state === 'pass' ? 'passed' : state === 'fail' ? 'failed' : 'skipped',
          durationMs: task.result?.duration,
          error: task.result?.errors?.[0]?.message,
        });
      }
    }
    this.onRunComplete();
  }
}
