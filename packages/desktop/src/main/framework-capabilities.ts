import { clipboard } from 'electron';
import { z } from 'zod';
import { CapabilityFault, type Core, type ProcessInspector } from '@localcoast/core';
import {
  ComponentAtInput,
  ComponentAtOutput,
  ComponentTreeInput,
  ComponentTreeOutput,
  StateJumpInput,
  StateJumpOutput,
  StoresListInput,
  StoresListOutput,
} from '@localcoast/protocol-types';
import { relativizeSourcePath } from './script-catalog.js';
import type { TabManager } from './tabs.js';

/**
 * Framework adapter capabilities (AD-3). All page access goes through the
 * main-world registries the agent installed (__localcoastComponents /
 * __localcoastStores) via Runtime.evaluate on the mux — never through the
 * renderer (invariant 5).
 */

async function evalJson<T>(
  tabs: TabManager,
  sessionId: string,
  expression: string,
): Promise<T | null> {
  const tab = tabs.get(sessionId);
  if (!tab) throw new CapabilityFault('target_gone', `no open tab ${sessionId}`);
  const result = (await tab.cdp.send(null, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
  })) as { result?: { value?: string }; exceptionDetails?: unknown };
  if (!result.result?.value) return null;
  try {
    return JSON.parse(result.result.value) as T;
  } catch {
    return null;
  }
}

export function registerFrameworkCapabilities(
  core: Core,
  tabs: TabManager,
  inspector: ProcessInspector,
): void {
  async function projectRootOf(sessionId: string): Promise<string | undefined> {
    const tab = tabs.get(sessionId);
    if (!tab) return undefined;
    const servers = await inspector.listListeningServers();
    return servers.find((s) => s.port === tab.port)?.cwd;
  }

  async function componentAt(input: { sessionId: string; x: number; y: number }) {
    const probe = await evalJson<{
      framework: 'react' | 'vue' | 'svelte';
      componentName?: string;
      file?: string;
      line?: number;
      hasFn?: boolean;
    }>(
      tabs,
      input.sessionId,
      `JSON.stringify(window.__localcoastComponents ? window.__localcoastComponents.at(${input.x}, ${input.y}) : null)`,
    );
    if (!probe) return { resolvedVia: 'none' as const };
    const projectRoot = await projectRootOf(input.sessionId);

    // Fast paths: React _debugSource (pre-19) / Vue __file / Svelte meta.
    if (probe.file) {
      return {
        framework: probe.framework,
        componentName: probe.componentName,
        sourcePath: relativizeSourcePath(probe.file, projectRoot),
        line: probe.line,
        resolvedVia:
          probe.framework === 'vue'
            ? ('vueFile' as const)
            : probe.framework === 'svelte'
              ? ('svelteMeta' as const)
              : ('debugSource' as const),
      };
    }

    // Universal fallback (covers React 19): picked function →
    // [[FunctionLocation]] → scriptId → URL (invariant: never eval page data).
    if (probe.hasFn) {
      const tab = tabs.get(input.sessionId)!;
      const fnRef = (await tab.cdp.send(null, 'Runtime.evaluate', {
        expression: 'window.__lcPickedFn',
      })) as { result?: { objectId?: string } };
      if (fnRef.result?.objectId) {
        const props = (await tab.cdp.send(null, 'Runtime.getProperties', {
          objectId: fnRef.result.objectId,
        })) as {
          internalProperties?: Array<{
            name: string;
            value?: { value?: { scriptId?: string; lineNumber?: number } };
          }>;
        };
        const loc = props.internalProperties?.find((p) => p.name === '[[FunctionLocation]]')
          ?.value?.value;
        if (loc?.scriptId) {
          const url = tab.scripts.urlOf(loc.scriptId);
          if (url) {
            return {
              framework: probe.framework,
              componentName: probe.componentName,
              sourcePath: relativizeSourcePath(url, projectRoot),
              line: loc.lineNumber !== undefined ? loc.lineNumber + 1 : undefined,
              resolvedVia: 'functionLocation' as const,
            };
          }
        }
      }
    }
    return {
      framework: probe.framework,
      componentName: probe.componentName,
      resolvedVia: 'none' as const,
    };
  }

  core.registry.registerQuery({
    name: 'component.at',
    description:
      'Resolve the framework component rendered at viewport coordinates to its name and repo-relative source path (Component Selection). Fast paths: React _debugSource / Vue __file / Svelte meta; universal fallback via CDP [[FunctionLocation]] covers React 19 and prod-ish builds.',
    input: ComponentAtInput,
    output: ComponentAtOutput,
    handler: componentAt,
  });

  core.registry.registerCommand({
    name: 'component.copyPath',
    description:
      'Component Selection: resolve the component at coordinates and copy its repo-relative path to the clipboard (the guest right-click flow).',
    input: ComponentAtInput,
    output: ComponentAtOutput.extend({ copied: z.boolean() }),
    surfaces: { palette: true },
    paletteTitle: 'Copy component path at cursor',
    handler: async (input) => {
      const resolved = await componentAt(input);
      const copied = Boolean(resolved.sourcePath);
      if (resolved.sourcePath) {
        clipboard.writeText(
          resolved.line ? `${resolved.sourcePath}:${resolved.line}` : resolved.sourcePath,
        );
      }
      core.store.appendNow({
        sessionId: input.sessionId,
        actor: 'ui',
        type: 'console.entry',
        payload: {
          level: 'info',
          source: 'localcoast',
          text: copied
            ? `Copied component path: ${resolved.sourcePath}${resolved.line ? `:${resolved.line}` : ''} (${resolved.componentName ?? 'unknown'})`
            : `Component Selection: nothing resolvable at ${input.x},${input.y}`,
        },
      });
      return { ...resolved, copied };
    },
  });

  core.registry.registerQuery({
    name: 'component.tree',
    description:
      'Framework component tree for a guest tab (depth/node budgeted), from the devtools-hook-maintained fiber roots. Names + source paths where resolvable.',
    input: ComponentTreeInput,
    output: ComponentTreeOutput,
    handler: async (input) => {
      const result = await evalJson<{
        framework: string;
        truncated: boolean;
        tree: { name: string; framework?: string; children?: unknown[] };
      }>(
        tabs,
        input.sessionId,
        `JSON.stringify(window.__localcoastComponents ? window.__localcoastComponents.getTree(${input.maxDepth}, ${input.maxNodes}) : null)`,
      );
      if (!result) return { truncated: false };
      return { framework: result.framework, tree: result.tree, truncated: result.truncated };
    },
  });

  core.registry.registerQuery({
    name: 'stores.list',
    description:
      'State stores connected through the Redux-DevTools shim (Redux, Zustand devtools middleware, …) with action counts and jumpable history length (L3 — the reliable time-travel tier).',
    input: StoresListInput,
    output: StoresListOutput,
    handler: async (input) => {
      const stores = await evalJson<
        Array<{ storeId: string; name: string; actionCount: number; historyLength: number }>
      >(
        tabs,
        input.sessionId,
        'JSON.stringify(window.__localcoastStores ? window.__localcoastStores.list() : [])',
      );
      return { stores: stores ?? [] };
    },
  });

  core.registry.registerCommand({
    name: 'state.jump',
    description:
      'Time travel: replay a retained store state (by history index) into every store subscriber via the Redux-DevTools JUMP_TO_STATE protocol. Client state only — server side effects are not rewound.',
    input: StateJumpInput,
    output: StateJumpOutput,
    surfaces: { palette: true },
    paletteTitle: 'Jump store to state…',
    handler: async (input) => {
      const ok = await evalJson<boolean>(
        tabs,
        input.sessionId,
        `JSON.stringify(window.__localcoastStores ? window.__localcoastStores.jump(${JSON.stringify(input.storeId)}, ${input.index}) : false)`,
      );
      return { ok: ok ?? false };
    },
  });
}
