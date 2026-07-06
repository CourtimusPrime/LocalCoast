/**
 * Temp E2E: exercise act.record.start/stop over LocalCoast's MCP surface
 * against the real dev server on localhost:3000. Read-only against the app.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const PORT = 3000;
const home = mkdtempSync(join(tmpdir(), 'localcoast-rec-'));
let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${cond ? '' : `  ${detail}`}`);
  if (!cond) failures++;
};

const electron = spawn('npx', ['electron', '.'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, LOCALCOAST_HOME: home },
  stdio: ['ignore', 'pipe', 'pipe'],
});
electron.stderr.on('data', () => {});
const instancePath = join(home, 'instance.json');
for (let i = 0; i < 60 && !existsSync(instancePath); i++) {
  await new Promise((r) => setTimeout(r, 500));
}
const instance = JSON.parse(readFileSync(instancePath, 'utf8'));
const client = new Client({ name: 'e2e-record', version: '0.0.1' });
await client.connect(
  new StreamableHTTPClientTransport(new URL(instance.url), {
    requestInit: { headers: { Authorization: `Bearer ${instance.token}` } },
  }),
);
const call = async (name, args = {}) =>
  (await client.callTool({ name, arguments: args })).structuredContent;

try {
  const open = await call('lc_targets_open', { port: PORT });
  const sessionId = open?.sessionId;
  check('tab opened', typeof sessionId === 'string');
  await new Promise((r) => setTimeout(r, 5000));

  const start = await call('lc_act_record_start', { sessionId, maxDurationMs: 30_000 });
  check('recording started', typeof start?.recordingId === 'string');

  // Generate visual activity: navigate around the app during the recording.
  await call('lc_act_navigate', { sessionId, url: `http://localhost:${PORT}/` });
  await new Promise((r) => setTimeout(r, 2500));
  await call('lc_act_navigate', { sessionId, url: `http://localhost:${PORT}/sign-in` });
  await new Promise((r) => setTimeout(r, 2500));

  const rec = await call('lc_act_record_stop', { recordingId: start.recordingId });
  check(`frames captured (${rec?.frameCount})`, (rec?.frameCount ?? 0) >= 3, JSON.stringify(rec));
  check('stoppedBy stop', rec?.stoppedBy === 'stop');

  const manifest = JSON.parse(readFileSync(rec.manifestPath, 'utf8'));
  check('manifest frames match', manifest.frames.length === rec.frameCount);
  const sources = new Set(manifest.frames.map((f) => f.source));
  console.log(`    dir: ${rec.dir}`);
  console.log(`    durationMs: ${rec.durationMs}, sizeBytes: ${rec.sizeBytes}, sources: ${[...sources].join(',')}`);
  console.log(`    timing: ${manifest.frames.slice(0, 12).map((f) => `${f.tMs}ms`).join(' ')}`);
  const first = readFileSync(join(rec.dir, rec.frames[0].file));
  check('frame is JPEG', first[0] === 0xff && first[1] === 0xd8);

  // Double-start guard + palette-style stop resolution via sessionId.
  const s2 = await call('lc_act_record_start', { sessionId, maxDurationMs: 3000 });
  const dup = await client.callTool({ name: 'lc_act_record_start', arguments: { sessionId } });
  check('double-start rejected', dup.isError === true, JSON.stringify(dup.content?.[0]));
  const stop2 = await call('lc_act_record_stop', { sessionId });
  check('stop resolves via sessionId', stop2?.recordingId === s2?.recordingId);
} catch (err) {
  failures++;
  console.error('ERROR:', err);
} finally {
  electron.kill();
}
console.log(failures === 0 ? '\nRECORD E2E PASS' : `\nRECORD E2E FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
