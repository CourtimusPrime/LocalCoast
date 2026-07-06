/**
 * Temp validation (dogfood): drive LocalCoast itself over its MCP surface to
 * verify network.list page-path correlation (pageUrl/navId/startTsWall) and
 * the view.sidebar toggle, against a real OAuth-shaped multi-page dev server.
 * Modeled on smoke.mjs.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const PORT = 5199;
const home = mkdtempSync(join(tmpdir(), 'localcoast-validate-'));
let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${cond ? '' : `  ${detail}`}`);
  if (!cond) failures++;
};

// OAuth-shaped dev server: /login fetches /api/session then pushState-routes to
// #/consent and fetches /api/consent; /callback fetches /api/me.
const page = (title, body) =>
  `<!doctype html><title>${title}</title><h1>${title}</h1><script>${body}</script>`;
const devServer = createServer((req, res) => {
  const url = req.url ?? '/';
  if (url.startsWith('/api/')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, endpoint: url }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  if (url.startsWith('/login')) {
    res.end(
      page(
        'login',
        `fetch('/api/session')
           .then(() => { history.pushState({}, '', '/consent'); return fetch('/api/consent'); });`,
      ),
    );
  } else if (url.startsWith('/callback')) {
    res.end(page('callback', `fetch('/api/me');`));
  } else {
    res.end(page('home', ''));
  }
});
await new Promise((r) => devServer.listen(PORT, '127.0.0.1', r));
console.log(`dev server on :${PORT}`);

const electron = spawn('npx', ['electron', '.'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, LOCALCOAST_HOME: home },
  stdio: ['ignore', 'pipe', 'pipe'],
});
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

const client = new Client({ name: 'validate', version: '0.0.1' });
await client.connect(
  new StreamableHTTPClientTransport(new URL(instance.url), {
    requestInit: { headers: { Authorization: `Bearer ${instance.token}` } },
  }),
);

try {
  const { tools } = await client.listTools();
  check('lc_view_sidebar tool generated', tools.some((t) => t.name === 'lc_view_sidebar'));
  const netList = tools.find((t) => t.name === 'lc_network_list');
  const outProps = netList?.outputSchema?.properties?.requests?.items?.properties ?? {};
  check(
    'network.list output schema exposes pageUrl/navId/startTsWall',
    'pageUrl' in outProps && 'navId' in outProps && 'startTsWall' in outProps,
    JSON.stringify(Object.keys(outProps)),
  );

  const open = await client.callTool({ name: 'lc_targets_open', arguments: { port: PORT } });
  const sessionId = open.structuredContent?.sessionId;
  check('tab opened', typeof sessionId === 'string');
  await new Promise((r) => setTimeout(r, 3000));

  // OAuth stages: /login (+ SPA hash route) → /callback.
  await client.callTool({
    name: 'lc_act_navigate',
    arguments: { sessionId, url: `http://127.0.0.1:${PORT}/login` },
  });
  await new Promise((r) => setTimeout(r, 2500));
  await client.callTool({
    name: 'lc_act_navigate',
    arguments: { sessionId, url: `http://127.0.0.1:${PORT}/callback` },
  });
  await new Promise((r) => setTimeout(r, 2500));

  const list = await client.callTool({
    name: 'lc_network_list',
    arguments: { sessionId, epoch: 'all', limit: 100 },
  });
  const requests = list.structuredContent?.requests ?? [];
  const byUrl = (frag) => requests.find((r) => r.url.includes(frag));

  check('every request carries startTsWall', requests.length > 0 && requests.every((r) => typeof r.startTsWall === 'number'));

  const session = byUrl('/api/session');
  const consent = byUrl('/api/consent');
  const me = byUrl('/api/me');
  check('/api/session stamped with /login page', session?.pageUrl?.endsWith('/login') === true, JSON.stringify(session));
  check(
    '/api/consent stamped with same-tick SPA route /consent',
    consent?.pageUrl?.endsWith('/consent') === true,
    JSON.stringify(consent),
  );
  check('/api/me stamped with /callback page', me?.pageUrl?.endsWith('/callback') === true, JSON.stringify(me));
  // Renderer section semantics: composite navId|pageUrl key → three sections.
  const keys = new Set(
    [session, consent, me].map((r) => `${r?.navId ?? 'pre'}|${r?.pageUrl ?? ''}`),
  );
  check('three distinct section keys across stages', keys.size === 3, JSON.stringify([...keys]));
  check(
    'full navigations get distinct navIds',
    session?.navId !== undefined && me?.navId !== undefined && session.navId !== me.navId,
    JSON.stringify([session?.navId, me?.navId]),
  );

  const got = await client.callTool({
    name: 'lc_network_get',
    arguments: { requestId: me?.requestId ?? '', includeBodies: false },
  });
  check(
    'network.get stamps same pageUrl',
    got.structuredContent?.summary?.pageUrl === me?.pageUrl,
    JSON.stringify(got.structuredContent?.summary?.pageUrl),
  );

  // Sidebar toggle: guest view must widen by the sidebar width (420px).
  const shotBefore = await client.callTool({ name: 'lc_act_screenshot', arguments: { sessionId } });
  const widthBefore = shotBefore.structuredContent?.width;
  const hide = await client.callTool({ name: 'lc_view_sidebar', arguments: {} });
  check('view.sidebar toggles to hidden', hide.structuredContent?.visible === false, JSON.stringify(hide.structuredContent));
  await new Promise((r) => setTimeout(r, 500));
  const shotAfter = await client.callTool({ name: 'lc_act_screenshot', arguments: { sessionId } });
  const widthAfter = shotAfter.structuredContent?.width;
  check(
    'guest view widened by sidebar width',
    typeof widthBefore === 'number' && widthAfter === widthBefore + 420,
    `before=${widthBefore} after=${widthAfter}`,
  );
  const show = await client.callTool({ name: 'lc_view_sidebar', arguments: { visible: true } });
  check('view.sidebar explicit set restores', show.structuredContent?.visible === true);
} catch (err) {
  failures++;
  console.error('ERROR:', err);
} finally {
  electron.kill();
  devServer.close();
}
console.log(failures === 0 ? '\nVALIDATE PASS' : `\nVALIDATE FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
