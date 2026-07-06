/**
 * Desktop smoke (§5 phase 3): launch the real shell against a real dev server,
 * then verify — through the MCP surface only — that discovery, tab open, CDP
 * capture, and the event store all work end to end.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const PORT = 5177;
const home = mkdtempSync(join(tmpdir(), 'localcoast-smoke-'));
let failures = 0;

const check = (name, cond, detail = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${cond ? '' : `  ${detail}`}`);
  if (!cond) failures++;
};

// 1. A little "dev server": HTML page that fetches JSON and logs to console.
let apiHits = 0;
const devServer = createServer((req, res) => {
  if (req.url === '/api/data') {
    apiHits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    // Second+ hits change the contract: replay diff + schema drift visible.
    res.end(JSON.stringify(apiHits === 1 ? { items: [1, 2, 3] } : { items: [1, 2, 3, 4], extra: true }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><title>smoke app</title><h1>smoke</h1>
    <script>
      console.log('smoke-app booted');
      console.warn('smoke-warning');
      localStorage.setItem('smoke.token', 'tok-abc-123');
      localStorage.setItem('smoke.jwt', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJzbW9rZS11c2VyIiwiZXhwIjo0MTAyNDQ0ODAwfQ.fake-sig');
      localStorage.getItem('smoke.token');
      document.cookie = 'smokecookie=yes; path=/';
      history.pushState({}, '', '#/smoke-route');
      fetch('/api/data').then(r => r.json()).then(d => console.log('got', d.items.length, 'items'));
    </script>`);
});
await new Promise((r) => devServer.listen(PORT, '127.0.0.1', r));
console.log(`dev server on :${PORT}`);

// 2. Launch the shell.
const electron = spawn('npx', ['electron', '.'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, LOCALCOAST_HOME: home },
  stdio: ['ignore', 'pipe', 'pipe'],
});
electron.stdout.on('data', (d) => process.stdout.write(`[app] ${d}`));
electron.stderr.on('data', (d) => process.stderr.write(`[app-err] ${d}`));

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
console.log(`instance up: ${instance.url}`);

// 3. Drive it over MCP.
const client = new Client({ name: 'smoke', version: '0.0.1' });
await client.connect(
  new StreamableHTTPClientTransport(new URL(instance.url), {
    requestInit: { headers: { Authorization: `Bearer ${instance.token}` } },
  }),
);

try {
  const { tools } = await client.listTools();
  check('tools generated', tools.length >= 15, `got ${tools.length}`);

  // Port scanner sees the dev server.
  let targets = [];
  for (let i = 0; i < 10; i++) {
    const res = await client.callTool({ name: 'lc_targets_list', arguments: {} });
    targets = res.structuredContent?.targets ?? [];
    if (targets.some((t) => t.port === PORT)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  check('port scanner discovered dev server', targets.some((t) => t.port === PORT),
    JSON.stringify(targets.map((t) => t.port)));

  // Open a tab (CDP attach + capture) via command.
  const open = await client.callTool({ name: 'lc_targets_open', arguments: { port: PORT } });
  const sessionId = open.structuredContent?.sessionId;
  check('targets.open returned session', typeof sessionId === 'string', JSON.stringify(open));

  await new Promise((r) => setTimeout(r, 4000));

  // Network capture reached the store?
  const net = await client.callTool({ name: 'lc_network_list', arguments: { sessionId } });
  const requests = net.structuredContent?.requests ?? [];
  check('network events captured', requests.length >= 2, `got ${requests.length}`);
  check('api fetch captured', requests.some((r) => r.url.includes('/api/data')),
    JSON.stringify(requests.map((r) => r.url)));
  check('totals nonzero', (net.structuredContent?.totals?.downloadedBytes ?? 0) > 0);

  // Body persisted eagerly?
  const apiReq = requests.find((r) => r.url.includes('/api/data'));
  if (apiReq) {
    const detail = await client.callTool({
      name: 'lc_network_get',
      arguments: { requestId: apiReq.requestId },
    });
    check('response body persisted', (detail.structuredContent?.responseBody?.data ?? '').includes('items'),
      JSON.stringify(detail.structuredContent?.responseBody));
  }

  // Console capture?
  const cons = await client.callTool({ name: 'lc_console_list', arguments: { sessionId } });
  const texts = (cons.structuredContent?.entries ?? []).map((e) => e.payload.text);
  check('console.log captured', texts.some((t) => t.includes('smoke-app booted')), JSON.stringify(texts));
  check('console.warn captured', texts.some((t) => t.includes('smoke-warning')));

  // Epoch bump on reload.
  const reload = await client.callTool({ name: 'lc_targets_reload', arguments: { sessionId } });
  check('reload bumps epoch', reload.structuredContent?.epoch === 1, JSON.stringify(reload.structuredContent));
  await new Promise((r) => setTimeout(r, 2500));
  const net2 = await client.callTool({ name: 'lc_network_list', arguments: { sessionId } });
  check('new epoch resets default network view', (net2.structuredContent?.requests ?? [])
    .every((r) => r.epoch === 1), 'old-epoch rows leaked into current view');
  const netAll = await client.callTool({ name: 'lc_network_list', arguments: { sessionId, epoch: 'all' } });
  check('history preserved across epochs',
    (netAll.structuredContent?.requests ?? []).length > (net2.structuredContent?.requests ?? []).length);

  // Page-agent: storage trail through the binding pipeline (epoch 'all' —
  // the writes happened before the reload above).
  const trail = await client.callTool({
    name: 'lc_storage_trail',
    arguments: { sessionId },
  });
  const ops = trail.structuredContent?.ops ?? [];
  check('storage trail captured write with stack',
    ops.some((o) => o.payload.op === 'write' && o.payload.key === 'smoke.token' && (o.payload.stack?.length ?? 0) > 0),
    JSON.stringify(ops.map((o) => [o.payload.op, o.payload.key])));
  check('storage trail captured read', ops.some((o) => o.payload.op === 'read' && o.payload.key === 'smoke.token'));
  check('cookie write in trail', ops.some((o) => o.payload.area === 'cookie' && o.payload.op === 'write' && o.payload.key === 'smokecookie'));

  // Live storage state incl. cookies via CDP.
  const state = await client.callTool({ name: 'lc_storage_state', arguments: { sessionId } });
  const ls = state.structuredContent?.localStorage ?? [];
  check('storage.state shows live entry with firstSet timestamp',
    ls.some((e) => e.key === 'smoke.token' && e.value === 'tok-abc-123' && e.firstSetTsMono !== undefined),
    JSON.stringify(ls));
  check('storage.state includes cookies',
    (state.structuredContent?.cookies ?? []).some((c) => c.name === 'smokecookie'));

  // SPA route trail from the history patch.
  const routes = await client.callTool({
    name: 'lc_events_query',
    arguments: { sessionId, types: ['state.route'], epoch: 'all' },
  });
  check('route trail captured pushState',
    (routes.structuredContent?.events ?? []).some((e) => e.payload.to.includes('#/smoke-route')));

  // ---- Phase 5: replay, mocks, schema inference, token vault ----

  const netForReplay = await client.callTool({
    name: 'lc_network_list',
    arguments: { sessionId, epoch: 'all' },
  });
  // Oldest capture of the endpoint — its stored body predates the contract change.
  const apiRow = [...(netForReplay.structuredContent?.requests ?? [])]
    .reverse()
    .find((r) => r.url.includes('/api/data'));
  if (apiRow) {
    const replay = await client.callTool({
      name: 'lc_network_replay',
      arguments: { requestId: apiRow.requestId },
    });
    check('replay returns 200', replay.structuredContent?.status === 200, JSON.stringify(replay.structuredContent));
    check('replay inline diff detects contract change',
      replay.structuredContent?.diff?.identical === false &&
      (replay.structuredContent?.diff?.bodyDelta ?? []).some((d) => d.path === '$.extra'),
      JSON.stringify(replay.structuredContent?.diff));
  } else {
    check('replay: api request found', false);
  }

  const mockSet = await client.callTool({
    name: 'lc_network_mock_set',
    arguments: {
      pattern: { urlPattern: `http://localhost:${PORT}/api/data*` },
      response: { status: 503, headers: { 'content-type': 'application/json' }, body: '{"mocked":true}' },
      name: 'smoke-mock',
    },
  });
  const mockId = mockSet.structuredContent?.mockId;
  check('mock registered', typeof mockId === 'string');

  const mockedFetch = await client.callTool({
    name: 'lc_network_replay',
    arguments: { requestId: apiRow?.requestId, overrides: {}, mode: 'inPage' },
  });
  check('mock intercepts in-page request',
    mockedFetch.structuredContent?.status === 503 &&
    mockedFetch.structuredContent?.headers?.['x-localcoast-mock'] === mockId,
    JSON.stringify({ status: mockedFetch.structuredContent?.status, headers: mockedFetch.structuredContent?.headers }));

  const mockList = await client.callTool({ name: 'lc_network_mock_list', arguments: {} });
  check('mock hit count tracked', (mockList.structuredContent?.mocks ?? [])[0]?.hitCount >= 1);
  await client.callTool({ name: 'lc_network_mock_clear', arguments: {} });

  const schema = await client.callTool({ name: 'lc_api_schema', arguments: { sessionId } });
  const dataEndpoint = (schema.structuredContent?.endpoints ?? []).find((e) => e.endpoint === 'GET /api/data');
  check('api schema inferred from traffic',
    dataEndpoint !== undefined && dataEndpoint.responseSchema?.properties?.items !== undefined,
    JSON.stringify(schema.structuredContent));

  const vault = await client.callTool({ name: 'lc_auth_tokens', arguments: { sessionId } });
  const smokeJwt = (vault.structuredContent?.tokens ?? []).find((t) => t.sourceKey === 'smoke.jwt');
  check('token vault decodes stored JWT',
    smokeJwt?.payload?.sub === 'smoke-user' && smokeJwt?.expired === false,
    JSON.stringify(vault.structuredContent));

  await client.callTool({
    name: 'lc_cookie_set',
    arguments: { sessionId, cookie: { name: 'edited', value: 'in-place', httpOnly: true } },
  });
  const stateAfterCookie = await client.callTool({ name: 'lc_storage_state', arguments: { sessionId } });
  check('cookie edit-in-place lands with HttpOnly',
    (stateAfterCookie.structuredContent?.cookies ?? []).some((c) => c.name === 'edited' && c.httpOnly === true));

  // ---- Phase 6/7: snapshots, timeline, observe, assertions, scenario ----

  const snap = await client.callTool({
    name: 'lc_snapshot_capture',
    arguments: { sessionId, name: 'smoke-snap' },
  });
  check('snapshot captured with kinds',
    (snap.structuredContent?.kinds ?? []).includes('storage'),
    JSON.stringify(snap.structuredContent));
  const snapshotId = snap.structuredContent?.snapshotId;

  const snapList = await client.callTool({ name: 'lc_snapshots_list', arguments: { sessionId } });
  check('snapshot appears in list',
    (snapList.structuredContent?.snapshots ?? []).some((s) => s.snapshotId === snapshotId));

  const restore = await client.callTool({ name: 'lc_snapshot_restore', arguments: { snapshotId } });
  const items = restore.structuredContent?.report?.items ?? [];
  check('snapshot restore reports per-item outcomes',
    items.some((i) => i.path.startsWith('storage:') && i.status === 'restored'),
    JSON.stringify(items));

  const timeline = await client.callTool({
    name: 'lc_timeline_frames',
    arguments: { sessionId, epoch: 'all' },
  });
  check('timeline frames include labeled state events',
    (timeline.structuredContent?.frames ?? []).some((f) => f.type === 'state.route' && f.label.includes('route')),
    JSON.stringify((timeline.structuredContent?.frames ?? []).slice(0, 3)));

  const observe = await client.callTool({ name: 'lc_session_observe', arguments: { sessionId } });
  const obs = observe.structuredContent;
  check('observe returns a11y tree', obs?.a11y?.role !== undefined, JSON.stringify(obs?.a11y).slice(0, 120));
  check('observe returns url + console', obs?.url?.includes('localhost') && Array.isArray(obs?.recentConsole));

  const assertRun = await client.callTool({
    name: 'lc_assert_run',
    arguments: {
      sessionId,
      assertions: [
        { select: 'recentErrors', op: 'count', value: 0 },
        { select: 'url', op: 'contains', value: 'localhost' },
      ],
    },
  });
  check('assertions run against observe', assertRun.structuredContent?.pass === true,
    JSON.stringify(assertRun.structuredContent?.results?.map((r) => [r.assertion.select, r.pass])));

  // Diff Mode: baseline → DOM mutation → end.
  const diffBegin = await client.callTool({ name: 'lc_diff_begin', arguments: { sessionId } });
  const baselineId = diffBegin.structuredContent?.baselineId;
  await client.callTool({
    name: 'lc_act_navigate',
    arguments: { sessionId, url: `http://localhost:${PORT}/?changed=1` },
  });
  await new Promise((r) => setTimeout(r, 1500));
  const diffEnd = await client.callTool({ name: 'lc_diff_end', arguments: { baselineId } });
  check('diff mode computes a delta', diffEnd.structuredContent?.domChanged !== undefined,
    JSON.stringify(diffEnd.structuredContent).slice(0, 160));

  // Scenario playback via CDP Input.
  const scenario = await client.callTool({
    name: 'lc_scenario_play',
    arguments: {
      sessionId,
      scenario: {
        version: 1,
        kind: 'scenario',
        name: 'smoke-scenario',
        steps: [
          { action: 'navigate', url: `http://localhost:${PORT}/` },
          { action: 'waitFor', assertion: { select: 'url', op: 'contains', value: 'localhost' }, timeoutMs: 5000 },
        ],
      },
    },
  });
  check('scenario playback runs all steps', scenario.structuredContent?.pass === true,
    JSON.stringify(scenario.structuredContent?.steps));

  // ---- Phase 8–10: ingestors, sensing, collab/polish ----

  // Tier-2 ingest over HTTP (simulates the run-wrapper / node-agent).
  const ingestRes = await fetch(instance.url.replace(/\/mcp$/, '/ingest'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${instance.token}` },
    body: JSON.stringify({
      events: [
        { type: 'console.entry', actor: 'app', payload: { level: 'info', source: 'server', text: 'server log line' } },
        { type: 'db.query', actor: 'app', payload: { sql: 'SELECT * FROM users WHERE id = 1', driver: 'pg', durationMs: 3 } },
      ],
    }),
  });
  check('ingest endpoint accepts Tier-2 events', ingestRes.ok);
  await new Promise((r) => setTimeout(r, 300));
  const serverLogs = await client.callTool({
    name: 'lc_console_list',
    arguments: { sessionId: 'server-side', epoch: 'all' },
  });
  check('server-side log captured via ingest',
    (serverLogs.structuredContent?.entries ?? []).some((e) => e.payload.text === 'server log line'),
    JSON.stringify((serverLogs.structuredContent?.entries ?? []).map((e) => e.payload.text)));
  const dbEvents = await client.callTool({
    name: 'lc_events_query',
    arguments: { sessionId: 'server-side', types: ['db.query'], epoch: 'all' },
  });
  check('db query ingested', (dbEvents.structuredContent?.events ?? []).length >= 1);

  // OTLP receiver.
  const otlpRes = await fetch('http://127.0.0.1:4318/v1/traces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      resourceSpans: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'checkout-api' } }] },
        scopeSpans: [{ spans: [{ name: 'GET /checkout', spanId: 'a1', traceId: 't1', startTimeUnixNano: '1700000000000000000', endTimeUnixNano: '1700000000050000000', status: { code: 1 } }] }],
      }],
    }),
  }).catch(() => ({ ok: false }));
  check('OTLP receiver accepts traces', otlpRes.ok);
  await new Promise((r) => setTimeout(r, 300));
  const traces = await client.callTool({
    name: 'lc_events_query',
    arguments: { sessionId: 'server-side', types: ['trace.span'], epoch: 'all' },
  });
  check('OTLP trace stored as span',
    (traces.structuredContent?.events ?? []).some((e) => e.payload.name === 'GET /checkout' && e.payload.serviceName === 'checkout-api'),
    JSON.stringify((traces.structuredContent?.events ?? []).map((e) => e.payload.name)));

  // Bug bundle with redaction (invariant 8).
  await client.callTool({
    name: 'lc_cookie_set',
    arguments: { sessionId, cookie: { name: 'authToken', value: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig' } },
  });
  const bundle = await client.callTool({ name: 'lc_export_bundle', arguments: { sessionId } });
  check('bug bundle written', typeof bundle.structuredContent?.path === 'string' && bundle.structuredContent?.sizeBytes > 0);
  if (bundle.structuredContent?.path) {
    const bundleText = readFileSync(bundle.structuredContent.path, 'utf8');
    check('bundle redaction masks JWTs/tokens',
      !bundleText.includes('eyJhbGciOiJIUzI1NiJ9') && (bundle.structuredContent?.redactions ?? 0) >= 0,
      `redactions=${bundle.structuredContent?.redactions}`);
  }

  // a11y audit.
  const a11y = await client.callTool({ name: 'lc_a11y_audit', arguments: { sessionId } });
  check('a11y audit runs and flags missing lang',
    (a11y.structuredContent?.violations ?? []).some((v) => v.rule === 'html-lang'),
    JSON.stringify((a11y.structuredContent?.violations ?? []).map((v) => v.rule)));

  // Resource sampler feeding the samples table.
  await new Promise((r) => setTimeout(r, 1200));
  const samples = await client.callTool({
    name: 'lc_resources_samples',
    arguments: { sessionId, kinds: ['heapBytes', 'domNodes'] },
  });
  check('resource sampler populates heap/DOM series',
    (samples.structuredContent?.samples ?? []).some((s) => s.kind === 'heapBytes'),
    `${(samples.structuredContent?.samples ?? []).length} samples`);

  // Port conflict resolver (read-only check on our own dev server port).
  const conflict = await client.callTool({ name: 'lc_ports_conflict', arguments: { port: PORT } });
  check('port conflict resolver identifies holder', conflict.structuredContent?.inUse === true);

  // Breakpoint + split-view layout commands.
  const bp = await client.callTool({ name: 'lc_view_breakpoint', arguments: { sessionId, width: 375, height: 812, rtl: true } });
  check('breakpoint applied', bp.structuredContent?.ok === true);

  // Screenshot through CDP.
  const shot = await client.callTool({ name: 'lc_act_screenshot', arguments: { sessionId } });
  check('screenshot captured', (shot.structuredContent?.base64 ?? '').length > 1000);

  // Screen recording: JPEG frame sequence + timestamped manifest.
  const recStart = await client.callTool({ name: 'lc_act_record_start', arguments: { sessionId } });
  const recordingId = recStart.structuredContent?.recordingId;
  check('recording started', typeof recordingId === 'string', JSON.stringify(recStart.structuredContent));
  // Navigation forces repaints (screencast only emits frames on compositor commits).
  await client.callTool({ name: 'lc_act_navigate', arguments: { sessionId, url: `http://localhost:${PORT}/` } });
  await new Promise((r) => setTimeout(r, 2000));
  const recStop = await client.callTool({ name: 'lc_act_record_stop', arguments: { recordingId } });
  const rec = recStop.structuredContent;
  check('recording captured frames', (rec?.frameCount ?? 0) >= 1 && rec?.stoppedBy === 'stop',
    JSON.stringify(rec));
  if ((rec?.frameCount ?? 0) >= 1) {
    const manifest = JSON.parse(readFileSync(rec.manifestPath, 'utf8'));
    check('recording manifest lists frames', manifest.frames.length === rec.frameCount);
    const firstFrame = readFileSync(join(rec.dir, rec.frames[0].file));
    check('recording frame is JPEG', firstFrame[0] === 0xff && firstFrame[1] === 0xd8);
  }

  // Agent action visible in audit trail with mcp actor.
  const audit = await client.callTool({
    name: 'lc_events_query',
    arguments: { sessionId, types: ['action.dispatched'], epoch: 'all' },
  });
  const auditEvents = audit.structuredContent?.events ?? [];
  check('mcp actions audited with actor attribution',
    auditEvents.some((e) => e.actor === 'mcp' && e.payload.capability === 'targets.reload'),
    JSON.stringify(auditEvents.map((e) => [e.actor, e.payload.capability])));
} finally {
  await client.close().catch(() => {});
  electron.kill();
  devServer.close();
}

console.log(failures === 0 ? '\nSMOKE PASS' : `\nSMOKE FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
