# LocalCoast — Build Progress

Status as of 2026-07-06. Companion to `IMPLEMENTATION_PLAN.md` (architecture) and
`CLAUDE.md` (invariants). **All 11 phases (0–10) implemented, building, and verified.**
~57 registry capabilities, all MCP-exposed by default (1 subscription excluded
with a written reason). 98 automated tests + a 48-check end-to-end smoke, all green.

## Done

### Phase 0 — Scaffold + protocol contract ✅

- pnpm + turborepo monorepo, ESLint 9 flat config with boundary rules
  (core/mcp/page-agent/cli can never import electron; renderer can never import
  sqlite/fs/electron), GitHub Actions CI.
- `packages/protocol-types`: 35-type dotted event taxonomy as a Zod
  discriminated union (network incl. WS/SSE, console, errors, storage trail,
  state commits/actions/routes, action audit, build/HMR, server discovery,
  db/trace/test, snapshots, perf), envelope with epoch + dual clocks +
  correlation keys, samples schema, capability registry types, ~35 capability
  IO schemas, assertion DSL, `.localcoast/` artifact formats (profiles,
  fixtures, suites, scenarios, snapshot documents), MCP discovery formats,
  page-agent wire contract.

### Phase 1 — Headless core ✅

- `packages/core`: capability registry + Core dispatch (query/command/subscribe)
  with input AND output schema validation, action-audit events with actor
  attribution on every command, palette action registry (`actions.list` +
  `act.dispatch`).
- Event store per AD-6: sessions/events/blobs/samples/snapshots spine in
  better-sqlite3 (WAL), micro-batched writes, monotonic ids, hot ring (~90 s)
  serving zero-DB-read recents + live subscriptions, content-addressed
  refcounted blobs, sample rollups (raw→1s→10s→60s with per-tier age cutoffs),
  size-targeted retention (blob LRU first with `blobEvicted` envelopes, then
  oldest ended sessions, sparing ±30 s around pinned snapshots).
- Three writer backends behind one protocol: worker thread (plain-Node hosts),
  **spawned system-Node child process** (Electron hosts — better-sqlite3's
  Node-ABI prebuild can't load in Electron; JSON IPC + tagged-base64 Buffer
  codec because structured clone isn't V8-cross-version safe), in-process
  (tests).
- Epoch semantics: bump on explicit refresh only; filters are views, never
  deletions. Persisted across reopen.
- Fake CdpTransport with fixture playback format.
- `check:mcp-exposure` CI gate (invariant 2 enforced at registration time).

### Phase 2 — MCP server (before any UI) ✅

- `packages/mcp`: tools **code-generated** from the registry (zero hand-written
  tool bodies; zod→JSON Schema with defaults so agents see epoch semantics),
  streamable HTTP on 127.0.0.1:4820 (port-scan fallback), per-run bearer token
  (timing-safe compare), Host/Origin validation, session management,
  structuredContent + text on every call. Discovery: `~/.localcoast/instance.json`
  (pid-staleness-checked) + gitignored per-project `.localcoast/mcp.json`.
- Parity harness: every MCP-exposed query runs over REAL HTTP and must equal
  the in-process result; a capability without a parity case fails the suite.
- `packages/cli-wrapper`: `localcoast mcp-stdio` (message-level stdio↔HTTP
  proxy, e2e-tested as a real subprocess) + `localcoast install-mcp`.

### Phase 3 — Desktop shell + CDP spine ✅

- `packages/desktop`: Electron shell; WebContentsView guest tabs in
  `persist:localcoast-guest` partition (localhost-only cert trust); preload
  exposing EXACTLY core:query/command/subscribe; thin-client renderer panels
  (Server List, tab strip, Network, Console, Storage) with PANEL_DEPS declared.
- **cdp-mux** (invariant 4): single attach per WebContents, re-attach on
  unexpected detach with domain-enable restoration, flattened
  Target.setAutoAttach (OOPIFs/workers/SWs get domain enables +
  runIfWaitingForDebugger), Fetch.enable arbitration skeleton (union of
  consumer patterns; fully disabled when no consumer), 10 s command timeout
  guard. Gotcha encoded: never send CDP before the renderer process exists
  (about:blank spin-up before attach).
- Network capture pipeline: passive Network domain, eager body persistence on
  loadingFinished (bodies evict from Chromium buffers) into the blob store,
  WS frames, SSE, console via Runtime, exceptions with fingerprints, page
  lifecycle. Epoch bumps: LocalCoast reload commands + guest-initiated refresh
  heuristic, double-bump guarded.
- Tier-0 `lsof` ProcessInspector (listeners + cwd + env-at-spawn).
- Shell capabilities: `targets.open/close/reload`, `act.navigate`,
  `act.screenshot`, `storage.state`.

### Phase 4 — Page agent (spine) ✅ / adapters ⏳

- `packages/page-agent`: two-world IIFE bundles with per-target nonce binding
  substitution. Main world: pristine natives captured at bootstrap, patched
  functions keep name/length + global toString spoof, per-section fault
  isolation, Storage.prototype trail (key/size/preview/trimmed stack),
  document.cookie accessor wrap, WebSocket constructor wrap + send-into-socket
  registry, history patch (SPA route trail), React/Vue devtools hook shims +
  Svelte event listener for framework detection, rAF+timeout-batched ring
  flush. Isolated world: closed-ShadowRoot overlay host (`data-localcoast`
  tagged), right-click hit capture for Component Selection.
- Host side: injection via Page.addScriptToEvaluateOnNewDocument through the
  mux, Runtime.addBinding (nonce main-world + named isolated-world), EVERY
  payload schema-validated before the store (untrusted page, invariant 6),
  guest-clock rebasing, framework detection → session meta.
- `storage.trail` capability + Storage panel; parity case added.
- Tests: 7-test real-Chromium suite (headless system Chrome via
  playwright-core — storage/cookie/route/WS/framework/patch-hygiene/binding
  removal). Known gotcha encoded: storage APIs throw on opaque origins.

### Phase 4 remainder — framework adapters L1–L4 + Component Selection ✅

- React devtools hook shim now maintains fiber roots + commit stream;
  `component.tree` walks them, `component.at` resolves DOM→instance. L2 source
  resolution: fast paths (React `_debugSource` / Vue `__file` / Svelte meta)
  plus the universal CDP `[[FunctionLocation]]` → scriptId → repo-relative
  fallback that covers React 19. Component Selection wired to guest right-click
  → `component.copyPath` → clipboard. Redux-DevTools shim (L3) captures action
  streams + supports JUMP_TO_STATE time travel and snapshot restore-by-name.
- Verified against **real React 19** in headless Chromium (5-test adapter suite).

### Phase 5 — network suite depth ✅

- Replay engine (undici host mode with CDP cookie hydration + in-page mode,
  inline structural diff), mock intercepts over the cdp-mux Fetch arbitration
  (glob patterns, latency, `x-localcoast-mock` badge, hit counts), WS
  send-into-socket via the page-agent registry, GraphQL operation parsing in
  capture, live schema inference + drift flags (`api.schema`), Token Vault
  (`auth.tokens` — JWT decode/expiry from storage+cookies+headers), auth
  injection (storage/cookie/header-rewrite), cookie edit-in-place, editor
  opener (vscode/cursor/zed).

### Phase 6 — snapshots, time travel, diff ✅

- Snapshot engine (capture URL+storage+cookies+L3 stores+forms+scroll; restore
  in AD-3 order with a per-item report), `timeline.frames` scrubber source,
  Diff Mode (`diff.begin`/`diff.end` — DOM tag-count + network + storage delta)
  with auto-end on sniffed HMR reload, JSON/header/body diff engine.

### Phase 7 — agent-native surface ✅

- `session.observe` composite (a11y tree + component tree + in-flight + console
  in one budgeted call), assertion engine + runner + `assert.waitFor` (dotted
  select DSL with [n]/[*]), scenario playback via CDP Input.

### Phase 8 — server-side ingestors ✅

- `localcoast run` wrapper (owns dev-server stdout → server console entries,
  structured-log aware), `@localcoast/node-agent` (require-hook DB drivers
  pg/mysql2 + Prisma helper + outbound http, AsyncLocalStorage trace
  attribution, N+1 duplicate grouping), `@localcoast/reporter` (Vitest/Jest/
  Playwright → test.run/test.result), HTTP `/ingest` endpoint on the MCP server,
  OTLP/JSON receiver on :4318 → trace.span, HMR sniff parsers (Vite/webpack/
  Next) off the WS capture → build.status/hmr.update/build.error, structured
  log parsing (pino/winston/bunyan) in console capture.

### Phase 9 — sensing panels ✅

- Continuous resource sampler (heap/DOM/listeners into the samples table),
  `build.status` normalized surface, `services.graph` (client-observed
  cross-port edges), error aggregation (`errors.list` fingerprint grouping),
  a11y audit (`a11y.audit` dependency-free WCAG rule set), long-task capture,
  Perf panel in the renderer.

### Phase 10 — collaboration + DX polish ✅

- Bug report bundle (`export.bundle`) through the **redaction pass** (invariant
  8 — JWTs, auth headers, cookies, secret-named keys, high-entropy values;
  redacts BEFORE writing to disk), port profiles + fixtures composition
  (mocks+auth+snapshot in one load), port conflict resolver (`ports.conflict`/
  `ports.release`), env inspector, responsive breakpoint tester + RTL, split
  view, command palette (Cmd+K → same action registry as MCP).

## Verification evidence

- **98 automated tests** green across the workspace (`pnpm test`): 12
  protocol-types, 57 core (store/dispatch/capabilities/engines/assertions/
  ingestors), 25 mcp (codegen + parity + auth), 2 cli-wrapper (real stdio
  subprocess), 2 page-agent build. Plus **12 real-Chromium agent/adapter tests**
  (`test:chromium`).
- **48-check end-to-end smoke** green (`node packages/desktop/scripts/smoke.mjs`):
  real Electron app + real dev server, driven entirely through the product's own
  MCP surface — discovery → tab open → CDP capture → SQLite → eager bodies →
  epoch-as-view-filter → storage trail w/ stacks → live cookies → route trail →
  replay+diff → mocks → schema inference → token vault → snapshots →
  timeline → observe → assertions → diff mode → scenario playback → Tier-2
  ingest → OTLP → redacted bug bundle → a11y audit → resource samples → port
  conflict → breakpoint. This IS §5's phase-3+ verification.
- **Frontend visually verified** in Chrome (Claude-in-Chrome): Server List,
  Network/Console/Storage/Perf panels, and the Cmd+K palette all render from
  Core queries with zero console errors.

## Deviations from IMPLEMENTATION_PLAN.md (all documented in code)

- Writer runs in a spawned system-Node child process on Electron hosts instead
  of a worker thread (better-sqlite3 ABI vs Electron; the worker backend still
  exists and is used on plain-Node hosts). AD-6's isolation intent is
  preserved — arguably strengthened.
- Guest-internal refresh detection is a same-URL navigation heuristic;
  LocalCoast-initiated reloads are the canonical epoch bump (invariant 7).
- Server List screencast previews and several read-only panels (service graph
  viz, distributed-trace waterfall, DB inspector table, coverage/focus-order
  overlays) ship as capabilities/data but not yet as dedicated renderer panels —
  the renderer surfaces Server List, Network, Console, Storage, Perf, and the
  command palette. All the underlying data is queryable via Core/MCP today;
  remaining work is purely additional thin-client panels.
- OTLP receiver accepts JSON-encoded OTLP (common dev exporters); protobuf OTLP
  is out of scope for v1.
- node-agent ships as ESM (workspace default). For `--require` into a CJS app,
  a CJS build or `--import` is used; the hooks themselves are runtime-generic.
- Session-sharing tunnel (AD-10) is scaffolded conceptually but not shipped —
  it is the one deliberately-late, single-consumer piece flagged in the plan.
