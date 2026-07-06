import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import { AgentBatchSchema, type AgentBatch } from '@localcoast/protocol-types';
import { getIsolatedWorldSource } from '../dist/index.js';

/**
 * Isolated-world inspect-mode tests in real Chromium. The script runs in the
 * page main world here (Playwright init script) — its behavior only depends on
 * shared-DOM APIs, so that's equivalent; world separation itself is exercised
 * by the desktop smoke suite. Every batch passes AgentBatchSchema — the same
 * untrusted-input gate the host applies (invariant 6).
 */

let browser: Browser;
let page: Page;
let batches: AgentBatch[];

type InspectState = { active: boolean; sticky: boolean; label: string; seq: number };

function messages(kind: string) {
  return batches.flatMap((b) => b.messages).filter((m) => m.kind === kind);
}

function inspectState(): Promise<InspectState> {
  return page.evaluate(
    () => (window as unknown as { __lcInspect: { _state(): InspectState } }).__lcInspect._state(),
  );
}

async function settle(ms = 250) {
  await page.waitForTimeout(ms);
}

beforeAll(async () => {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage();
  batches = [];
  await page.exposeFunction('__LC_ISOLATED_SEND__', (payload: string) => {
    batches.push(AgentBatchSchema.parse(JSON.parse(payload)));
  });
  await page.addInitScript(getIsolatedWorldSource('__LC_TEST_ISO_BINDING__'));
  await page.route('http://iso.localtest/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<html><body>
        <h1 id="title" data-testid="title" style="margin:40px">isolated test</h1>
        <button id="buy" style="display:block;margin:40px;padding:20px">buy</button>
        <script>
          window.__clicked = false;
          document.getElementById('buy').addEventListener('click', () => { window.__clicked = true; });
        </script>
      </body></html>`,
    }),
  );
  await page.goto('http://iso.localtest/');
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

describe('overlay scaffold', () => {
  it('mounts the closed-shadow overlay host tagged data-localcoast', async () => {
    const tag = await page.evaluate(() => {
      const host = document.querySelector('[data-localcoast="overlay-host"]');
      return host ? { present: true, shadow: host.shadowRoot } : { present: false, shadow: null };
    });
    expect(tag.present).toBe(true);
    expect(tag.shadow).toBeNull(); // closed root — invisible to the page
  });
});

describe('Alt-hold inspect mode', () => {
  it('activates on Alt, streams component.hover on element change only', async () => {
    batches = [];
    const title = await page.locator('#title').boundingBox();
    const buy = await page.locator('#buy').boundingBox();
    expect(title && buy).toBeTruthy();

    await page.keyboard.down('Alt');
    await page.mouse.move(title!.x + 5, title!.y + 5);
    await settle();

    expect((await inspectState()).active).toBe(true);
    const cursor = await page.evaluate(
      () => document.querySelector('style[data-localcoast="inspect-cursor"]') !== null,
    );
    expect(cursor).toBe(true);

    const first = messages('component.hover') as Array<{ seq: number }>;
    expect(first.length).toBe(1);

    // Same element — redraw only, no new hover message.
    await page.mouse.move(title!.x + 8, title!.y + 8);
    await settle();
    expect(messages('component.hover').length).toBe(1);

    // Different element — seq increments.
    await page.mouse.move(buy!.x + 10, buy!.y + 10);
    await settle();
    const hovers = messages('component.hover') as Array<{ seq: number }>;
    expect(hovers.length).toBe(2);
    expect(hovers[1]!.seq).toBeGreaterThan(hovers[0]!.seq);
  });

  it('Alt-click sends component.pick with a selectorPath and suppresses the app click', async () => {
    batches = [];
    const buy = await page.locator('#buy').boundingBox();
    await page.mouse.click(buy!.x + 10, buy!.y + 10);
    await settle();

    const picks = messages('component.pick') as Array<{ selectorPath?: string }>;
    expect(picks.length).toBe(1);
    expect(picks[0]!.selectorPath).toContain('button#buy');
    expect(await page.evaluate(() => (window as unknown as { __clicked: boolean }).__clicked)).toBe(
      false,
    );
  });

  it('deactivates on Alt release and removes the cursor override', async () => {
    await page.keyboard.up('Alt');
    await settle();
    expect((await inspectState()).active).toBe(false);
    const cursor = await page.evaluate(
      () => document.querySelector('style[data-localcoast="inspect-cursor"]') !== null,
    );
    expect(cursor).toBe(false);
  });
});

describe('host push hook (__lcInspect)', () => {
  it('setLabel applies for the current seq and drops stale resolutions', async () => {
    const buy = await page.locator('#buy').boundingBox();
    await page.keyboard.down('Alt');
    await page.mouse.move(buy!.x + 12, buy!.y + 12);
    await settle();
    const { seq } = await inspectState();

    await page.evaluate(
      (s) =>
        (
          window as unknown as { __lcInspect: { setLabel: (p: unknown) => void } }
        ).__lcInspect.setLabel({ seq: s - 1, name: 'Stale', path: 'stale.tsx' }),
      seq,
    );
    expect((await inspectState()).label).not.toContain('Stale');

    await page.evaluate(
      (s) =>
        (
          window as unknown as { __lcInspect: { setLabel: (p: unknown) => void } }
        ).__lcInspect.setLabel({ seq: s, name: 'BuyButton', path: 'src/Buy.tsx', line: 12, copied: true }),
      seq,
    );
    expect((await inspectState()).label).toBe('Copied ✓ BuyButton · src/Buy.tsx:12');
    await page.keyboard.up('Alt');
  });

  it('sticky mode works without Alt and Esc syncs component.mode back', async () => {
    batches = [];
    await page.evaluate(
      () =>
        (window as unknown as { __lcInspect: { setMode: (on: boolean) => void } }).__lcInspect.setMode(
          true,
        ),
    );
    const title = await page.locator('#title').boundingBox();
    await page.mouse.move(title!.x + 6, title!.y + 6);
    await settle();
    const st = await inspectState();
    expect(st.sticky).toBe(true);
    expect(st.active).toBe(true);
    expect(messages('component.hover').length).toBeGreaterThan(0);

    await page.keyboard.press('Escape');
    await settle();
    const modes = messages('component.mode') as Array<{ enabled: boolean }>;
    expect(modes).toContainEqual(expect.objectContaining({ enabled: false }));
    const after = await inspectState();
    expect(after.sticky).toBe(false);
    expect(after.active).toBe(false);
  });
});
