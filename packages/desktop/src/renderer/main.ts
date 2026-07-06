/**
 * Thin-client renderer (invariant 1): every byte of data on screen came
 * through core.query / core.subscribe. Panels declare their registry
 * dependencies in PANEL_DEPS — the parity harness runs the same queries over
 * MCP HTTP and asserts identical results.
 */

interface CoreBridge {
  query(name: string, input: unknown): Promise<unknown>;
  command(name: string, input: unknown): Promise<unknown>;
  subscribe(name: string, input: unknown, onData: (data: unknown) => void): () => void;
}

declare global {
  interface Window {
    core: CoreBridge;
  }
}

export const PANEL_DEPS: Record<string, string[]> = {
  serverList: ['targets.list', 'sessions.list'],
  network: ['network.list'],
  console: ['console.list'],
  storage: ['storage.state', 'storage.trail'],
  perf: ['resources.samples', 'build.status'],
  palette: ['actions.list', 'act.dispatch'],
};

const core = window.core;
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

let activeSession: string | null = null;
let liveUnsub: (() => void) | null = null;

// ---------------------------------------------------------------------------
// Server list
// ---------------------------------------------------------------------------

interface TargetRow {
  targetKey: string;
  port: number;
  pid?: number;
  attached: boolean;
  sessionId?: string;
}

async function refreshServers(): Promise<void> {
  const { targets } = (await core.query('targets.list', {})) as { targets: TargetRow[] };
  const container = $('#server-list');
  container.replaceChildren(
    ...targets.map((t) => {
      const card = document.createElement('div');
      card.className = 'server-card';
      card.innerHTML = `
        <div class="port">localhost:${t.port}</div>
        <div class="meta">${t.pid ? `pid ${t.pid}` : 'process unknown'}</div>
        <span class="badge ${t.attached ? 'attached' : ''}">${t.attached ? 'attached' : 'detected'}</span>`;
      card.addEventListener('click', () => void openTab(t.port));
      return card;
    }),
  );
  if (targets.length === 0) {
    container.innerHTML = '<p class="hint">No listening localhost servers found yet.</p>';
  }
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

interface SessionRow {
  sessionId: string;
  targetKey: string;
  currentEpoch: number;
}

async function refreshTabs(): Promise<void> {
  const { sessions } = (await core.query('sessions.list', {})) as { sessions: SessionRow[] };
  const strip = $('#tabstrip');
  strip.replaceChildren(
    ...sessions.map((s) => {
      const btn = document.createElement('button');
      btn.className = s.sessionId === activeSession ? 'active' : '';
      btn.innerHTML = `${s.targetKey.replace('port:', ':')}<span class="close">×</span>`;
      btn.addEventListener('click', (evt) => {
        if ((evt.target as HTMLElement).classList.contains('close')) {
          void closeTab(s.sessionId);
        } else {
          void selectSession(s.sessionId);
        }
      });
      return btn;
    }),
  );
}

async function openTab(port: number): Promise<void> {
  const result = (await core.command('targets.open', { port })) as { sessionId: string };
  await selectSession(result.sessionId);
  await Promise.all([refreshTabs(), refreshServers()]);
}

async function closeTab(sessionId: string): Promise<void> {
  await core.command('targets.close', { sessionId });
  if (activeSession === sessionId) activeSession = null;
  await Promise.all([refreshTabs(), refreshServers(), renderPanels()]);
}

async function selectSession(sessionId: string): Promise<void> {
  activeSession = sessionId;
  liveUnsub?.();
  // Live refresh: any new event for this session repaints the active panel.
  let scheduled = false;
  liveUnsub = core.subscribe('events.subscribe', { sessionId }, () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      void renderPanels();
    }, 250);
  });
  await Promise.all([refreshTabs(), renderPanels()]);
}

// ---------------------------------------------------------------------------
// Network panel
// ---------------------------------------------------------------------------

interface NetworkSummary {
  requestId: string;
  url: string;
  method: string;
  status?: number;
  failed: boolean;
  downloadedBytes?: number;
  startTsMono: number;
  startTsWall: number;
  pageUrl?: string;
  navId?: number;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function formatWallClock(tsWall: number): string {
  const d = new Date(tsWall);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** Section header text: bare path for the local dev server, host+path for cross-origin hops (OAuth providers). */
function sectionLabel(pageUrl?: string): string {
  if (!pageUrl) return '(unknown page)';
  try {
    const u = new URL(pageUrl);
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    return local ? u.pathname || '/' : `${u.host}${u.pathname}`;
  } catch {
    return pageUrl;
  }
}

let lastNetworkText = '';
let showNetTs = false;
try {
  showNetTs = localStorage.getItem('lc.net.showTs') === '1';
} catch {
  /* storage unavailable — toggle stays session-only */
}

async function renderNetwork(): Promise<void> {
  const totalsEl = $('#network-totals');
  const rowsEl = $('#network-rows');
  if (!activeSession) {
    totalsEl.textContent = 'Open a server tab to capture traffic.';
    rowsEl.replaceChildren();
    lastNetworkText = '';
    return;
  }
  const out = (await core.query('network.list', { sessionId: activeSession, limit: 200 })) as {
    requests: NetworkSummary[];
    totals: { uploadedBytes: number; downloadedBytes: number; requestCount: number };
  };
  totalsEl.textContent = `▲ ${formatBytes(out.totals.uploadedBytes)}   ▼ ${formatBytes(out.totals.downloadedBytes)}   ${out.totals.requestCount} requests (this epoch)`;

  // Chronological display (query returns newest-first): an OAuth flow reads
  // top-to-bottom, one section per navigation.
  const rows = [...out.requests].sort((a, b) => a.startTsMono - b.startTsMono);
  const frag = document.createDocumentFragment();
  const copyLines: string[] = [];
  // Composite key: navId separates revisits of the same path; pageUrl separates
  // a same-tick SPA route + fetch whose navId still points at the prior segment.
  let prevSection: string | null = null;
  for (const r of rows) {
    const sectionKey = `${r.navId ?? 'pre'}|${r.pageUrl ?? ''}`;
    if (sectionKey !== prevSection) {
      prevSection = sectionKey;
      const section = document.createElement('div');
      section.className = 'net-section';
      section.textContent = sectionLabel(r.pageUrl);
      if (r.pageUrl) section.title = r.pageUrl;
      frag.append(section);
      copyLines.push(`== Page: ${r.pageUrl ?? '(unknown)'} ==`);
    }
    const row = document.createElement('div');
    row.className = 'net-row';
    const status = document.createElement('span');
    status.className = r.failed ? 'failed' : `status-${String(r.status ?? 0)[0]}`;
    status.textContent = r.failed ? 'ERR' : String(r.status ?? '…');
    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = formatWallClock(r.startTsWall);
    const url = document.createElement('span');
    url.className = 'url';
    url.title = r.url;
    url.textContent = `${r.method} ${r.url.replace(/^https?:\/\/[^/]+/, '') || '/'}`;
    const size = document.createElement('span');
    size.className = 'size';
    size.textContent = r.downloadedBytes !== undefined ? formatBytes(r.downloadedBytes) : '';
    row.append(status, ts, url, size);
    frag.append(row);
    const statusText = r.failed ? 'ERR' : (r.status ?? 'pending');
    const sizeText = r.downloadedBytes !== undefined ? ` ${formatBytes(r.downloadedBytes)}` : '';
    copyLines.push(`[${formatWallClock(r.startTsWall)}] ${r.method} ${r.url} ${statusText}${sizeText}`);
  }
  lastNetworkText = copyLines.join('\n');
  rowsEl.classList.toggle('show-ts', showNetTs);
  rowsEl.replaceChildren(frag);
  rowsEl.scrollTop = rowsEl.scrollHeight;
}

// ---------------------------------------------------------------------------
// Console panel
// ---------------------------------------------------------------------------

interface ConsoleEntry {
  tsMono: number;
  payload: { level: string; text: string };
}

let lastConsoleText = '';

async function renderConsole(): Promise<void> {
  const rowsEl = $('#console-rows');
  if (!activeSession) {
    rowsEl.replaceChildren();
    return;
  }
  const out = (await core.query('console.list', { sessionId: activeSession, limit: 300 })) as {
    entries: ConsoleEntry[];
  };
  lastConsoleText = out.entries
    .map((e) => `[${(e.tsMono / 1000).toFixed(2)}s] [${e.payload.level}] ${e.payload.text}`)
    .join('\n');
  rowsEl.replaceChildren(
    ...out.entries.map((e) => {
      const row = document.createElement('div');
      row.className = `console-row ${e.payload.level}`;
      const ts = document.createElement('span');
      ts.className = 'ts';
      ts.textContent = `${(e.tsMono / 1000).toFixed(2)}s`;
      row.append(ts, document.createTextNode(e.payload.text));
      return row;
    }),
  );
}

// ---------------------------------------------------------------------------
// Storage panel
// ---------------------------------------------------------------------------

interface StorageEntry {
  key: string;
  value: string;
  firstSetTsMono?: number;
}

async function renderStorage(): Promise<void> {
  const stateEl = $('#storage-state');
  const trailEl = $('#storage-trail');
  if (!activeSession) {
    stateEl.replaceChildren();
    trailEl.replaceChildren();
    return;
  }
  try {
    const state = (await core.query('storage.state', { sessionId: activeSession })) as {
      localStorage: StorageEntry[];
      sessionStorage: StorageEntry[];
      cookies: Array<{ name: string; value: string; httpOnly?: boolean }>;
    };
    const group = (title: string, rows: Array<{ k: string; v: string; note?: string }>) => {
      const frag = document.createDocumentFragment();
      const h = document.createElement('div');
      h.className = 'storage-group';
      h.textContent = `${title} (${rows.length})`;
      frag.append(h);
      for (const { k, v, note } of rows) {
        const row = document.createElement('div');
        row.className = 'storage-row';
        const key = document.createElement('span');
        key.className = 'key';
        key.textContent = note ? `${k} ${note}` : k;
        const val = document.createElement('span');
        val.className = 'val';
        val.textContent = v;
        val.title = v;
        row.append(key, val);
        frag.append(row);
      }
      return frag;
    };
    stateEl.replaceChildren(
      group('localStorage', state.localStorage.map((e) => ({ k: e.key, v: e.value }))),
      group('sessionStorage', state.sessionStorage.map((e) => ({ k: e.key, v: e.value }))),
      group(
        'cookies',
        state.cookies.map((c) => ({ k: c.name, v: c.value, note: c.httpOnly ? '(HttpOnly)' : undefined })),
      ),
    );

    const trail = (await core.query('storage.trail', { sessionId: activeSession, limit: 100 })) as {
      ops: Array<{ tsMono: number; payload: { area: string; op: string; key?: string } }>;
    };
    trailEl.replaceChildren(
      ...trail.ops.reverse().map((o) => {
        const row = document.createElement('div');
        row.className = 'trail-row';
        const op = document.createElement('span');
        op.className = `op-${o.payload.op}`;
        op.textContent = o.payload.op.toUpperCase().padEnd(7, ' ');
        row.append(
          document.createTextNode(`${(o.tsMono / 1000).toFixed(2)}s `),
          op,
          document.createTextNode(` ${o.payload.area}${o.payload.key ? ` · ${o.payload.key}` : ''}`),
        );
        return row;
      }),
    );
  } catch {
    stateEl.textContent = 'Storage state unavailable for this tab.';
  }
}

// ---------------------------------------------------------------------------
// Perf panel: resource samples + build status
// ---------------------------------------------------------------------------

async function renderPerf(): Promise<void> {
  const samplesEl = $('#perf-samples');
  const buildEl = $('#perf-build');
  if (!activeSession) {
    samplesEl.replaceChildren();
    buildEl.replaceChildren();
    return;
  }
  const out = (await core.query('resources.samples', {
    sessionId: activeSession,
    kinds: ['heapBytes', 'domNodes', 'listeners'],
  })) as { samples: Array<{ kind: string; value: number }> };
  const latest = new Map<string, number>();
  for (const s of out.samples) latest.set(s.kind, s.value);
  const fmt = (kind: string, label: string, unit: (n: number) => string) => {
    const line = document.createElement('div');
    line.className = 'sample-line';
    const v = latest.get(kind);
    line.innerHTML = `<span>${label}</span><span class="v">${v !== undefined ? unit(v) : '—'}</span>`;
    return line;
  };
  samplesEl.replaceChildren(
    fmt('heapBytes', 'JS heap', (n) => formatBytes(n)),
    fmt('domNodes', 'DOM nodes', (n) => String(n)),
    fmt('listeners', 'Event listeners', (n) => String(n)),
  );

  const build = (await core.query('build.status', {})) as {
    statuses: Array<{ port: number; state: string; tool?: string; lastBuildMs?: number }>;
  };
  buildEl.replaceChildren(
    ...build.statuses.map((s) => {
      const row = document.createElement('div');
      row.className = 'build-row';
      row.innerHTML = `:${s.port} <span class="${s.state}">${s.state}</span>${s.tool ? ` · ${s.tool}` : ''}${s.lastBuildMs ? ` · ${Math.round(s.lastBuildMs)}ms` : ''}`;
      return row;
    }),
  );
  if (build.statuses.length === 0) buildEl.innerHTML = '<p class="hint">No build activity sniffed yet.</p>';
}

async function renderPanels(): Promise<void> {
  await Promise.all([renderNetwork(), renderConsole(), renderStorage(), renderPerf()]);
}

// ---------------------------------------------------------------------------
// Command palette (Cmd+K) — dispatches through the same action registry as MCP
// ---------------------------------------------------------------------------

interface PaletteAction {
  id: string;
  title: string;
}

let paletteActions: PaletteAction[] = [];
let paletteFiltered: PaletteAction[] = [];
let paletteSel = 0;

async function openPalette(): Promise<void> {
  const list = (await core.query('actions.list', {})) as { actions: PaletteAction[] };
  paletteActions = list.actions;
  paletteFiltered = paletteActions;
  paletteSel = 0;
  $('#palette').classList.remove('hidden');
  const input = $<HTMLInputElement>('#palette-input');
  input.value = '';
  input.focus();
  renderPaletteResults();
}

function closePalette(): void {
  $('#palette').classList.add('hidden');
}

function renderPaletteResults(): void {
  const results = $('#palette-results');
  results.replaceChildren(
    ...paletteFiltered.map((a, i) => {
      const item = document.createElement('div');
      item.className = `palette-item ${i === paletteSel ? 'sel' : ''}`;
      item.innerHTML = `<span class="title">${a.title}</span><span class="id">${a.id}</span>`;
      item.addEventListener('click', () => void runPaletteAction(a));
      return item;
    }),
  );
}

async function runPaletteAction(action: PaletteAction): Promise<void> {
  closePalette();
  // Actions needing args (sessionId etc.) default to the active session; those
  // needing more are dispatched with what we have and surface errors in console.
  try {
    await core.command('act.dispatch', {
      actionId: action.id,
      args: activeSession ? { sessionId: activeSession } : {},
    });
  } catch {
    /* arg-requiring actions show their error in the console panel */
  }
  await renderPanels();
}

document.addEventListener('keydown', (evt) => {
  if ((evt.metaKey || evt.ctrlKey) && evt.key === 'k') {
    evt.preventDefault();
    if ($('#palette').classList.contains('hidden')) void openPalette();
    else closePalette();
    return;
  }
  if ($('#palette').classList.contains('hidden')) return;
  if (evt.key === 'Escape') closePalette();
  else if (evt.key === 'ArrowDown') {
    paletteSel = Math.min(paletteSel + 1, paletteFiltered.length - 1);
    renderPaletteResults();
  } else if (evt.key === 'ArrowUp') {
    paletteSel = Math.max(paletteSel - 1, 0);
    renderPaletteResults();
  } else if (evt.key === 'Enter') {
    const selected = paletteFiltered[paletteSel];
    if (selected) void runPaletteAction(selected);
  }
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

for (const btn of document.querySelectorAll<HTMLButtonElement>('#panel-tabs button')) {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#panel-tabs button').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    $(`#panel-${btn.dataset.panel}`).classList.add('active');
  });
}

$('#reload-btn').addEventListener('click', () => {
  if (activeSession) void core.command('targets.reload', { sessionId: activeSession });
});

$('#console-copy').addEventListener('click', () => {
  void navigator.clipboard.writeText(lastConsoleText);
});

$('#network-copy').addEventListener('click', () => {
  void navigator.clipboard.writeText(lastNetworkText);
});

$('#network-ts-toggle').addEventListener('click', () => {
  showNetTs = !showNetTs;
  try {
    localStorage.setItem('lc.net.showTs', showNetTs ? '1' : '0');
  } catch {
    /* session-only */
  }
  $('#network-ts-toggle').classList.toggle('active', showNetTs);
  $('#network-rows').classList.toggle('show-ts', showNetTs);
});
$('#network-ts-toggle').classList.toggle('active', showNetTs);

$('#sidebar-btn').addEventListener('click', () => {
  // Returned state is authoritative — self-heals drift from palette/MCP toggles.
  void core.command('view.sidebar', {}).then((r) => {
    document.body.classList.toggle('sidebar-hidden', !(r as { visible: boolean }).visible);
  });
});

$('#palette-input').addEventListener('input', (evt) => {
  const q = (evt.target as HTMLInputElement).value.toLowerCase();
  paletteFiltered = q
    ? paletteActions.filter((a) => a.title.toLowerCase().includes(q) || a.id.toLowerCase().includes(q))
    : paletteActions;
  paletteSel = 0;
  renderPaletteResults();
});

void refreshServers();
void refreshTabs();
setInterval(() => void refreshServers(), 3000);
