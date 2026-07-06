import { randomBytes } from 'node:crypto';
import { CapabilityFault, type Core } from '@localcoast/core';
import {
  SnapshotCaptureInput,
  SnapshotCaptureOutput,
  SnapshotDocumentSchema,
  SnapshotRestoreInput,
  SnapshotRestoreOutput,
  type RestoreReport,
  type SnapshotDocument,
} from '@localcoast/protocol-types';
import type { TabManager } from './tabs.js';

/**
 * Snapshot engine (infra #5, AD-3). Capture: URL + storage + cookies (incl.
 * HttpOnly via CDP) + L3 store states + forms + scroll. Restore order per
 * AD-3: cookies → navigate → hydrate storage → reload (app boots against the
 * snapshot's storage) → stores → forms → scroll, with a per-item report —
 * L4 refs/closures/effects are never restored and never pretended to be.
 */

const CAPTURE_FORMS_AND_SCROLL = `JSON.stringify((() => {
  const forms = [];
  let unnamed = 0;
  for (const el of document.querySelectorAll('input, textarea, select')) {
    if (el.closest('[data-localcoast]')) continue;
    let selector = null;
    if (el.dataset.testid) selector = '[data-testid=' + JSON.stringify(el.dataset.testid) + ']';
    else if (el.id) selector = '#' + CSS.escape(el.id);
    else if (el.name) selector = el.tagName.toLowerCase() + '[name=' + JSON.stringify(el.name) + ']';
    else { unnamed++; continue; }
    forms.push({
      selector,
      value: el.type === 'checkbox' || el.type === 'radio' ? '' : String(el.value ?? ''),
      checked: el.type === 'checkbox' || el.type === 'radio' ? el.checked : undefined,
    });
  }
  return {
    forms,
    scroll: { x: window.scrollX, y: window.scrollY },
    stores: window.__localcoastStores
      ? window.__localcoastStores.list().map((s) => ({
          storeId: s.name,
          state: window.__localcoastStores.getState(s.storeId),
        }))
      : [],
  };
})())`;

export function registerSnapshotCapabilities(core: Core, tabs: TabManager): void {
  const requireTab = (sessionId: string) => {
    const tab = tabs.get(sessionId);
    if (!tab) throw new CapabilityFault('target_gone', `no open tab ${sessionId}`);
    return tab;
  };

  core.registry.registerCommand({
    name: 'snapshot.capture',
    description:
      'Capture a named app-state snapshot: URL + params, local/sessionStorage, cookies (incl. HttpOnly), connected store states (L3 — the reliable tier), form inputs, and scroll. Named snapshots persist across restarts and anchor to the event timeline.',
    input: SnapshotCaptureInput,
    output: SnapshotCaptureOutput,
    surfaces: { palette: true },
    paletteTitle: 'Capture app-state snapshot',
    handler: async (input) => {
      const tab = requireTab(input.sessionId);
      const storageState = (await core.query('storage.state', { sessionId: input.sessionId }, { actor: 'system' })) as {
        localStorage: Array<{ key: string; value: string }>;
        sessionStorage: Array<{ key: string; value: string }>;
        cookies: SnapshotDocument['cookies'];
      };
      const pageResult = (await tab.cdp.send(null, 'Runtime.evaluate', {
        expression: CAPTURE_FORMS_AND_SCROLL,
        returnByValue: true,
      })) as { result?: { value?: string } };
      const page = JSON.parse(pageResult.result?.value ?? '{"forms":[],"scroll":{"x":0,"y":0},"stores":[]}') as {
        forms: SnapshotDocument['forms'];
        scroll: { x: number; y: number };
        stores: SnapshotDocument['stores'];
      };

      const snapshotId = `snap-${randomBytes(8).toString('hex')}`;
      const document: SnapshotDocument = SnapshotDocumentSchema.parse({
        version: 1,
        kind: 'snapshot',
        snapshotId,
        name: input.name,
        createdAtWall: Date.now(),
        pinned: input.pin,
        url: tab.view.webContents.getURL(),
        storage: {
          localStorage: Object.fromEntries(storageState.localStorage.map((e) => [e.key, e.value])),
          sessionStorage: Object.fromEntries(storageState.sessionStorage.map((e) => [e.key, e.value])),
        },
        cookies: storageState.cookies,
        stores: page.stores,
        forms: page.forms,
        scroll: page.scroll,
      });
      await core.store.saveSnapshot({
        snapshotId,
        sessionId: input.sessionId,
        name: input.name,
        pinned: input.pin,
        document,
      });
      const kinds = ['url', 'storage', 'cookies', 'forms', 'scroll'];
      if (page.stores.length > 0) kinds.push('stores');
      core.store.appendNow({
        sessionId: input.sessionId,
        actor: 'system',
        type: 'snapshot.captured',
        payload: { snapshotId, name: input.name, kinds },
      });
      return { snapshotId, kinds };
    },
  });

  core.registry.registerCommand({
    name: 'snapshot.restore',
    description:
      'Restore an app-state snapshot into a live tab. Order: cookies → navigate → hydrate storage → reload (app boots against snapshot storage) → store states by name → forms → scroll. Returns a per-item report (restored / skipped:unmatched / skipped:unserializable) — refs, closures, and effects are never restored.',
    input: SnapshotRestoreInput,
    output: SnapshotRestoreOutput,
    surfaces: { palette: true },
    paletteTitle: 'Restore snapshot…',
    handler: async (input) => {
      const raw = await core.store.getSnapshot(input.snapshotId);
      if (!raw) throw new CapabilityFault('not_found', `no snapshot ${input.snapshotId}`);
      const doc = SnapshotDocumentSchema.parse(raw);

      // The restoring tab: any open tab on the snapshot URL's port, else the active tab.
      const port = Number(new URL(doc.url).port || 80);
      const tab =
        tabs.list().find((t) => t.port === port) ??
        tabs.activeTab() ??
        (() => {
          throw new CapabilityFault('target_gone', 'no open tab to restore into');
        })();

      const items: RestoreReport['items'] = [];

      for (const cookie of doc.cookies) {
        try {
          await tab.cdp.send(null, 'Network.setCookie', { url: doc.url, ...cookie });
          items.push({ path: `cookie:${cookie.name}`, status: 'restored' });
        } catch {
          items.push({ path: `cookie:${cookie.name}`, status: 'skipped:unserializable' });
        }
      }

      await tab.view.webContents.loadURL(doc.url);
      const hydrate = `(() => {
        localStorage.clear(); sessionStorage.clear();
        for (const [k, v] of Object.entries(${JSON.stringify(doc.storage.localStorage)})) localStorage.setItem(k, v);
        for (const [k, v] of Object.entries(${JSON.stringify(doc.storage.sessionStorage)})) sessionStorage.setItem(k, v);
      })()`;
      await tab.cdp.send(null, 'Runtime.evaluate', { expression: hydrate });
      items.push({ path: 'storage:localStorage', status: 'restored' });
      items.push({ path: 'storage:sessionStorage', status: 'restored' });

      // Reload so the app BOOTS against the hydrated storage (epoch bumps —
      // it is a true refresh), then wait for load.
      await tabs.reload(tab.sessionId);
      await new Promise<void>((resolve) => {
        const wc = tab.view.webContents;
        const done = () => {
          wc.removeListener('did-finish-load', done);
          resolve();
        };
        wc.on('did-finish-load', done);
        setTimeout(done, 8000);
      });
      // Give store connections a beat to re-register.
      await new Promise((r) => setTimeout(r, 300));

      for (const store of doc.stores) {
        try {
          const result = (await tab.cdp.send(null, 'Runtime.evaluate', {
            expression: `JSON.stringify(window.__localcoastStores ? window.__localcoastStores.restoreByName(${JSON.stringify(store.storeId)}, ${JSON.stringify(JSON.stringify(store.state))}) : false)`,
            returnByValue: true,
          })) as { result?: { value?: string } };
          items.push({
            path: `store:${store.storeId}`,
            status: result.result?.value === 'true' ? 'restored' : 'skipped:unmatched',
          });
        } catch {
          items.push({ path: `store:${store.storeId}`, status: 'skipped:unserializable' });
        }
      }

      const formResult = (await tab.cdp.send(null, 'Runtime.evaluate', {
        expression: `JSON.stringify((${JSON.stringify(doc.forms)}).map((f) => {
          const el = document.querySelector(f.selector);
          if (!el) return { selector: f.selector, ok: false };
          if (f.checked !== undefined) el.checked = f.checked; else el.value = f.value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { selector: f.selector, ok: true };
        }))`,
        returnByValue: true,
      })) as { result?: { value?: string } };
      for (const f of JSON.parse(formResult.result?.value ?? '[]') as Array<{ selector: string; ok: boolean }>) {
        items.push({ path: `form:${f.selector}`, status: f.ok ? 'restored' : 'skipped:unmatched' });
      }

      if (doc.scroll) {
        await tab.cdp.send(null, 'Runtime.evaluate', {
          expression: `window.scrollTo(${doc.scroll.x}, ${doc.scroll.y})`,
        });
        items.push({ path: 'scroll', status: 'restored' });
      }

      const report = { items };
      core.store.appendNow({
        sessionId: tab.sessionId,
        actor: 'system',
        type: 'snapshot.restored',
        payload: { snapshotId: input.snapshotId, report },
      });
      return { report };
    },
  });
}
