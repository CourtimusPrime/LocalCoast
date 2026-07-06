import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, app, ipcMain, session } from 'electron';
import { ChildProcessBackend, Core, EventStore, registerBuiltins } from '@localcoast/core';
import { McpHttpServer, localcoastHome, writeInstanceInfo } from '@localcoast/mcp';
import { DiffMode, registerDiffCapabilities } from './diff-capabilities.js';
import { registerFrameworkCapabilities } from './framework-capabilities.js';
import { IngestSink, OtlpReceiver } from './ingest.js';
import { LsofInspector } from './inspector.js';
import { MockEngine } from './mocks.js';
import { registerNetworkCapabilities } from './network-capabilities.js';
import { registerObserveCapabilities } from './observe-capabilities.js';
import { registerProjectCapabilities } from './project-capabilities.js';
import { registerShellCapabilities } from './shell-capabilities.js';
import { registerSnapshotCapabilities } from './snapshot-capabilities.js';
import { GUEST_PARTITION, TabManager } from './tabs.js';

/**
 * Desktop main process: hosts Core (with the worker-thread event store), the
 * MCP HTTP server, cdp-mux'd guest tabs, and the three-channel preload bridge.
 * The renderer is a thin client — its ONLY data path is core:query /
 * core:command / core:subscribe (invariant 1).
 */

const here = fileURLToPath(new URL('.', import.meta.url));

async function boot(): Promise<void> {
  await app.whenReady();

  // Guest partition trusts self-signed certs for localhost only (AD-2).
  const guestSession = session.fromPartition(GUEST_PARTITION);
  guestSession.setCertificateVerifyProc((request, callback) => {
    const local = request.hostname === 'localhost' || request.hostname === '127.0.0.1';
    callback(local ? 0 : -3);
  });

  const projectHash = createHash('sha256').update(process.cwd()).digest('hex').slice(0, 12);
  const dataDir = join(localcoastHome(), 'data', projectHash);
  mkdirSync(dataDir, { recursive: true });

  // System-Node child (not a worker thread): better-sqlite3's prebuild targets
  // the plain-Node ABI, which Electron cannot load in-process.
  const childScript = fileURLToPath(
    new URL('./events/writer-child.js', import.meta.resolve('@localcoast/core')),
  );
  const store = new EventStore({
    backend: new ChildProcessBackend(join(dataDir, 'events.db'), { childScript }),
  });
  await store.open();

  const core = new Core(store);
  let mcpServer: McpHttpServer | null = null;
  const inspector = new LsofInspector(() => (mcpServer ? [mcpServer.port] : []));
  registerBuiltins(core, { inspector });

  const window = new BrowserWindow({
    width: 1480,
    height: 960,
    title: 'LocalCoast',
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  const tabs = new TabManager(window, store);
  const mockEngine = new MockEngine();
  tabs.onTabOpened = (sessionId, cdp) => void mockEngine.attachTab(sessionId, cdp);
  tabs.onTabClosed = (sessionId) => void mockEngine.detachTab(sessionId);
  const diffMode = new DiffMode(core, tabs);
  registerShellCapabilities(core, tabs);
  registerFrameworkCapabilities(core, tabs, inspector);
  registerNetworkCapabilities(core, tabs, mockEngine, inspector);
  registerSnapshotCapabilities(core, tabs);
  registerDiffCapabilities(core, tabs, diffMode);
  registerObserveCapabilities(core, tabs, () => undefined);
  registerProjectCapabilities(core, tabs, mockEngine, inspector);
  tabs.onGuestContextMenu = (sessionId, x, y) => {
    void core.command('component.copyPath', { sessionId, x, y }, { actor: 'ui' }).catch(() => {});
  };
  // Diff Mode auto-ends when an HMR reload is sniffed (AD-7): emit a completed
  // event carrying the delta so panels/agents can read it without polling.
  store.onEvent(
    (evt) => {
      if (evt.type !== 'hmr.update') return;
      for (const baselineId of diffMode.baselinesFor(evt.sessionId)) {
        void diffMode.end(baselineId).then((delta) => {
          store.appendNow({
            sessionId: evt.sessionId,
            actor: 'system',
            type: 'console.entry',
            payload: {
              level: 'info',
              source: 'localcoast',
              text: `Diff Mode auto-ended on HMR: ${delta.domChanged ? delta.domDelta.join(', ') : 'no DOM change'}; +${delta.networkDelta.added.length}/-${delta.networkDelta.removed.length} requests`,
            },
          });
        });
      }
    },
    { types: ['hmr.update'] },
  );

  // Tier-2 ingest: wrapper/node-agent/reporters + OTLP funnel into a synthetic
  // server-side session sharing the timeline.
  const ingestSink = new IngestSink(store);
  const otlp = new OtlpReceiver(ingestSink);
  const otlpBound = await otlp.start();
  if (otlpBound) console.log(`LocalCoast OTLP receiver: http://127.0.0.1:${otlp.port}/v1/traces`);

  // MCP starts AFTER all capability registration so codegen sees everything.
  mcpServer = new McpHttpServer({ core, onIngest: (events) => ingestSink.ingest(events) });
  await mcpServer.start();
  await writeInstanceInfo({
    version: 1,
    url: mcpServer.url,
    port: mcpServer.port,
    pid: process.pid,
    token: mcpServer.token,
    startedAtWall: Date.now(),
  });
  console.log(`LocalCoast MCP: ${mcpServer.url}`);

  // ---- The three channels. There is no fourth. (invariant 1) ----
  ipcMain.handle('core:query', (_evt, name: string, input: unknown) =>
    core.query(name, input, { actor: 'ui' }),
  );
  ipcMain.handle('core:command', (_evt, name: string, input: unknown) =>
    core.command(name, input, { actor: 'ui' }),
  );
  const subscriptions = new Map<string, () => void>();
  ipcMain.handle('core:subscribe', (evt, subId: string, name: string, input: unknown) => {
    const unsub = core.subscribe(name, input, { actor: 'ui' }, (data) => {
      if (!evt.sender.isDestroyed()) evt.sender.send(`core:sub:${subId}`, data);
    });
    subscriptions.set(subId, unsub);
  });
  ipcMain.handle('core:unsubscribe', (_evt, subId: string) => {
    subscriptions.get(subId)?.();
    subscriptions.delete(subId);
  });

  await window.loadFile(join(here, 'renderer', 'index.html'));

  app.on('window-all-closed', () => {
    void (async () => {
      otlp.stop();
      await mcpServer?.stop();
      await store.close();
      app.quit();
    })();
  });
}

boot().catch((err) => {
  console.error('LocalCoast failed to boot:', err);
  app.exit(1);
});
