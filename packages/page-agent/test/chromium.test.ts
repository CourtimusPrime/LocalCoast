import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import { AgentBatchSchema, type AgentBatch } from '@localcoast/protocol-types';
import { getMainWorldSource } from '../dist/index.js';

/**
 * Agent behavior tests in real Chromium (headless system Chrome — no Electron,
 * per testing conventions). The playwright exposeFunction shim stands in for
 * the CDP binding; the CDP transport itself is exercised by the desktop smoke
 * suite. Every batch is validated with AgentBatchSchema — the same untrusted-
 * input gate the host applies (invariant 6).
 */

let browser: Browser;
let page: Page;
let batches: AgentBatch[];

function messages(kind: string) {
  return batches.flatMap((b) => b.messages).filter((m) => m.kind === kind);
}

async function settle(ms = 300) {
  await page.waitForTimeout(ms);
}

beforeAll(async () => {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage();
  batches = [];
  await page.exposeFunction('__LC_SEND__', (payload: string) => {
    batches.push(AgentBatchSchema.parse(JSON.parse(payload)));
  });
  await page.addInitScript(getMainWorldSource('__LC_TEST_BINDING__'));
  // Real http origin — storage APIs throw on opaque (data:) origins.
  await page.route('http://agent.localtest/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><body><h1 data-testid="title">agent test</h1></body></html>',
    }),
  );
  await page.goto('http://agent.localtest/');
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

describe('storage trail', () => {
  it('logs writes with key, size, preview, and a trimmed stack', async () => {
    await page.evaluate(() => {
      localStorage.setItem('auth.token', 'secret-value-123');
      localStorage.getItem('auth.token');
      localStorage.removeItem('auth.token');
      localStorage.clear();
    });
    await settle();

    const ops = messages('storage.op') as Array<{
      op: string;
      key?: string;
      area: string;
      valueSize?: number;
      valuePreview?: string;
      stack?: unknown[];
    }>;
    const write = ops.find((o) => o.op === 'write' && o.key === 'auth.token');
    expect(write).toBeDefined();
    expect(write!.area).toBe('localStorage');
    expect(write!.valueSize).toBe('secret-value-123'.length);
    expect(write!.valuePreview).toBe('secret-value-123');
    expect(write!.stack?.length).toBeGreaterThan(0);
    expect(ops.some((o) => o.op === 'read' && o.key === 'auth.token')).toBe(true);
    expect(ops.some((o) => o.op === 'remove')).toBe(true);
    expect(ops.some((o) => o.op === 'clear')).toBe(true);
  });

  it('logs cookie reads/writes through the accessor wrap', async () => {
    batches = [];
    await page.evaluate(() => {
      document.cookie = 'session=abc123; path=/';
      void document.cookie;
    });
    await settle();
    const ops = messages('storage.op') as Array<{ area: string; op: string; key?: string }>;
    expect(ops.some((o) => o.area === 'cookie' && o.op === 'write' && o.key === 'session')).toBe(true);
    expect(ops.some((o) => o.area === 'cookie' && o.op === 'read')).toBe(true);
  });
});

describe('route trail', () => {
  it('captures pushState/replaceState/popstate', async () => {
    batches = [];
    await page.evaluate(() => {
      history.pushState({}, '', '#/cart');
      history.replaceState({}, '', '#/cart?promo=1');
    });
    await page.goBack();
    await settle();
    const routes = messages('state.route') as Array<{ routeKind: string; to: string }>;
    expect(routes.some((r) => r.routeKind === 'push' && r.to.includes('#/cart'))).toBe(true);
    expect(routes.some((r) => r.routeKind === 'replace' && r.to.includes('promo=1'))).toBe(true);
    expect(routes.some((r) => r.routeKind === 'pop')).toBe(true);
  });
});

describe('websocket registry', () => {
  it('reports socket creation and keeps a send-into-socket registry', async () => {
    batches = [];
    const registered = await page.evaluate(() => {
      new WebSocket('ws://127.0.0.1:1/nowhere');
      const sockets = (window as unknown as { __localcoastSockets: Map<number, WebSocket> })
        .__localcoastSockets;
      return sockets.size;
    });
    expect(registered).toBe(1);
    await settle();
    const ws = messages('ws') as Array<{ phase: string; url?: string }>;
    expect(ws.some((w) => w.phase === 'created' && w.url?.includes('nowhere'))).toBe(true);
  });
});

describe('framework detection', () => {
  it('detects a React renderer injecting into the hook shim', async () => {
    batches = [];
    await page.evaluate(() => {
      const hook = (window as unknown as Record<string, { inject: (r: unknown) => number }>)
        .__REACT_DEVTOOLS_GLOBAL_HOOK__;
      hook.inject({ version: '19.1.0', bundleType: 1 });
    });
    await settle();
    const detected = messages('framework.detected') as Array<{ framework: string; version?: string; devBuild?: boolean }>;
    expect(detected).toContainEqual(
      expect.objectContaining({ framework: 'react', version: '19.1.0', devBuild: true }),
    );
  });
});

describe('patch hygiene (invariant 6)', () => {
  it('patched functions keep name/length and spoof toString', async () => {
    const probe = await page.evaluate(() => ({
      setItemName: Storage.prototype.setItem.name,
      setItemLength: Storage.prototype.setItem.length,
      setItemSource: Storage.prototype.setItem.toString(),
      pushStateSource: history.pushState.toString(),
      wsName: window.WebSocket.name,
    }));
    expect(probe.setItemName).toBe('setItem');
    expect(probe.setItemLength).toBe(2);
    expect(probe.setItemSource).toContain('[native code]');
    expect(probe.pushStateSource).toContain('[native code]');
    expect(probe.wsName).toBe('WebSocket');
  });

  it('does not leave the binding reachable on window', async () => {
    const leaked = await page.evaluate(() => '__LC_TEST_BINDING__' in window);
    expect(leaked).toBe(false);
  });
});
