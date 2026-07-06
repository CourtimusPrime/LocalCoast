import { z } from 'zod';
import { CapabilityFault, type Core } from '@localcoast/core';
import {
  ActNavigateInput,
  ActNavigateOutput,
  ActScreenshotInput,
  ActScreenshotOutput,
  StorageStateInput,
  StorageStateOutput,
  TargetPreviewInput,
  TargetPreviewOutput,
} from '@localcoast/protocol-types';
import type { PreviewCapturer } from './preview.js';
import type { TabManager } from './tabs.js';

/**
 * In-page accessibility audit (spec: Accessibility Audit Panel). Serialized and
 * evaluated via Runtime.evaluate — a small, dependency-free rule set covering
 * the highest-frequency WCAG failures. Overlay nodes (data-localcoast) are
 * skipped so we never flag ourselves.
 */
const A11Y_AUDIT_FN = `() => {
  const violations = [];
  let passes = 0;
  const sel = (el) => {
    if (el.id) return '#' + el.id;
    const testid = el.getAttribute && el.getAttribute('data-testid');
    if (testid) return '[data-testid="' + testid + '"]';
    const tag = el.tagName ? el.tagName.toLowerCase() : 'node';
    const parent = el.parentElement;
    if (!parent) return tag;
    const idx = [...parent.children].filter((c) => c.tagName === el.tagName).indexOf(el) + 1;
    return tag + ':nth-of-type(' + idx + ')';
  };
  const skip = (el) => el.closest && el.closest('[data-localcoast]');
  for (const img of document.querySelectorAll('img')) {
    if (skip(img)) continue;
    if (!img.hasAttribute('alt')) violations.push({ rule: 'image-alt', impact: 'critical', selector: sel(img), description: 'Image has no alt attribute', wcag: 'WCAG 1.1.1' });
    else passes++;
  }
  for (const el of document.querySelectorAll('button, a[href]')) {
    if (skip(el)) continue;
    const name = (el.textContent || '').trim() || el.getAttribute('aria-label') || el.getAttribute('title');
    if (!name) violations.push({ rule: 'control-name', impact: 'serious', selector: sel(el), description: el.tagName.toLowerCase() + ' has no accessible name', wcag: 'WCAG 4.1.2' });
    else passes++;
  }
  for (const input of document.querySelectorAll('input:not([type=hidden]), select, textarea')) {
    if (skip(input)) continue;
    const id = input.id;
    const labelled = (id && document.querySelector('label[for="' + id + '"]')) || input.getAttribute('aria-label') || input.closest('label');
    if (!labelled) violations.push({ rule: 'label', impact: 'serious', selector: sel(input), description: 'Form control has no associated label', wcag: 'WCAG 3.3.2' });
    else passes++;
  }
  for (const h of document.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
    if (skip(h)) continue;
    if (!(h.textContent || '').trim()) violations.push({ rule: 'empty-heading', impact: 'moderate', selector: sel(h), description: 'Heading is empty', wcag: 'WCAG 1.3.1' });
    else passes++;
  }
  if (!document.documentElement.getAttribute('lang')) {
    violations.push({ rule: 'html-lang', impact: 'serious', selector: 'html', description: 'Document has no lang attribute', wcag: 'WCAG 3.1.1' });
  } else passes++;
  return JSON.stringify({ violations: violations.slice(0, 200), passes });
}`;

/**
 * Shell-dependent capabilities. Registered by the desktop host before the MCP
 * server starts, so the generated tool surface includes them automatically —
 * definition of done stays: registry entry → generated tool → palette → panel.
 */
export function registerShellCapabilities(
  core: Core,
  tabs: TabManager,
  preview: PreviewCapturer,
): void {
  core.registry.registerCommand({
    name: 'targets.open',
    description:
      'Open a discovered localhost server in a new LocalCoast tab (attaching CDP capture) and return its session id. Idempotent: focuses the existing tab if the port is already open.',
    input: z.object({ port: z.number().int().min(1).max(65535) }),
    output: z.object({ sessionId: z.string(), targetKey: z.string() }),
    surfaces: { palette: true },
    paletteTitle: 'Open server in new tab',
    handler: async (input) => {
      const tab = await tabs.open(input.port);
      return { sessionId: tab.sessionId, targetKey: tab.targetKey };
    },
  });

  core.registry.registerCommand({
    name: 'targets.close',
    description: 'Close an open guest tab by session id and end its capture session.',
    input: z.object({ sessionId: z.string() }),
    output: z.object({ ok: z.boolean() }),
    surfaces: { palette: true },
    paletteTitle: 'Close current tab',
    handler: async (input) => {
      await tabs.close(input.sessionId);
      return { ok: true };
    },
  });

  core.registry.registerCommand({
    name: 'targets.reload',
    description:
      'Reload a guest tab. This is the explicit-refresh that advances the epoch: Network/Console panel default views reset (as a filter — history is preserved and remains queryable across epochs).',
    input: z.object({ sessionId: z.string() }),
    output: z.object({ ok: z.boolean(), epoch: z.number().int() }),
    surfaces: { palette: true },
    paletteTitle: 'Reload tab (new epoch)',
    handler: async (input) => {
      await tabs.reload(input.sessionId);
      return { ok: true, epoch: core.store.currentEpoch(input.sessionId) };
    },
  });

  core.registry.registerCommand({
    name: 'act.navigate',
    description: 'Navigate a guest tab to a URL and wait for the load to commit.',
    input: ActNavigateInput,
    output: ActNavigateOutput,
    surfaces: { palette: true },
    paletteTitle: 'Navigate active tab…',
    handler: async (input) => {
      const tab = tabs.get(input.sessionId);
      if (!tab) throw new CapabilityFault('target_gone', `no open tab ${input.sessionId}`);
      await tab.view.webContents.loadURL(input.url);
      return { ok: true, finalUrl: tab.view.webContents.getURL() };
    },
  });

  core.registry.registerQuery({
    name: 'storage.state',
    description:
      'Live storage state of a guest tab: all localStorage/sessionStorage entries plus cookies (including HttpOnly, via CDP). Entries carry first-set/last-write timestamps derived from the usage trail.',
    input: StorageStateInput,
    output: StorageStateOutput,
    handler: async (input) => {
      const tab = tabs.get(input.sessionId);
      if (!tab) throw new CapabilityFault('target_gone', `no open tab ${input.sessionId}`);

      const evaluated = (await tab.cdp.send(null, 'Runtime.evaluate', {
        expression: `JSON.stringify({
          localStorage: Object.entries({...localStorage}),
          sessionStorage: Object.entries({...sessionStorage}),
        })`,
        returnByValue: true,
      })) as { result?: { value?: string } };
      const raw = JSON.parse(evaluated.result?.value ?? '{"localStorage":[],"sessionStorage":[]}') as {
        localStorage: Array<[string, string]>;
        sessionStorage: Array<[string, string]>;
      };

      // First-set / last-write timestamps come from the usage trail.
      const trail = await core.store.query({
        sessionId: input.sessionId,
        types: ['storage.op'],
        limit: 4000,
      });
      const firstSet = new Map<string, number>();
      const lastWrite = new Map<string, number>();
      for (const evt of trail) {
        if (evt.type !== 'storage.op' || evt.payload.op !== 'write' || !evt.payload.key) continue;
        const mapKey = `${evt.payload.area}:${evt.payload.key}`;
        if (!firstSet.has(mapKey)) firstSet.set(mapKey, evt.tsMono);
        lastWrite.set(mapKey, evt.tsMono);
      }
      const entries = (area: string, pairs: Array<[string, string]>) =>
        pairs.map(([key, value]) => ({
          key,
          value,
          size: value.length,
          firstSetTsMono: firstSet.get(`${area}:${key}`),
          lastWriteTsMono: lastWrite.get(`${area}:${key}`),
        }));

      const cookieResult = (await tab.cdp.send(null, 'Network.getCookies', {})) as {
        cookies?: Array<{
          name: string;
          value: string;
          domain?: string;
          path?: string;
          expires?: number;
          httpOnly?: boolean;
          secure?: boolean;
          sameSite?: string;
        }>;
      };

      return {
        localStorage: entries('localStorage', raw.localStorage),
        sessionStorage: entries('sessionStorage', raw.sessionStorage),
        cookies: (cookieResult.cookies ?? []).map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          expires: c.expires === -1 ? undefined : c.expires,
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: (['Strict', 'Lax', 'None'] as const).find((v) => v === c.sameSite),
        })),
      };
    },
  });

  core.registry.registerQuery({
    name: 'a11y.audit',
    description:
      'Accessibility audit of the current page: structural checks (images without alt, buttons/links without accessible names, inputs without labels, empty headings, missing document language) with the offending selector and WCAG reference. Re-run after edits to catch regressions.',
    input: z.object({ sessionId: z.string() }),
    output: z.object({
      violations: z.array(
        z.object({
          rule: z.string(),
          impact: z.enum(['minor', 'moderate', 'serious', 'critical']),
          selector: z.string(),
          description: z.string(),
          wcag: z.string(),
        }),
      ),
      passes: z.number().int(),
    }),
    handler: async (input) => {
      const tab = tabs.get(input.sessionId);
      if (!tab) throw new CapabilityFault('target_gone', `no open tab ${input.sessionId}`);
      // Rule engine runs in-page (isolated from the app; excludes our overlay).
      const result = (await tab.cdp.send(null, 'Runtime.evaluate', {
        expression: `(${A11Y_AUDIT_FN})()`,
        returnByValue: true,
      })) as { result?: { value?: string } };
      return JSON.parse(result.result?.value ?? '{"violations":[],"passes":0}') as {
        violations: Array<{ rule: string; impact: 'minor' | 'moderate' | 'serious' | 'critical'; selector: string; description: string; wcag: string }>;
        passes: number;
      };
    },
  });

  core.registry.registerCommand({
    name: 'view.breakpoint',
    description:
      'Responsive Breakpoint Tester: resize the active guest view to a named/custom viewport and optionally apply RTL (direction: rtl on the document) to surface right-to-left layout bugs. The active breakpoint is reflected in bug bundles.',
    input: z.object({
      sessionId: z.string(),
      width: z.number().int().positive(),
      height: z.number().int().positive().optional(),
      rtl: z.boolean().default(false),
    }),
    output: z.object({ ok: z.boolean() }),
    surfaces: { palette: true },
    paletteTitle: 'Set responsive breakpoint…',
    handler: async (input) => {
      const tab = tabs.get(input.sessionId);
      if (!tab) throw new CapabilityFault('target_gone', `no open tab ${input.sessionId}`);
      tabs.setGuestWidth(input.sessionId, input.width, input.height);
      await tab.cdp.send(null, 'Runtime.evaluate', {
        expression: `document.documentElement.setAttribute('dir', ${JSON.stringify(input.rtl ? 'rtl' : 'ltr')})`,
      });
      return { ok: true };
    },
  });

  core.registry.registerCommand({
    name: 'view.split',
    description:
      'Multi-Port Split View: lay two open guest tabs side by side in the window so a frontend and its API can be observed together. Their actions are timestamped on the shared session clock, making cross-service cause-and-effect visible.',
    input: z.object({ leftSessionId: z.string(), rightSessionId: z.string() }),
    output: z.object({ ok: z.boolean() }),
    surfaces: { palette: true },
    paletteTitle: 'Split view…',
    handler: async (input) => {
      if (!tabs.get(input.leftSessionId) || !tabs.get(input.rightSessionId)) {
        throw new CapabilityFault('target_gone', 'both sessions must be open tabs');
      }
      tabs.setSplit(input.leftSessionId, input.rightSessionId);
      return { ok: true };
    },
  });

  core.registry.registerCommand({
    name: 'view.unsplit',
    description: 'Exit split view and return to single-tab layout.',
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    surfaces: { palette: true },
    paletteTitle: 'Exit split view',
    handler: async () => {
      tabs.clearSplit();
      return { ok: true };
    },
  });

  core.registry.registerCommand({
    name: 'act.screenshot',
    description:
      'Capture a screenshot of a guest tab via CDP (works even when the tab is occluded). Returns base64 png/jpeg.',
    input: ActScreenshotInput,
    output: ActScreenshotOutput,
    surfaces: { palette: true },
    paletteTitle: 'Screenshot active tab',
    handler: async (input) => {
      const tab = tabs.get(input.sessionId);
      if (!tab) throw new CapabilityFault('target_gone', `no open tab ${input.sessionId}`);
      const result = (await tab.cdp.send(null, 'Page.captureScreenshot', {
        format: input.format,
        captureBeyondViewport: input.fullPage,
      })) as { data: string };
      const size = tab.view.getBounds();
      return {
        mimeType: `image/${input.format}`,
        base64: result.data,
        width: size.width,
        height: size.height,
      };
    },
  });

  core.registry.registerQuery({
    name: 'targets.preview',
    description:
      'Thumbnail screenshot of a discovered localhost server for the server-list card. Uses the live tab if one is attached, otherwise loads the page offscreen. Cached; returns { available:false, reason } when the server did not render.',
    input: TargetPreviewInput,
    output: TargetPreviewOutput,
    handler: (input) => preview.capture(input.port, input.maxAgeMs),
  });
}
