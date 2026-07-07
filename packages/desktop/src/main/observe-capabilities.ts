import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  CapabilityFault,
  evaluateAssertion,
  type Core,
  type FileSystemLike,
} from '@localcoast/core';
import {
  AssertRunInput,
  AssertRunOutput,
  AssertWaitForInput,
  AssertWaitForOutput,
  AssertionSuiteSchema,
  ScenarioSchema,
  SessionObserveInput,
  SessionObserveOutput,
  type Assertion,
} from '@localcoast/protocol-types';
import { z } from 'zod';
import type { TabManager } from './tabs.js';

/**
 * Agent-native surface (AD-7): the session.observe composite, the assertion
 * runner + wait_for, and scenario playback via CDP Input. observe assembles
 * a11y tree + component tree + in-flight requests + recent console/errors in
 * ONE call with size budgets — no screenshot parsing.
 */

interface CdpAxNode {
  nodeId: string;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: string };
  childIds?: string[];
  ignored?: boolean;
}

export function registerObserveCapabilities(
  core: Core,
  tabs: TabManager,
  projectRoot: (sessionId: string) => Promise<string | undefined>,
): void {
  const requireTab = (sessionId: string) => {
    const tab = tabs.get(sessionId);
    if (!tab) throw new CapabilityFault('target_gone', `no open tab ${sessionId}`);
    return tab;
  };

  async function observe(
    input: z.infer<typeof SessionObserveInput>,
  ): Promise<z.input<typeof SessionObserveOutput>> {
    const tab = requireTab(input.sessionId);
    const truncated: string[] = [];

    let a11y: unknown;
    if (input.include.a11y) {
      try {
        const result = (await tab.cdp.send(null, 'Accessibility.getFullAXTree', { max_depth: 30 })) as {
          nodes: CdpAxNode[];
        };
        a11y = buildAxTree(result.nodes);
      } catch {
        truncated.push('a11y');
      }
    }

    let componentTree: unknown;
    if (input.include.componentTree) {
      try {
        componentTree = (
          (await core.query('component.tree', { sessionId: input.sessionId, maxDepth: 10, maxNodes: 400 }, { actor: 'system' })) as {
            tree?: unknown;
          }
        ).tree;
      } catch {
        truncated.push('componentTree');
      }
    }

    let inFlightRequests: Array<{ requestId: string; url: string; method: string; elapsedMs: number }> = [];
    if (input.include.network) {
      const recent = core.store.recent(input.sessionId, 60_000);
      const started = new Map<string, { url: string; method: string; tsMono: number }>();
      const finished = new Set<string>();
      for (const e of recent) {
        if (e.type === 'network.request' && e.requestId) {
          started.set(e.requestId, { url: e.payload.url, method: e.payload.method, tsMono: e.tsMono });
        } else if ((e.type === 'network.finished' || e.type === 'network.failed') && e.requestId) {
          finished.add(e.requestId);
        }
      }
      const now = performance.now();
      inFlightRequests = [...started.entries()]
        .filter(([id]) => !finished.has(id))
        .map(([requestId, r]) => ({ requestId, url: r.url, method: r.method, elapsedMs: now - r.tsMono }));
    }

    let recentConsole: unknown[] = [];
    let recentErrors: unknown[] = [];
    if (input.include.console) {
      const consoleOut = (await core.query(
        'console.list',
        { sessionId: input.sessionId, limit: input.budgets.consoleEntries },
        { actor: 'system' },
      )) as { entries: unknown[] };
      recentConsole = consoleOut.entries;
      const errorsRaw = await core.store.query({
        sessionId: input.sessionId,
        types: ['error.uncaught', 'error.rejection'],
        epoch: core.store.currentEpoch(input.sessionId),
        limit: 20,
      });
      recentErrors = errorsRaw;
    }

    let result: z.input<typeof SessionObserveOutput> = {
      url: tab.view.webContents.getURL(),
      title: tab.view.webContents.getTitle(),
      buildStatus: 'unknown' as const,
      a11y: a11y as z.input<typeof SessionObserveOutput>['a11y'],
      componentTree: componentTree as z.input<typeof SessionObserveOutput>['componentTree'],
      inFlightRequests,
      recentConsole: recentConsole as z.input<typeof SessionObserveOutput>['recentConsole'],
      recentErrors: recentErrors as z.input<typeof SessionObserveOutput>['recentErrors'],
      truncated,
    };

    // Enforce the byte budget: shed the heaviest optional sections first.
    if (JSON.stringify(result).length > input.budgets.maxBytes) {
      result = { ...result, a11y: undefined, truncated: [...truncated, 'a11y:budget'] };
    }
    if (JSON.stringify(result).length > input.budgets.maxBytes) {
      result = {
        ...result,
        componentTree: undefined,
        truncated: [...(result.truncated ?? []), 'componentTree:budget'],
      };
    }
    return result;
  }

  core.registry.registerQuery({
    name: 'session.observe',
    description:
      'The Observation API: full observable state of a guest tab in ONE call — DOM accessibility tree, framework component tree, in-flight network requests, and recent console/errors, with url/title/build status. Size-budgeted (sheds a11y then component tree if over budget, noting it in `truncated`). Lets agents read state without parsing screenshots.',
    input: SessionObserveInput,
    output: SessionObserveOutput,
    handler: observe,
  });

  async function runAssertions(sessionId: string, assertions: Assertion[]) {
    const observed = await observe(
      SessionObserveInput.parse({ sessionId, budgets: { consoleEntries: 100, maxBytes: 500_000 } }),
    );
    const results = assertions.map((a) => evaluateAssertion(observed, a));
    return { pass: results.every((r) => r.pass), results };
  }

  core.registry.registerCommand({
    name: 'assert.run',
    description:
      'Run declarative assertions against the live session.observe output (e.g. select "recentErrors" op "count" value 0). Assertions come inline or from a committed suite in .localcoast/assertions/<name>.json. A fast verification layer between edits — no full Playwright/Cypress run.',
    input: AssertRunInput,
    output: AssertRunOutput,
    surfaces: { palette: true },
    paletteTitle: 'Run assertions…',
    handler: async (input) => {
      let assertions = input.assertions ?? [];
      if (input.suiteName) {
        const root = await projectRoot(input.sessionId);
        if (!root) throw new CapabilityFault('tier_unavailable', 'no project root for suite loading');
        // Defense-in-depth over the SafeName schema: never let a name escape the dir.
        const suiteFile = `${input.suiteName}.json`;
        if (basename(suiteFile) !== suiteFile) {
          throw new CapabilityFault('invalid_input', `unsafe suite name: ${input.suiteName}`);
        }
        try {
          const raw = await readFile(
            join(root, '.localcoast', 'assertions', suiteFile),
            'utf8',
          );
          assertions = AssertionSuiteSchema.parse(JSON.parse(raw)).assertions;
        } catch (err) {
          throw new CapabilityFault('not_found', `assertion suite ${input.suiteName}: ${String(err)}`);
        }
      }
      if (assertions.length === 0) {
        throw new CapabilityFault('invalid_input', 'no assertions provided (inline or suiteName)');
      }
      return runAssertions(input.sessionId, assertions);
    },
  });

  core.registry.registerCommand({
    name: 'assert.waitFor',
    description:
      'Poll one assertion against session.observe until it passes or times out (agent loops are request/response — there are no MCP subscriptions). Returns pass, elapsed, and the last result.',
    input: AssertWaitForInput,
    output: AssertWaitForOutput,
    handler: async (input) => {
      const start = performance.now();
      let lastResult;
      while (performance.now() - start < input.timeoutMs) {
        const { results } = await runAssertions(input.sessionId, [input.assertion]);
        lastResult = results[0];
        if (lastResult?.pass) return { pass: true, elapsedMs: performance.now() - start, lastResult };
        await new Promise((r) => setTimeout(r, input.intervalMs));
      }
      return { pass: false, elapsedMs: performance.now() - start, lastResult };
    },
  });

  // -- scenario playback via CDP Input ----------------------------------------------

  async function elementCenter(sessionId: string, selector: string): Promise<{ x: number; y: number } | null> {
    const tab = requireTab(sessionId);
    const result = (await tab.cdp.send(null, 'Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()`,
      returnByValue: true,
    })) as { result?: { value?: string } };
    return result.result?.value ? (JSON.parse(result.result.value) as { x: number; y: number }) : null;
  }

  async function playClick(sessionId: string, selector: string, button: 'left' | 'middle' | 'right') {
    const tab = requireTab(sessionId);
    const center = await elementCenter(sessionId, selector);
    if (!center) throw new CapabilityFault('not_found', `no element ${selector}`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await tab.cdp.send(null, 'Input.dispatchMouseEvent', {
        type,
        x: center.x,
        y: center.y,
        button,
        clickCount: 1,
      });
    }
  }

  async function playType(sessionId: string, selector: string, text: string, pressEnter: boolean) {
    const tab = requireTab(sessionId);
    await playClick(sessionId, selector, 'left');
    for (const ch of text) {
      await tab.cdp.send(null, 'Input.dispatchKeyEvent', { type: 'keyDown', text: ch });
      await tab.cdp.send(null, 'Input.dispatchKeyEvent', { type: 'keyUp', text: ch });
    }
    if (pressEnter) {
      await tab.cdp.send(null, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', windowsVirtualKeyCode: 13 });
      await tab.cdp.send(null, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', windowsVirtualKeyCode: 13 });
    }
  }

  core.registry.registerCommand({
    name: 'scenario.play',
    description:
      'Replay a recorded scenario (navigate/click/type/waitFor/snapshot/pause steps) deterministically against a guest tab via CDP Input. Returns per-step outcomes. Inspectable and re-runnable — not a passive recording.',
    input: SessionObserveInput.pick({ sessionId: true }).extend({ scenario: ScenarioSchema }),
    output: z.object({
      steps: z.array(z.object({ index: z.number().int(), action: z.string(), ok: z.boolean(), error: z.string().optional() })),
      pass: z.boolean(),
    }),
    surfaces: { palette: true },
    paletteTitle: 'Play scenario…',
    handler: async (input) => {
      const tab = requireTab(input.sessionId);
      const steps: Array<{ index: number; action: string; ok: boolean; error?: string }> = [];
      let index = 0;
      for (const step of input.scenario.steps) {
        try {
          switch (step.action) {
            case 'navigate':
              await tab.view.webContents.loadURL(step.url);
              break;
            case 'click':
              await playClick(input.sessionId, step.selector, step.button);
              break;
            case 'type':
              await playType(input.sessionId, step.selector, step.text, step.pressEnter);
              break;
            case 'waitFor': {
              const res = (await core.command(
                'assert.waitFor',
                { sessionId: input.sessionId, assertion: step.assertion, timeoutMs: step.timeoutMs },
                { actor: 'system' },
              )) as { pass: boolean };
              if (!res.pass) throw new Error('waitFor assertion timed out');
              break;
            }
            case 'snapshot':
              await core.command('snapshot.capture', { sessionId: input.sessionId, name: step.name }, { actor: 'system' });
              break;
            case 'pause':
              await new Promise((r) => setTimeout(r, step.ms));
              break;
          }
          steps.push({ index, action: step.action, ok: true });
        } catch (err) {
          steps.push({ index, action: step.action, ok: false, error: String(err) });
          break; // scenarios are ordered; stop at first failure
        }
        index++;
      }
      return { steps, pass: steps.every((s) => s.ok) && steps.length === input.scenario.steps.length };
    },
  });
}

function buildAxTree(nodes: CdpAxNode[]): unknown {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const root = nodes.find((n) => !n.ignored) ?? nodes[0];
  if (!root) return undefined;
  const seen = new Set<string>();
  function build(node: CdpAxNode | undefined, depth: number): unknown {
    if (!node || depth > 30 || seen.has(node.nodeId)) return undefined;
    seen.add(node.nodeId);
    const children = (node.childIds ?? [])
      .map((id) => build(byId.get(id), depth + 1))
      .filter((c): c is Record<string, unknown> => c !== undefined);
    return {
      role: node.role?.value ?? 'unknown',
      name: node.name?.value || undefined,
      value: node.value?.value || undefined,
      children: children.length > 0 ? children : undefined,
    };
  }
  return build(root, 0);
}

// Referenced for parity with the FileSystemLike interface in future suite IO.
export type { FileSystemLike };
