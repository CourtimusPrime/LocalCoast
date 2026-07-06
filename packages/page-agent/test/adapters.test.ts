import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright-core';
import { AgentBatchSchema, type AgentBatch } from '@localcoast/protocol-types';
import { getMainWorldSource } from '../dist/index.js';

/**
 * Framework adapter tests against REAL React 19 (dev build) rendered in real
 * Chromium: hook shim → commit events, fiber tree walk, component-at-point,
 * and the Redux-DevTools shim's action stream + JUMP_TO_STATE time travel.
 */

let browser: Browser;
let page: Page;
let batches: AgentBatch[] = [];

function messages(kind: string) {
  return batches.flatMap((b) => b.messages).filter((m) => m.kind === kind);
}

beforeAll(async () => {
  const appBundle = await build({
    entryPoints: [new URL('./fixtures/react-app.tsx', import.meta.url).pathname],
    bundle: true,
    write: false,
    format: 'iife',
    // Dev-mode React: registers with the devtools hook + keeps component names.
    define: { 'process.env.NODE_ENV': '"development"' },
    jsx: 'automatic',
  });
  const appJs = appBundle.outputFiles[0]!.text;

  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage();
  await page.exposeFunction('__LC_SEND__', (payload: string) => {
    batches.push(AgentBatchSchema.parse(JSON.parse(payload)));
  });
  await page.addInitScript(getMainWorldSource('__LC_TEST_BINDING__'));
  await page.route('http://adapter.localtest/**', (route) => {
    if (route.request().url().endsWith('app.js')) {
      return route.fulfill({ contentType: 'application/javascript', body: appJs });
    }
    return route.fulfill({
      contentType: 'text/html',
      body: '<html><body><script src="app.js"></script></body></html>',
    });
  });
  await page.goto('http://adapter.localtest/');
  await page.waitForSelector('[data-testid="badge"]');
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

describe('react adapter (real React 19)', () => {
  it('detects react via hook shim inject', async () => {
    await page.waitForTimeout(300);
    const detected = messages('framework.detected') as Array<{ framework: string; devBuild?: boolean }>;
    expect(detected.some((d) => d.framework === 'react')).toBe(true);
  });

  it('emits coalesced state.commit events on re-render', async () => {
    batches = [];
    await page.click('[data-testid="add"]');
    await page.waitForTimeout(300);
    const commits = messages('state.commit') as Array<{ framework: string; count: number }>;
    expect(commits.length).toBeGreaterThan(0);
    expect(commits[0]!.framework).toBe('react');
  });

  it('walks the fiber tree with component names', async () => {
    const tree = await page.evaluate(() =>
      (window as unknown as {
        __localcoastComponents: { getTree: (d: number, n: number) => { framework: string; tree: unknown } | null };
      }).__localcoastComponents.getTree(10, 100),
    );
    expect(tree?.framework).toBe('react');
    const json = JSON.stringify(tree);
    expect(json).toContain('"App"');
    expect(json).toContain('"CartBadge"');
  });

  it('resolves the component at a point', async () => {
    const badge = page.locator('[data-testid="badge"]');
    const box = (await badge.boundingBox())!;
    const hit = await page.evaluate(
      ([x, y]) =>
        (window as unknown as {
          __localcoastComponents: { at: (x: number, y: number) => { framework: string; componentName?: string; hasFn: boolean } | null };
        }).__localcoastComponents.at(x!, y!),
      [box.x + 2, box.y + 2],
    );
    expect(hit?.framework).toBe('react');
    expect(hit?.componentName).toBe('CartBadge');
    expect(hit?.hasFn).toBe(true);
  });
});

describe('redux devtools shim (L3)', () => {
  it('records the action stream and supports JUMP_TO_STATE time travel', async () => {
    batches = [];
    const result = await page.evaluate(() => {
      const ext = (window as unknown as {
        __REDUX_DEVTOOLS_EXTENSION__: {
          connect: (o: { name: string }) => {
            init: (s: unknown) => void;
            send: (a: unknown, s: unknown) => void;
            subscribe: (cb: (msg: unknown) => void) => () => void;
          };
        };
      }).__REDUX_DEVTOOLS_EXTENSION__;

      // Simulate a store lib wired for the extension (zustand-style).
      let state = { cart: 0 };
      const conn = ext.connect({ name: 'cart-store' });
      const received: unknown[] = [];
      conn.subscribe((msg) => {
        const m = msg as { type: string; state?: string };
        received.push(m);
        if (m.type === 'DISPATCH' && m.state) state = JSON.parse(m.state);
      });
      conn.init(state);
      state = { cart: 1 };
      conn.send({ type: 'cart/add' }, state);
      state = { cart: 2 };
      conn.send({ type: 'cart/add' }, state);

      const stores = (window as unknown as {
        __localcoastStores: {
          list: () => Array<{ storeId: string; name: string; actionCount: number; historyLength: number }>;
          jump: (id: string, index: number) => boolean;
        };
      }).__localcoastStores;
      const list = stores.list();
      const jumped = stores.jump(list[0]!.storeId, 1); // back to cart:1
      return { list, jumped, stateAfterJump: state, receivedCount: received.length };
    });

    expect(result.list).toHaveLength(1);
    expect(result.list[0]!.name).toBe('cart-store');
    expect(result.list[0]!.actionCount).toBe(3); // @@INIT + 2 actions
    expect(result.jumped).toBe(true);
    expect(result.stateAfterJump).toEqual({ cart: 1 }); // time travel applied
    await page.waitForTimeout(300);
    const actions = messages('state.action') as Array<{ actionType: string; storeId: string }>;
    expect(actions.map((a) => a.actionType)).toEqual(['@@INIT', 'cart/add', 'cart/add']);
  });
});
