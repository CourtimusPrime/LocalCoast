/**
 * Temp E2E: verify component source-path resolution against the real Next.js
 * app on localhost:3000. Probes a grid of viewport coordinates via component.at
 * and reports how each resolved — the fix means bundled apps resolve to a
 * real `.tsx` (resolvedVia: 'sourceMap'), not a `_next/chunks` path.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const PORT = 3000;
const home = mkdtempSync(join(tmpdir(), 'localcoast-sm-'));
const electron = spawn('npx', ['electron', '.'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, LOCALCOAST_HOME: home },
  stdio: ['ignore', 'pipe', 'pipe'],
});
electron.stderr.on('data', () => {});
const instancePath = join(home, 'instance.json');
for (let i = 0; i < 60 && !existsSync(instancePath); i++) await new Promise((r) => setTimeout(r, 500));
const instance = JSON.parse(readFileSync(instancePath, 'utf8'));
const client = new Client({ name: 'e2e-sm', version: '0.0.1' });
await client.connect(
  new StreamableHTTPClientTransport(new URL(instance.url), {
    requestInit: { headers: { Authorization: `Bearer ${instance.token}` } },
  }),
);
const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).structuredContent;

let failures = 0;
try {
  const open = await call('lc_targets_open', { port: PORT });
  const sessionId = open.sessionId;
  await new Promise((r) => setTimeout(r, 6000));
  const obs = await call('lc_session_observe', { sessionId });
  console.log(`live url: ${obs?.url}`);

  // Probe a grid across the viewport; collect distinct resolutions.
  const results = [];
  for (const y of [120, 250, 400, 550, 700]) {
    for (const x of [200, 500, 800, 1050]) {
      const r = await call('lc_component_at', { sessionId, x, y }).catch(() => undefined);
      if (r?.componentName || r?.sourcePath) {
        results.push({ x, y, name: r.componentName, path: r.sourcePath, line: r.line, via: r.resolvedVia });
      }
    }
  }
  const uniq = new Map();
  for (const r of results) uniq.set(`${r.name}|${r.path}`, r);
  console.log('\nresolved components:');
  for (const r of uniq.values()) {
    console.log(`  [${r.via}] ${r.name ?? '(unnamed)'} → ${r.path ?? '(no path)'}${r.line ? ':' + r.line : ''}`);
  }

  const anySourceMap = [...uniq.values()].some((r) => r.via === 'sourceMap');
  const anyChunk = [...uniq.values()].some((r) => /_next|chunks|\.js(:|$)/.test(r.path ?? ''));
  console.log('');
  const check = (n, c, d = '') => { console.log(`  ${c ? '✓' : '✗'} ${n}${c ? '' : '  ' + d}`); if (!c) failures++; };
  check('at least one component resolved via source map', anySourceMap);
  check('no resolution points at a compiled _next/chunk .js path', !anyChunk,
    JSON.stringify([...uniq.values()].filter((r) => /_next|chunks|\.js/.test(r.path ?? '')).map((r) => r.path)));
} catch (err) {
  failures++;
  console.error('ERROR:', err);
} finally {
  electron.kill();
}
console.log(failures === 0 ? '\nSOURCEMAP E2E PASS' : `\nSOURCEMAP E2E FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
