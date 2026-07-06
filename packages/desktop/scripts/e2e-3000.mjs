/**
 * Temp E2E: drive LocalCoast over its MCP surface against the user's real dev
 * server on localhost:3000. Read-only against the target app (open, observe,
 * navigate to /); exercises discovery, capture, network correlation, console,
 * storage, observe, screenshot, and the sidebar toggle.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const PORT = 3000;
const home = mkdtempSync(join(tmpdir(), 'localcoast-e2e-'));
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
if (!existsSync(instancePath)) {
  console.error('FAIL: instance.json never appeared');
  electron.kill();
  process.exit(1);
}
const instance = JSON.parse(readFileSync(instancePath, 'utf8'));
console.log(`LocalCoast MCP: ${instance.url}`);

const client = new Client({ name: 'e2e-3000', version: '0.0.1' });
await client.connect(
  new StreamableHTTPClientTransport(new URL(instance.url), {
    requestInit: { headers: { Authorization: `Bearer ${instance.token}` } },
  }),
);
const call = async (name, args = {}) =>
  (await client.callTool({ name, arguments: args })).structuredContent;

try {
  const { tools } = await client.listTools();
  check(`tools generated (${tools.length})`, tools.length >= 15);

  // Discovery must see the user's server.
  let targets = [];
  for (let i = 0; i < 10; i++) {
    targets = (await call('lc_targets_list'))?.targets ?? [];
    if (targets.some((t) => t.port === PORT)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  check('port scanner discovered :3000', targets.some((t) => t.port === PORT),
    JSON.stringify(targets.map((t) => t.port)));

  const open = await call('lc_targets_open', { port: PORT });
  const sessionId = open?.sessionId;
  check('tab opened with CDP capture', typeof sessionId === 'string');
  await new Promise((r) => setTimeout(r, 6000)); // let the app boot + redirect

  // Observe: live URL should reflect the app's auth redirect.
  const obs = await call('lc_session_observe', { sessionId }).catch(() => undefined);
  check('session.observe returns live url', typeof obs?.url === 'string', JSON.stringify(obs));
  console.log(`    live url: ${obs?.url}`);

  // Network: capture + new correlation fields on real traffic.
  const net = await call('lc_network_list', { sessionId, epoch: 'all', limit: 200 });
  const requests = net?.requests ?? [];
  check(`network captured (${requests.length} requests)`, requests.length > 0);
  check('all requests carry startTsWall', requests.every((r) => typeof r.startTsWall === 'number'));
  const stamped = requests.filter((r) => typeof r.pageUrl === 'string');
  check(`pageUrl stamped (${stamped.length}/${requests.length})`, stamped.length > 0);

  // Section structure as the panel would render it (chronological, navId|pageUrl).
  const chrono = [...requests].sort((a, b) => a.startTsMono - b.startTsMono);
  const sections = [];
  let prevKey = null;
  for (const r of chrono) {
    const key = `${r.navId ?? 'pre'}|${r.pageUrl ?? ''}`;
    if (key !== prevKey) {
      prevKey = key;
      sections.push({ pageUrl: r.pageUrl ?? '(unknown)', count: 0 });
    }
    sections[sections.length - 1].count++;
  }
  check('log breaks into page sections', sections.length >= 1);
  console.log('    sections:');
  for (const s of sections) console.log(`      [${String(s.count).padStart(3)} req] ${s.pageUrl}`);

  // network.get consistency on a stamped request.
  const sample = stamped[0];
  if (sample) {
    const got = await call('lc_network_get', { requestId: sample.requestId, includeBodies: false });
    check('network.get pageUrl consistent', got?.summary?.pageUrl === sample.pageUrl,
      `${got?.summary?.pageUrl} vs ${sample.pageUrl}`);
    check('network.get returns headers', got?.requestHeaders && typeof got.requestHeaders === 'object');
  }

  // Console + storage query surfaces respond.
  const cons = await call('lc_console_list', { sessionId, epoch: 'all' });
  check(`console.list responds (${cons?.entries?.length ?? 0} entries)`, Array.isArray(cons?.entries));
  const storage = await call('lc_storage_state', { sessionId }).catch(() => undefined);
  check('storage.state responds', storage !== undefined && Array.isArray(storage?.cookies));

  // Navigate back to / — the app's redirect generates a fresh session.navigated.
  await call('lc_act_navigate', { sessionId, url: `http://localhost:${PORT}/` });
  await new Promise((r) => setTimeout(r, 4000));
  const net2 = await call('lc_network_list', { sessionId, epoch: 'all', limit: 200 });
  check('navigation captured more traffic', (net2?.requests?.length ?? 0) > requests.length,
    `${net2?.requests?.length} vs ${requests.length}`);
  const navIds = new Set((net2?.requests ?? []).map((r) => r.navId).filter((n) => n !== undefined));
  check(`multiple navigation segments (${navIds.size})`, navIds.size >= 2);

  // Screenshot + sidebar toggle (guest widens by 420px).
  const shot1 = await call('lc_act_screenshot', { sessionId });
  check('screenshot captured', typeof shot1?.base64 === 'string' && shot1.base64.length > 1000);
  const hide = await call('lc_view_sidebar', {});
  check('view.sidebar hides', hide?.visible === false);
  await new Promise((r) => setTimeout(r, 500));
  const shot2 = await call('lc_act_screenshot', { sessionId });
  check('guest widened by sidebar width', shot2?.width === shot1?.width + 420,
    `before=${shot1?.width} after=${shot2?.width}`);
  const show = await call('lc_view_sidebar', { visible: true });
  check('view.sidebar restores', show?.visible === true);
} catch (err) {
  failures++;
  console.error('ERROR:', err);
} finally {
  electron.kill();
}
console.log(failures === 0 ? '\nE2E PASS' : `\nE2E FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
