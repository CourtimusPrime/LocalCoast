import { randomBytes } from 'node:crypto';
import { CapabilityFault, diffJson, type Core } from '@localcoast/core';
import {
  DiffBeginInput,
  DiffBeginOutput,
  DiffEndInput,
  DiffEndOutput,
} from '@localcoast/protocol-types';
import type { TabManager } from './tabs.js';

/**
 * Diff Mode (AD-7, phase 7 lifecycle): capture a before-baseline, then diff
 * DOM + network + storage once the change lands. The auto-end-on-HMR wiring
 * lives in main (it watches hmr.update); this module owns capture + compute.
 */

interface Baseline {
  sessionId: string;
  domText: string;
  networkUrls: Set<string>;
  storage: Record<string, string>;
  atEventId: number;
}

const SNAPSHOT_DOM = `document.documentElement.outerHTML`;
const SNAPSHOT_STORAGE = `JSON.stringify(Object.fromEntries(Object.entries({...localStorage})))`;

export class DiffMode {
  private baselines = new Map<string, Baseline>();

  constructor(
    private readonly core: Core,
    private readonly tabs: TabManager,
  ) {}

  private requireTab(sessionId: string) {
    const tab = this.tabs.get(sessionId);
    if (!tab) throw new CapabilityFault('target_gone', `no open tab ${sessionId}`);
    return tab;
  }

  private async snapshotTab(sessionId: string): Promise<Omit<Baseline, 'sessionId' | 'atEventId'>> {
    const tab = this.requireTab(sessionId);
    const dom = (await tab.cdp.send(null, 'Runtime.evaluate', {
      expression: SNAPSHOT_DOM,
      returnByValue: true,
    })) as { result?: { value?: string } };
    const storageRaw = (await tab.cdp.send(null, 'Runtime.evaluate', {
      expression: SNAPSHOT_STORAGE,
      returnByValue: true,
    })) as { result?: { value?: string } };
    const net = await this.core.store.query({
      sessionId,
      types: ['network.request'],
      epoch: this.core.store.currentEpoch(sessionId),
      limit: 500,
    });
    return {
      domText: dom.result?.value ?? '',
      networkUrls: new Set(
        net.flatMap((e) => (e.type === 'network.request' ? [e.payload.url] : [])),
      ),
      storage: JSON.parse(storageRaw.result?.value ?? '{}') as Record<string, string>,
    };
  }

  async begin(sessionId: string): Promise<string> {
    const snap = await this.snapshotTab(sessionId);
    const baselineId = `diff-${randomBytes(6).toString('hex')}`;
    const events = await this.core.store.query({ sessionId, limit: 1 });
    this.baselines.set(baselineId, {
      sessionId,
      ...snap,
      atEventId: events[events.length - 1]?.id ?? 0,
    });
    return baselineId;
  }

  async end(baselineId: string) {
    const baseline = this.baselines.get(baselineId);
    if (!baseline) throw new CapabilityFault('not_found', `no diff baseline ${baselineId}`);
    this.baselines.delete(baselineId);
    const after = await this.snapshotTab(baseline.sessionId);

    const addedUrls = [...after.networkUrls].filter((u) => !baseline.networkUrls.has(u));
    const removedUrls = [...baseline.networkUrls].filter((u) => !after.networkUrls.has(u));

    const storageDelta = diffJson(baseline.storage, after.storage).map((d) => ({
      key: d.path.replace(/^\$\.?/, ''),
      kind: d.kind,
    }));

    // DOM diff at a coarse structural level: element-count + tag-set changes
    // and a truncated line-level delta (full DOM tree diff is a phase-9 overlay).
    const domChanged = baseline.domText !== after.domText;
    const domDelta: string[] = [];
    if (domChanged) {
      const beforeTags = tagCounts(baseline.domText);
      const afterTags = tagCounts(after.domText);
      for (const tag of new Set([...Object.keys(beforeTags), ...Object.keys(afterTags)])) {
        const b = beforeTags[tag] ?? 0;
        const a = afterTags[tag] ?? 0;
        if (a !== b) domDelta.push(`<${tag}>: ${b} → ${a}`);
      }
      if (domDelta.length === 0) domDelta.push('DOM changed (attribute/text-level)');
    }

    return {
      domChanged,
      domDelta: domDelta.slice(0, 200),
      networkDelta: { added: addedUrls, removed: removedUrls },
      storageDelta,
    };
  }

  /** For auto-end on HMR: are there baselines waiting on this session? */
  baselinesFor(sessionId: string): string[] {
    return [...this.baselines.entries()]
      .filter(([, b]) => b.sessionId === sessionId)
      .map(([id]) => id);
  }
}

function tagCounts(html: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const m of html.matchAll(/<([a-zA-Z][\w-]*)/g)) {
    const tag = m[1]!.toLowerCase();
    counts[tag] = (counts[tag] ?? 0) + 1;
  }
  return counts;
}

export function registerDiffCapabilities(core: Core, tabs: TabManager, diffMode: DiffMode): void {
  core.registry.registerCommand({
    name: 'diff.begin',
    description:
      'Diff Mode: capture a before-baseline (DOM, network set, storage) for the tab. Pair with diff.end after a change; Diff Mode also auto-ends when an HMR reload is sniffed.',
    input: DiffBeginInput,
    output: DiffBeginOutput,
    surfaces: { palette: true },
    paletteTitle: 'Begin diff (capture before)',
    handler: async (input) => ({ baselineId: await diffMode.begin(input.sessionId) }),
  });

  core.registry.registerCommand({
    name: 'diff.end',
    description:
      'Close a Diff Mode baseline and return the before/after delta: DOM tag-count changes, added/removed network requests, and storage key changes — deterministic confirmation a change had the intended effect.',
    input: DiffEndInput,
    output: DiffEndOutput,
    surfaces: { palette: true },
    paletteTitle: 'End diff (compute after)',
    handler: async (input) => diffMode.end(input.baselineId),
  });
}
