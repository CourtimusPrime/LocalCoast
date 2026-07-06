import { describe, expect, it } from 'vitest';
import { generateTools } from '../src/codegen.js';
import { seededCore } from './harness.js';

describe('tool codegen', () => {
  it('generates lc_-prefixed tools with object schemas and verbatim descriptions', async () => {
    const { core, store } = await seededCore();
    const tools = generateTools(core);

    expect(tools.length).toBeGreaterThanOrEqual(12);
    for (const tool of tools) {
      expect(tool.toolName).toMatch(/^lc_[a-z0-9_]+$/i);
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.outputSchema.type).toBe('object');
    }

    const eventsQuery = tools.find((t) => t.capabilityName === 'events.query')!;
    const registered = core.registry.get('events.query')!;
    expect(eventsQuery.description).toBe(registered.description);

    // Subscriptions are excluded from the tool surface.
    expect(tools.some((t) => t.capabilityName === 'events.subscribe')).toBe(false);
    await store.close();
  });

  it('input schemas encode defaults so agents see epoch/current semantics', async () => {
    const { core, store } = await seededCore();
    const tools = generateTools(core);
    const networkList = tools.find((t) => t.capabilityName === 'network.list')!;
    const props = networkList.inputSchema.properties as Record<string, { default?: unknown }>;
    expect(props.epoch?.default).toBe('current');
    await store.close();
  });
});
