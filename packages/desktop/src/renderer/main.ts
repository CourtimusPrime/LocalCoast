/**
 * Thin-client renderer (invariant 1): every byte of data on screen came
 * through core.query / core.subscribe. Panels declare their registry
 * dependencies in PANEL_DEPS — the parity harness runs the same queries over
 * MCP HTTP and asserts identical results.
 */

import { frameworkIcon } from './framework-icons.js';

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
  serverList: ['targets.list', 'sessions.list', 'targets.preview'],
  network: ['network.list', 'network.get'],
  console: ['console.list'],
  errors: ['errors.list'],
  storage: ['storage.state', 'storage.trail'],
  perf: ['resources.samples', 'build.status'],
  components: ['component.tree', 'console.list', 'component.inspectMode'],
  palette: ['actions.list', 'act.dispatch'],
};

const core = window.core;
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

let activeSession: string | null = null;
let liveUnsub: (() => void) | null = null;

/** Show a query failure inline instead of leaving a blank panel + unhandled rejection. */
function panelError(el: HTMLElement, msg: string): void {
  const p = document.createElement('div');
  p.className = 'panel-error';
  p.textContent = msg;
  el.replaceChildren(p);
}

// ---------------------------------------------------------------------------
// Server gallery
// ---------------------------------------------------------------------------

type ServerType = 'frontend' | 'backend' | 'fullstack';

interface TargetRow {
  targetKey: string;
  port: number;
  url?: string;
  projectName?: string;
  projectRoot?: string;
  pid?: number;
  serverType?: ServerType;
  frameworkId?: string;
  frameworkHint?: string;
  cpuPercent?: number;
  memBytes?: number;
  startedAtWall?: number;
  attached: boolean;
  sessionId?: string;
}

// Preview thumbnails are fetched lazily per card via targets.preview and cached
// here so the 3s server-list rebuild repaints instantly (no flicker) and only
// re-queries when an entry goes stale.
interface PreviewCacheEntry {
  dataUrl: string | null;
  contentKind?: 'page' | 'json' | 'unknown';
  fetchedAt: number;
}
const PREVIEW_REFRESH_MS = 30_000;
const previewCache = new Map<number, PreviewCacheEntry>();
const previewInflight = new Set<number>();

function folderName(root?: string): string | undefined {
  if (!root) return undefined;
  const parts = root.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1];
}

function serverName(t: TargetRow): string {
  return t.projectName || folderName(t.projectRoot) || `localhost:${t.port}`;
}

// -- gallery filter / sort state --------------------------------------------

type SortKey = 'az' | 'za' | 'newest' | 'longest' | 'most' | 'least';
const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: 'az', label: 'A–Z' },
  { value: 'za', label: 'Z–A' },
  { value: 'newest', label: 'Newest First' },
  { value: 'longest', label: 'Longest Running' },
  { value: 'most', label: 'Most Intensive' },
  { value: 'least', label: 'Least Intensive' },
];
const TYPE_OPTIONS: Array<{ value: ServerType; label: string }> = [
  { value: 'frontend', label: 'Frontend' },
  { value: 'backend', label: 'Backend' },
  { value: 'fullstack', label: 'Fullstack' },
];

const gallery = {
  search: '',
  frameworks: new Set<string>(),
  types: new Set<ServerType>(),
  sort: 'az' as SortKey,
};
let lastTargets: TargetRow[] = [];

/** Composite "intensity" — CPU weighted heavier than normalized memory. */
function intensity(t: TargetRow): number {
  return (t.cpuPercent ?? 0) + (t.memBytes ?? 0) / (256 * 1024 * 1024);
}

function visibleTargets(): TargetRow[] {
  const q = gallery.search.trim().toLowerCase();
  let rows = lastTargets.filter((t) => {
    if (q && !serverName(t).toLowerCase().includes(q)) return false;
    if (gallery.frameworks.size && !(t.frameworkHint && gallery.frameworks.has(t.frameworkHint)))
      return false;
    if (gallery.types.size && !(t.serverType && gallery.types.has(t.serverType))) return false;
    return true;
  });
  const cmp: Record<SortKey, (a: TargetRow, b: TargetRow) => number> = {
    az: (a, b) => serverName(a).localeCompare(serverName(b)),
    za: (a, b) => serverName(b).localeCompare(serverName(a)),
    // Newest = most recent start (larger startedAtWall first).
    newest: (a, b) => (b.startedAtWall ?? 0) - (a.startedAtWall ?? 0),
    // Longest running = earliest start (smaller startedAtWall first).
    longest: (a, b) => (a.startedAtWall ?? Infinity) - (b.startedAtWall ?? Infinity),
    most: (a, b) => intensity(b) - intensity(a),
    least: (a, b) => intensity(a) - intensity(b),
  };
  rows = [...rows].sort(cmp[gallery.sort]);
  return rows;
}

// -- preview ----------------------------------------------------------------

function previewNode(port: number): HTMLElement {
  const cached = previewCache.get(port);
  if (cached?.contentKind === 'json') {
    const ph = document.createElement('div');
    ph.className = 'preview preview-json';
    ph.dataset.port = String(port);
    ph.textContent = '{/}';
    return ph;
  }
  const img = document.createElement('img');
  img.className = 'preview';
  img.alt = '';
  img.dataset.port = String(port);
  if (cached?.dataUrl) img.src = cached.dataUrl;
  return img;
}

function renderPreviewInto(wrap: HTMLElement, port: number): void {
  wrap.querySelector('.preview')?.remove();
  wrap.prepend(previewNode(port));
  const cached = previewCache.get(port);
  if (!cached || Date.now() - cached.fetchedAt > PREVIEW_REFRESH_MS) void fetchPreview(port);
}

async function fetchPreview(port: number): Promise<void> {
  if (previewInflight.has(port)) return;
  previewInflight.add(port);
  try {
    const out = (await core.query('targets.preview', { port })) as {
      available: boolean;
      base64?: string;
      mimeType?: string;
      contentKind?: 'page' | 'json' | 'unknown';
    };
    const dataUrl =
      out.available && out.base64 && out.mimeType
        ? `data:${out.mimeType};base64,${out.base64}`
        : null;
    previewCache.set(port, { dataUrl, contentKind: out.contentKind, fetchedAt: Date.now() });
    // Re-render whichever preview node is currently mounted for this port.
    const wrap = document.querySelector<HTMLElement>(`.preview-wrap[data-port="${port}"]`);
    if (wrap) renderPreviewNodeOnly(wrap, port);
  } catch {
    /* transient — allow a retry on the next poll */
  } finally {
    previewInflight.delete(port);
  }
}

/** Swap the preview node in place without re-triggering a fetch (avoids loops). */
function renderPreviewNodeOnly(wrap: HTMLElement, port: number): void {
  wrap.querySelector('.preview')?.remove();
  wrap.prepend(previewNode(port));
}

// -- card + grid ------------------------------------------------------------

/** Shrink a name's font-size until it fits maxWidth; never wraps or overflows. */
function fitText(el: HTMLElement, maxWidth: number): void {
  let size = 16;
  el.style.fontSize = `${size}px`;
  // scrollWidth reflects the unclamped text width; step down to a floor of 10px.
  while (el.scrollWidth > maxWidth && size > 10) {
    size -= 1;
    el.style.fontSize = `${size}px`;
  }
}

const TYPE_LABEL: Record<ServerType, string> = {
  frontend: 'FRONTEND',
  backend: 'BACKEND',
  fullstack: 'FULLSTACK',
};

function buildCard(t: TargetRow): HTMLElement {
  const card = document.createElement('div');
  card.className = 'server-card';

  const wrap = document.createElement('div');
  wrap.className = 'preview-wrap';
  wrap.dataset.port = String(t.port);
  renderPreviewInto(wrap, t.port);
  if (t.serverType) {
    const badge = document.createElement('span');
    badge.className = `type-badge type-${t.serverType}`;
    badge.textContent = TYPE_LABEL[t.serverType];
    wrap.append(badge);
  }

  const details = document.createElement('div');
  details.className = 'card-details';

  const icon = document.createElement('span');
  icon.className = 'fw-icon';
  icon.innerHTML = frameworkIcon(t.frameworkId);
  if (t.frameworkHint) icon.title = t.frameworkHint;

  const meta = document.createElement('div');
  meta.className = 'card-meta';
  const name = document.createElement('div');
  name.className = 'card-name';
  name.textContent = serverName(t);
  const url = document.createElement('div');
  url.className = 'card-url';
  url.textContent = (t.url || `http://localhost:${t.port}/`).replace(/\/$/, '').replace('http://', '');
  meta.append(name, url);

  const menuBtn = document.createElement('button');
  menuBtn.className = 'card-menu-btn';
  menuBtn.setAttribute('aria-label', `Actions for ${serverName(t)}`);
  menuBtn.innerHTML = ellipsisIcon();
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openCardMenu(menuBtn, t);
  });

  details.append(icon, meta, menuBtn);
  card.append(wrap, details);

  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `Open ${serverName(t)}`);
  const open = () => void openTab(t.port);
  card.addEventListener('click', open);
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  });
  // Size the name after it is in the DOM.
  requestAnimationFrame(() => fitText(name, meta.clientWidth || 150));
  return card;
}

function renderGrid(): void {
  const container = $('#server-list');
  const rows = visibleTargets();
  if (rows.length === 0) {
    const msg = lastTargets.length === 0 ? 'No listening localhost servers found yet.' : 'No servers match your filters.';
    container.innerHTML = `<p class="hint gallery-empty">${msg}</p>`;
    return;
  }
  container.replaceChildren(...rows.map(buildCard));
}

async function refreshServers(): Promise<void> {
  const { targets } = (await core.query('targets.list', {})) as { targets: TargetRow[] };
  lastTargets = targets;
  refreshFrameworkOptions();
  renderGrid();
}

function ellipsisIcon(): string {
  return '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>';
}

// -- card action menu (Open / Code / Kill) ----------------------------------

let openMenu: HTMLElement | null = null;
function closeCardMenu(): void {
  openMenu?.remove();
  openMenu = null;
}

function openCardMenu(anchor: HTMLElement, t: TargetRow): void {
  closeCardMenu();
  const menu = document.createElement('div');
  menu.className = 'card-menu';
  const item = (label: string, onClick: () => void, danger = false): HTMLElement => {
    const b = document.createElement('button');
    b.className = `card-menu-item${danger ? ' danger' : ''}`;
    b.textContent = label;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      closeCardMenu();
      onClick();
    });
    return b;
  };
  menu.append(
    item('Open', () => void core.command('targets.openExternal', { port: t.port })),
    item('Code', () => {
      if (t.projectRoot) void core.command('editor.open', { path: t.projectRoot });
    }),
    item('Kill', () => {
      void core.command('targets.kill', { port: t.port }).then(() => void refreshServers());
    }, true),
  );
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.left = `${Math.max(8, r.right - 140)}px`;
  document.body.append(menu);
  openMenu = menu;
}

// -- header toolbar: search + filter/sort dropdowns -------------------------

interface DropOpt {
  value: string;
  label: string;
}

/**
 * A chevron dropdown. multi=true → checkbox multi-select filter; multi=false →
 * single-select (sort). Menus close on outside-click (handled globally below).
 */
function buildDropdown(cfg: {
  host: HTMLElement;
  label: string;
  multi: boolean;
  options: () => DropOpt[];
  isSelected: (value: string) => boolean;
  onPick: (value: string) => void;
  summary: () => string;
}): void {
  const btn = document.createElement('button');
  btn.className = 'dropdown-btn';
  const caret = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
  const paint = () => {
    btn.innerHTML = `<span class="dropdown-label">${cfg.summary()}</span>${caret}`;
  };
  paint();
  const menu = document.createElement('div');
  menu.className = 'dropdown-menu hidden';
  const rebuild = () => {
    menu.replaceChildren(
      ...cfg.options().map((o) => {
        const row = document.createElement('button');
        row.className = 'dropdown-item';
        const on = cfg.isSelected(o.value);
        row.innerHTML = `<span class="tick">${on ? '✓' : ''}</span><span>${o.label}</span>`;
        row.addEventListener('click', (e) => {
          e.stopPropagation();
          cfg.onPick(o.value);
          paint();
          if (cfg.multi) rebuild();
          else menu.classList.add('hidden');
        });
        return row;
      }),
    );
  };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = !menu.classList.contains('hidden');
    closeAllDropdowns();
    if (!wasOpen) {
      rebuild();
      menu.classList.remove('hidden');
    }
  });
  cfg.host.append(btn, menu);
}

function closeAllDropdowns(): void {
  document.querySelectorAll('.dropdown-menu').forEach((m) => m.classList.add('hidden'));
}

/** Distinct framework labels currently present, for the Framework filter menu. */
function frameworkOptions(): DropOpt[] {
  const seen = new Set<string>();
  for (const t of lastTargets) if (t.frameworkHint) seen.add(t.frameworkHint);
  return [...seen].sort().map((f) => ({ value: f, label: f }));
}

/** Drop framework selections that no longer exist so the summary stays honest. */
function refreshFrameworkOptions(): void {
  const present = new Set(lastTargets.map((t) => t.frameworkHint).filter(Boolean) as string[]);
  for (const f of gallery.frameworks) if (!present.has(f)) gallery.frameworks.delete(f);
}

function initToolbar(): void {
  const search = $<HTMLInputElement>('#gallery-search');
  search.addEventListener('input', () => {
    gallery.search = search.value;
    renderGrid();
  });

  buildDropdown({
    host: $('#filter-framework'),
    label: 'Framework',
    multi: true,
    options: frameworkOptions,
    isSelected: (v) => gallery.frameworks.has(v),
    onPick: (v) => {
      if (gallery.frameworks.has(v)) gallery.frameworks.delete(v);
      else gallery.frameworks.add(v);
      renderGrid();
    },
    summary: () =>
      gallery.frameworks.size ? `Framework (${gallery.frameworks.size})` : 'Framework',
  });

  buildDropdown({
    host: $('#filter-type'),
    label: 'Category',
    multi: true,
    options: () => TYPE_OPTIONS,
    isSelected: (v) => gallery.types.has(v as ServerType),
    onPick: (v) => {
      const t = v as ServerType;
      if (gallery.types.has(t)) gallery.types.delete(t);
      else gallery.types.add(t);
      renderGrid();
    },
    summary: () => (gallery.types.size ? `Category (${gallery.types.size})` : 'Category'),
  });

  buildDropdown({
    host: $('#sort-by'),
    label: 'Sort by',
    multi: false,
    options: () => SORT_OPTIONS,
    isSelected: (v) => gallery.sort === v,
    onPick: (v) => {
      gallery.sort = v as SortKey;
      renderGrid();
    },
    summary: () => `Sort: ${SORT_OPTIONS.find((o) => o.value === gallery.sort)?.label ?? ''}`,
  });
}

// Global dismiss for menus/dropdowns.
document.addEventListener('click', () => {
  closeCardMenu();
  closeAllDropdowns();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeCardMenu();
    closeAllDropdowns();
  }
});

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

interface SessionRow {
  sessionId: string;
  targetKey: string;
  currentEpoch: number;
}

/**
 * Two views share one window. Gallery (no active session): the server grid +
 * search/filter/sort header, no inspection sidebar. Server (active session):
 * the guest page + inspection sidebar, header collapsed to wordmark + Back.
 */
function updateMode(): void {
  document.body.classList.toggle('mode-server', activeSession !== null);
}

async function refreshTabs(): Promise<void> {
  const { sessions } = (await core.query('sessions.list', {})) as { sessions: SessionRow[] };
  const strip = $('#tabstrip');
  strip.replaceChildren(
    ...sessions.map((s) => {
      const btn = document.createElement('button');
      btn.className = s.sessionId === activeSession ? 'active' : '';
      btn.append(document.createTextNode(s.targetKey.replace('port:', ':')));
      const close = document.createElement('span');
      close.className = 'close';
      close.textContent = '×';
      close.setAttribute('role', 'button');
      close.setAttribute('aria-label', 'Close tab');
      close.addEventListener('click', (evt) => {
        evt.stopPropagation();
        void closeTab(s.sessionId);
      });
      btn.append(close);
      btn.addEventListener('click', () => void selectSession(s.sessionId));
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
  if (activeSession === sessionId) {
    activeSession = null;
    // Drop the live subscription for the closed session (was leaking until the
    // next selectSession reassigned it).
    liveUnsub?.();
    liveUnsub = null;
  }
  updateMode();
  await Promise.all([refreshTabs(), refreshServers(), renderPanels()]);
}

async function selectSession(sessionId: string): Promise<void> {
  activeSession = sessionId;
  updateMode();
  liveUnsub?.();
  // Live refresh: any new event for this session repaints the active panel.
  let scheduled = false;
  liveUnsub = core.subscribe('events.subscribe', { sessionId }, (data) => {
    maybeClearRecording(data);
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      void renderPanels();
    }, 250);
  });
  await Promise.all([refreshTabs(), renderPanels()]);
}

/** Server-side auto-stop (tab close / maxDuration) emits a console.entry; clear
 *  the record button so it doesn't stay stuck red. */
function maybeClearRecording(data: unknown): void {
  if (uiRecordingId === null) return;
  const evt = data as { type?: string; payload?: { text?: string } };
  if (evt?.type === 'console.entry' && evt.payload?.text?.includes(`recording ${uiRecordingId} auto-stopped`)) {
    uiRecordingId = null;
    $('#record-btn').classList.remove('recording');
  }
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
  resourceType?: string;
  durationMs?: number;
  mocked?: boolean;
  fromServiceWorker?: boolean;
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
  const session = activeSession;
  let out: {
    requests: NetworkSummary[];
    totals: { uploadedBytes: number; downloadedBytes: number; requestCount: number };
  };
  try {
    out = (await core.query('network.list', { sessionId: session, limit: 200 })) as typeof out;
  } catch {
    panelError(rowsEl, 'Network capture unavailable for this tab.');
    return;
  }
  if (activeSession !== session) return; // tab switched while awaiting — stale

  totalsEl.textContent = `▲ ${formatBytes(out.totals.uploadedBytes)}   ▼ ${formatBytes(out.totals.downloadedBytes)}   ${out.totals.requestCount} requests (this epoch)`;

  // Only auto-scroll to newest if the user is already near the bottom, so live
  // traffic doesn't yank the list away while they inspect an earlier request.
  const pinnedToBottom = rowsEl.scrollHeight - rowsEl.scrollTop - rowsEl.clientHeight < 40;

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
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
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
    if (r.mocked) {
      const b = document.createElement('span');
      b.className = 'badge-mk';
      b.textContent = 'MOCK';
      url.append(b);
    }
    if (r.fromServiceWorker) {
      const b = document.createElement('span');
      b.className = 'badge-sw';
      b.textContent = 'SW';
      url.append(b);
    }
    const size = document.createElement('span');
    size.className = 'size';
    size.textContent = r.downloadedBytes !== undefined ? formatBytes(r.downloadedBytes) : '';
    row.append(status, ts, url, size);
    const open = () => void openNetDrawer(r);
    row.addEventListener('click', open);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });
    frag.append(row);
    const statusText = r.failed ? 'ERR' : (r.status ?? 'pending');
    const sizeText = r.downloadedBytes !== undefined ? ` ${formatBytes(r.downloadedBytes)}` : '';
    const durText = r.durationMs !== undefined ? ` ${Math.round(r.durationMs)}ms` : '';
    copyLines.push(`[${formatWallClock(r.startTsWall)}] ${r.method} ${r.url} ${statusText}${sizeText}${durText}`);
  }
  lastNetworkText = copyLines.join('\n');
  rowsEl.classList.toggle('show-ts', showNetTs);
  rowsEl.replaceChildren(frag);
  if (pinnedToBottom) rowsEl.scrollTop = rowsEl.scrollHeight;
}

// Network detail drawer: full request/response via network.get.
async function openNetDrawer(summary: NetworkSummary): Promise<void> {
  const drawer = $('#net-drawer');
  const body = $('#net-drawer-body');
  $('#net-drawer-title').textContent = `${summary.method} ${summary.url}`;
  drawer.classList.remove('hidden');
  body.replaceChildren();
  let detail: {
    summary: NetworkSummary;
    requestHeaders?: Record<string, string>;
    responseHeaders?: Record<string, string>;
    requestBody?: { data: string };
    responseBody?: { data: string };
  };
  try {
    detail = (await core.query('network.get', {
      requestId: summary.requestId,
      includeBodies: true,
    })) as typeof detail;
  } catch {
    panelError(body, 'Detail unavailable (request may have been evicted).');
    return;
  }
  const s = detail.summary;
  const section = (title: string, text: string) => {
    if (!text) return;
    const h = document.createElement('h4');
    h.textContent = title;
    const pre = document.createElement('pre');
    pre.textContent = text;
    body.append(h, pre);
  };
  const meta = [
    `Status: ${s.failed ? 'FAILED' : (s.status ?? 'pending')}`,
    s.resourceType ? `Type: ${s.resourceType}` : '',
    s.durationMs !== undefined ? `Duration: ${Math.round(s.durationMs)}ms` : '',
    s.downloadedBytes !== undefined ? `Downloaded: ${formatBytes(s.downloadedBytes)}` : '',
    s.mocked ? 'Mocked: yes' : '',
    s.fromServiceWorker ? 'From service worker: yes' : '',
    s.pageUrl ? `Page: ${s.pageUrl}` : '',
  ].filter(Boolean).join('\n');
  section('Overview', meta);
  const fmtHeaders = (h?: Record<string, string>) =>
    h ? Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\n') : '';
  section('Request headers', fmtHeaders(detail.requestHeaders));
  section('Request body', detail.requestBody?.data ?? '');
  section('Response headers', fmtHeaders(detail.responseHeaders));
  section('Response body', detail.responseBody?.data ?? '');
}

// ---------------------------------------------------------------------------
// Console panel
// ---------------------------------------------------------------------------

interface ConsoleEntry {
  tsMono: number;
  tsWall?: number;
  payload: { level: string; text: string; source?: string };
}

let lastConsoleText = '';
const consoleLevels = new Set(['log', 'info', 'warn', 'error', 'debug']);
let consoleSearch = '';

async function renderConsole(): Promise<void> {
  const rowsEl = $('#console-rows');
  if (!activeSession) {
    rowsEl.replaceChildren();
    return;
  }
  const session = activeSession;
  // Filter server-side where supported (levels/textFilter); debug/log map to the
  // level set the toolbar exposes.
  const levels = [...consoleLevels];
  let out: { entries: ConsoleEntry[] };
  try {
    out = (await core.query('console.list', {
      sessionId: session,
      limit: 300,
      levels,
      textFilter: consoleSearch || undefined,
    })) as typeof out;
  } catch {
    panelError(rowsEl, 'Console unavailable for this tab.');
    return;
  }
  if (activeSession !== session) return;
  lastConsoleText = out.entries
    .map((e) => `[${formatWallClock(e.tsWall ?? e.tsMono)}] [${e.payload.level}] ${e.payload.text}`)
    .join('\n');
  rowsEl.replaceChildren(
    ...out.entries.map((e) => {
      const row = document.createElement('div');
      row.className = `console-row ${e.payload.level}`;
      const ts = document.createElement('span');
      ts.className = 'ts';
      ts.textContent = e.tsWall ? formatWallClock(e.tsWall) : `${(e.tsMono / 1000).toFixed(2)}s`;
      row.append(ts);
      if (e.payload.source && e.payload.source !== 'page') {
        const src = document.createElement('span');
        src.className = 'src';
        src.textContent = e.payload.source;
        row.append(src);
      }
      row.append(document.createTextNode(e.payload.text));
      return row;
    }),
  );
}

// ---------------------------------------------------------------------------
// Errors panel: uncaught errors/rejections grouped by fingerprint (errors.list)
// ---------------------------------------------------------------------------

interface ErrorGroup {
  fingerprint: string;
  message: string;
  count: number;
  sample: { payload: { url?: string; line?: number; sourcePath?: string } };
}

async function renderErrors(): Promise<void> {
  const summaryEl = $('#errors-summary');
  const rowsEl = $('#errors-rows');
  if (!activeSession) {
    summaryEl.textContent = 'Open a server tab to surface errors.';
    rowsEl.replaceChildren();
    return;
  }
  const session = activeSession;
  let out: { groups: ErrorGroup[] };
  try {
    out = (await core.query('errors.list', { sessionId: session })) as typeof out;
  } catch {
    panelError(rowsEl, 'Errors unavailable for this tab.');
    return;
  }
  if (activeSession !== session) return;
  const total = out.groups.reduce((n, g) => n + g.count, 0);
  summaryEl.textContent = out.groups.length
    ? `${out.groups.length} error group${out.groups.length === 1 ? '' : 's'} · ${total} total`
    : 'No errors captured this epoch. 🎉';
  rowsEl.replaceChildren(
    ...out.groups.map((g) => {
      const row = document.createElement('div');
      row.className = 'error-group';
      const top = document.createElement('div');
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = String(g.count);
      const msg = document.createElement('span');
      msg.className = 'msg';
      msg.textContent = g.message;
      top.append(count, msg);
      row.append(top);
      const path = g.sample.payload.sourcePath ?? g.sample.payload.url;
      const line = g.sample.payload.line;
      if (path) {
        const loc = document.createElement('div');
        loc.className = 'loc';
        loc.textContent = line ? `${path}:${line}` : path;
        row.append(loc);
        row.title = 'Open in editor';
        row.addEventListener('click', () => {
          void core.command('editor.open', { path, line: line ?? 1 }).catch(() => {});
        });
      }
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
      const state = document.createElement('span');
      state.className = s.state;
      state.textContent = s.state;
      row.append(
        document.createTextNode(`:${s.port} `),
        state,
        document.createTextNode(
          `${s.tool ? ` · ${s.tool}` : ''}${s.lastBuildMs ? ` · ${Math.round(s.lastBuildMs)}ms` : ''}`,
        ),
      );
      return row;
    }),
  );
  if (build.statuses.length === 0) {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'No build activity sniffed yet.';
    buildEl.replaceChildren(hint);
  }
}

// ---------------------------------------------------------------------------
// Components panel: inspect-mode toggle, last picked, component tree
// ---------------------------------------------------------------------------

interface ComponentTreeNode {
  name: string;
  sourcePath?: string;
  children?: ComponentTreeNode[];
}

function componentTreeList(nodes: ComponentTreeNode[]): HTMLUListElement {
  const ul = document.createElement('ul');
  ul.className = 'component-tree';
  for (const node of nodes) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = node.name;
    li.append(name);
    if (node.sourcePath) {
      const path = document.createElement('span');
      path.className = 'component-path';
      path.textContent = ` ${node.sourcePath}`;
      li.append(path);
    }
    if (node.children?.length) li.append(componentTreeList(node.children));
    ul.append(li);
  }
  return ul;
}

async function renderComponents(): Promise<void> {
  // component.tree costs a guest Runtime.evaluate — skip while hidden.
  if (!$('#panel-components').classList.contains('active')) return;
  const pickedEl = $('#components-picked');
  const treeEl = $('#components-tree');
  if (!activeSession) {
    pickedEl.replaceChildren();
    treeEl.innerHTML = '<p class="hint">Open a server tab to inspect components.</p>';
    return;
  }
  const cons = (await core.query('console.list', { sessionId: activeSession, limit: 300 })) as {
    entries: ConsoleEntry[];
  };
  const picked = [...cons.entries]
    .reverse()
    .find((e) => e.payload.text.startsWith('Copied component path:') || e.payload.text.startsWith('Copied DOM selector:'));
  pickedEl.textContent = picked
    ? `Last picked — ${picked.payload.text.replace(/^Copied (component path|DOM selector): /, '')}`
    : 'Nothing picked yet.';

  const out = (await core.query('component.tree', { sessionId: activeSession })) as {
    framework?: string;
    tree?: ComponentTreeNode;
    truncated: boolean;
  };
  if (!out.tree) {
    treeEl.innerHTML = '<p class="hint">No framework component tree detected on this page.</p>';
    return;
  }
  treeEl.replaceChildren(componentTreeList([out.tree]));
  if (out.truncated) {
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = '(tree truncated)';
    treeEl.append(note);
  }
}

async function renderPanels(): Promise<void> {
  await Promise.all([
    renderNetwork(),
    renderConsole(),
    renderErrors(),
    renderStorage(),
    renderPerf(),
    renderComponents(),
  ]);
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
      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = a.title;
      const id = document.createElement('span');
      id.className = 'id';
      id.textContent = a.id;
      item.append(title, id);
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
  if (evt.key === 'Escape' && !$('#net-drawer').classList.contains('hidden')) {
    $('#net-drawer').classList.add('hidden');
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
    // Lazily-rendered panels (components) skip work while hidden — repaint now.
    if (btn.dataset.panel === 'components') void renderComponents();
  });
}

$('#reload-btn').addEventListener('click', () => {
  if (activeSession) void core.command('targets.reload', { sessionId: activeSession });
});

$('#console-copy').addEventListener('click', () => {
  void navigator.clipboard.writeText(lastConsoleText);
});

for (const btn of document.querySelectorAll<HTMLButtonElement>('.console-level')) {
  btn.addEventListener('click', () => {
    const level = btn.dataset.level!;
    if (consoleLevels.has(level)) consoleLevels.delete(level);
    else consoleLevels.add(level);
    // 'log' toggle also governs 'debug' (grouped in the toolbar).
    if (level === 'log') {
      if (consoleLevels.has('log')) consoleLevels.add('debug');
      else consoleLevels.delete('debug');
    }
    btn.classList.toggle('active', consoleLevels.has(level));
    void renderConsole();
  });
}

$('#console-search').addEventListener('input', (evt) => {
  consoleSearch = (evt.target as HTMLInputElement).value;
  void renderConsole();
});

const closeNetDrawer = () => $('#net-drawer').classList.add('hidden');
$('#net-drawer-close').addEventListener('click', closeNetDrawer);
$('#net-drawer').addEventListener('click', (e) => {
  if (e.target === $('#net-drawer')) closeNetDrawer(); // click backdrop
});

$('#components-inspect').addEventListener('click', () => {
  if (!activeSession) return;
  void core
    .command('component.inspectMode', { sessionId: activeSession })
    .then((result) => {
      const { enabled } = result as { enabled: boolean };
      $('#components-inspect').textContent = enabled ? 'Inspect: ON' : 'Inspect: off';
      $('#components-inspect').classList.toggle('active', enabled);
    })
    .catch(() => {});
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

let uiRecordingId: string | null = null;
$('#record-btn').addEventListener('click', () => {
  const btn = $('#record-btn');
  if (uiRecordingId === null) {
    if (!activeSession) return;
    void core.command('act.record.start', { sessionId: activeSession }).then((r) => {
      uiRecordingId = (r as { recordingId: string }).recordingId;
      btn.classList.add('recording');
    });
  } else {
    // Auto-stopped recordings resolve here too via the cached stop result.
    void core
      .command('act.record.stop', { recordingId: uiRecordingId })
      .finally(() => {
        uiRecordingId = null;
        btn.classList.remove('recording');
      });
  }
});

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

$('#back-btn').addEventListener('click', () => {
  // Return to the gallery by closing the active inspection session.
  if (activeSession) void closeTab(activeSession);
});

initToolbar();
updateMode();
void refreshServers();
void refreshTabs();
setInterval(() => void refreshServers(), 3000);
