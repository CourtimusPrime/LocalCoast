import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Core } from '../core.js';
import { EventStore, InProcessBackend } from '../events/store.js';
import { registerBuiltins } from '../capabilities/builtins.js';

/**
 * CI invariant 2 (AD-5): every registered capability is MCP-exposed unless it
 * carries a written mcpExclusionReason. Registration itself throws on
 * violations, so loading the full registry IS the check; this script also
 * prints the exposure table for review.
 */

const dbPath = join(mkdtempSync(join(tmpdir(), 'localcoast-check-')), 'events.db');
const store = new EventStore({ backend: new InProcessBackend(dbPath) });
await store.open();

const core = new Core(store);
registerBuiltins(core, {
  inspector: { listListeningServers: async () => [], envOf: async () => undefined },
});

const caps = core.registry.list();
let excluded = 0;
for (const cap of caps) {
  if (cap.surfaces.mcp) {
    console.log(`  mcp  ${cap.kind.padEnd(12)} ${cap.name}`);
  } else {
    excluded++;
    console.log(`  ---  ${cap.kind.padEnd(12)} ${cap.name}  (excluded: ${cap.mcpExclusionReason})`);
  }
}
console.log(`\n${caps.length} capabilities; ${caps.length - excluded} MCP-exposed, ${excluded} excluded with written reasons.`);
await store.close();
