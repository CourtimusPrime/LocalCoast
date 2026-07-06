# LocalCoast — Complete Implementation Plan

## Context

LocalCoast (spec: `PLAN.md`) is a desktop application for browsing and inspecting localhost dev servers — a unified surface replacing browser DevTools + terminal output + ad-hoc debugging utilities, serving humans and coding agents as co-primary users. This document contains the architecture decisions with committed tradeoffs, the shared infrastructure layer, feature ordering with dependencies, and the phase breakdown with model routing. The companion `CLAUDE.md` carries the project's non-negotiable invariants.

Binding constraints honored throughout: desktop app target; network interception evaluated and committed; framework state access decided; MCP first-class from phase 2 (before any UI panel exists); shared infrastructure identified before feature scoping; every meaningful tradeoff stated and committed; implementation steps only after architecture is complete; cheaper-model delegation identified per phase.

---

## 1. Architecture Decisions and Rationale

### AD-1 — Desktop shell: Electron with one `WebContentsView` per guest tab

**Tradeoff:** ~100 MB+ install and one Chromium renderer process per tab, versus Tauri's small footprint but system webviews.
**Decision:** Electron. Guest servers render in `WebContentsView`s (not the deprecated-path `<webview>` tag) inside a single `BrowserWindow`; split view is multiple views laid out by the host. Each guest gets a raw Chrome DevTools Protocol (CDP) session via `webContents.debugger.attach('1.3')`.
**Rationale:** Instrumentation fidelity _is_ the product. CDP is the only cross-platform way to get network bodies, WebSocket frames, SSE events, request interception (`Fetch` domain), per-tab screenshots/screencast even when occluded, heap/DOM/listener counters, and guaranteed pre-load script injection (`Page.addScriptToEvaluateOnNewDocument`).
**Rejected:** Tauri — WKWebView on macOS has no CDP, killing network capture, mocking, screencast, and heap metrics on the primary dev platform (WebView2 on Windows does have CDP, so Tauri means three divergent instrumentation backends). CEF/Qt — native embedding burden. puppeteer-driving-external-Chrome — cannot embed the browser into the app's tab/split-view UI without per-OS window-reparenting hacks.
**Hard constraint to design around:** only one debugger client may attach per `WebContents` — this forces the CDP multiplexer (infra #2) and means LocalCoast's panels replace guest DevTools rather than coexisting with them.

### AD-2 — Network interception: CDP `Network` (always-on, passive) + `Fetch` (activated only while mocks/rewrites exist)

**Evaluation summary:**

| Criterion                               | CDP Network+Fetch         | MITM proxy                             | fetch/XHR patch        | Service-worker injection      |
| --------------------------------------- | ------------------------- | -------------------------------------- | ---------------------- | ----------------------------- |
| Zero-config (servers not spawned by us) | ✅                        | ⚠️ webview-only proxy                  | ✅                     | ⚠️ collides with app's own SW |
| Bodies / WS frames / SSE                | ✅ / ✅ / ✅              | ✅ / ⚠️ / ⚠️                           | ⚠️ / ⚠️ / ⚠️           | fetches only / ❌ / ⚠️        |
| Timing + initiator JS stack             | ✅                        | ❌                                     | ⚠️                     | ❌                            |
| Mocking + replay                        | ✅ `Fetch.fulfillRequest` | ✅                                     | ⚠️ subresources missed | fetches only                  |
| Server→server traffic                   | ❌                        | ❌ (unless servers opt into proxy env) | ❌                     | ❌                            |
| HTTPS localhost                         | ✅ (pre-TLS)              | ❌ needs MITM CA trust                 | ✅                     | ✅                            |
| App with its own service worker         | ✅ (attach SW target)     | ❌ cache-served invisible              | ❌                     | ❌ collision                  |

**Decision:** CDP primary. `Network.enable` with enlarged buffers, eager `getResponseBody` on `loadingFinished` (bodies evict from Chromium buffers — persist immediately). `Fetch.enable` only while mock/header-rewrite/auth-injection patterns are active (it pauses every matched request; keep it opt-in per URL pattern). `Target.setAutoAttach` (flattened) captures OOPIFs, workers, and service-worker targets, so SW-served responses are captured and labeled. Self-signed HTTPS handled by `setCertificateVerifyProc` trusting `localhost`/`127.0.0.1` in the guest partition only.
**Request Replay:** host-side engine using `undici`, cookies hydrated via CDP `Storage.getCookies`; an "in-page replay" mode (`Runtime.evaluate` fetch) when `HttpOnly`-credentialed / SW-path semantics matter. Response diff computed by the diff engine and returned inline.
**What CDP cannot see (explicit):** (1) server→server traffic — supplemented in tiers: client-observed edges + `lsof` ESTABLISHED sampling at zero config; Node agent outbound `http`/`undici` hooks at Tier 2; OTel spans if the app already exports them. (2) Traffic from non-instrumented clients (curl, phones). (3) DB wire protocols (AD-8). (4) Sending frames into an existing page WebSocket — no CDP method; covered by the page agent's main-world `WebSocket` constructor wrap keeping a socket registry.
**Rejected as primary:** MITM proxy (CA trust ceremony, no initiator stacks, blind to SW cache and to server→server anyway); monkey-patching (subresource-blind, fragile, app-observable); SW injection (collides with the app's own service worker, can't see WebSockets).

### AD-3 — Framework state access: layered adapter (devtools hooks + official backends + store integration + best-effort hook state)

**Decision:** one `FrameworkAdapter` interface (`getTree`, `resolveNodeToInstance`, `readState`, `writeState`, `onCommit`) with four layers:

- **L1 — Component tree:** inject `__REACT_DEVTOOLS_GLOBAL_HOOK__` / `__VUE_DEVTOOLS_GLOBAL_HOOK__` shims pre-load in the main world; embed the official backends (`react-devtools-core`, `@vue/devtools-kit`) rather than hand-rolling fiber walking; Svelte via its dev-mode DOM events (`SvelteRegisterComponent`, `__svelte_meta`).
- **L2 — Source path resolution (Component Selection):** fast paths — React `fiber._debugSource` (dev builds, **removed in React 19** — never a dependency), Vue `type.__file`, Svelte `element.__svelte_meta.loc`. Universal fallback covering React 19: DOM node → framework instance → component function → CDP `Runtime.getProperties` → `[[FunctionLocation]]` → source map → repo-relative path.
- **L3 — Stores (the _reliable_ snapshot/restore + time-travel tier):** impersonate `__REDUX_DEVTOOLS_EXTENSION__` in the main world — anything wired for Redux DevTools (Redux, Zustand devtools middleware, others) connects to us, giving full action streams, serialized state, and `JUMP_TO_STATE` for true time travel. Pinia via its devtools hook (`$subscribe` / `$patch`).
- **L4 — Arbitrary hook/instance state (best-effort, explicit semantics):** read via bounded-depth cycle-safe serialization with typed placeholders (`[Function]`, `[DOMNode]`); restore only via `overrideHookState` (React dev) / `setupState` assignment (Vue), matched by stable component path. Every restore returns a per-item report: `restored | skipped:unserializable | skipped:unmatched | skipped:prod-build`. Refs, closures, effects are never restored. Production builds degrade to L3 + storage/URL/forms with a visible "production build — read-only" badge.

**Snapshot contents:** URL+params, local/sessionStorage, cookies (incl. HttpOnly via CDP), L3 store states, L4 best-effort hook state, form inputs + scroll (page agent). Restore order: navigate → hydrate storage pre-load → mount → stores → hook overrides → forms/scroll.
**Time travel pipeline:** commit hooks + store subscriptions + `history` patch + storage trail → in-page incremental diffs (never full-tree serialization per commit), rAF-coalesced, → event store timeline. Client-state only; server side effects are not rewound (optional pairing with mock intercepts replaying recorded GET responses — no determinism promised beyond that).
**Rejected:** custom fiber walking as primary (maintenance treadmill React owns); store-only (loses component tree and Component Selection); Svelte store restore (no global registry — declared unsupported, honestly).

### AD-4 — Injected page agent: two-world script, injected via CDP, communicating over `Runtime.addBinding`

**Decision:** two `addScriptToEvaluateOnNewDocument` registrations per target, guaranteed to run before app code:

- **Main world** (same-realm patching is unavoidable here): `Storage.prototype` patch + `Proxy` via `defineProperty(window,'localStorage')` to catch index-style access; `document.cookie` accessor wrap; `WebSocket` constructor wrap (registry → send-into-socket); `history` patch; devtools hook shims + Redux shim; i18n probes. Every storage op logs `{op, key, size, ts, trimmedStack}` — the usage trail. Pristine natives (`JSON`, `Map`, `Reflect`) captured at bootstrap before app code can pollute prototypes.
- **Isolated world** (default home): overlays (perf HUD, focus order, coverage tint, a11y highlights) in a closed `ShadowRoot` with `pointer-events:none`; axe-core execution; right-click hit-testing; scenario recording (capture-phase listeners + selector synthesis preferring `data-testid`); form capture (passwords opt-in only).

**Host communication:** `Runtime.addBinding` — a stable isolated-world binding plus a nonce-named main-world binding whose reference is captured into a closure then deleted from `window`. Events batch through a ring buffer flushed per-rAF. Page-agent traffic goes **directly to main via CDP**, never through the renderer.
**Security posture:** injection is runtime-only into the `persist:localcoast-guest` partition — nothing ships in the user's build; the inspected page is untrusted (binding payloads schema-validated, never eval'd); patched natives keep correct `name`/`length` and spoofed `toString`, with documented honesty that pathological feature-detection can notice; overlay nodes tagged `data-localcoast` and excluded from our own DOM diffs and scenario selectors. Timestamps normalized to the host session clock at bootstrap handshake so page, network, and server events share one timeline.

### AD-5 — Headless core: UI and MCP are both thin clients of one typed capability registry

**Tradeoff:** indirection tax — every feature defines a schema'd Core method before its panel exists; slower first panel. The alternative (renderer talks to CDP/SQLite directly, MCP bolted on later) is precisely the failure mode the constraints prohibit.
**Decision:** a single in-process Core exposing `query` / `command` / `subscribe`, every method registered in a **capability registry** with Zod input/output schemas, a description (doubling as the MCP tool description), and a `surfaces: {mcp, palette}` flag.
**Anti-drift rules (mechanically enforced):**

1. The renderer preload exposes exactly three IPC channels — `core:query`, `core:command`, `core:subscribe`. No CDP, SQLite, or fs access from the renderer. Panels _cannot_ bypass Core because no other channel exists.
2. `surfaces.mcp` defaults to `true`; CI fails if any capability opts out without a written `mcpExclusionReason`.
3. Definition of done for any feature = registry entries + generated MCP tool + palette action (if user-invokable) + panel. **Panel last.**
4. Parity tests: each panel declares its registry dependencies; a harness runs those queries through the real MCP HTTP transport and asserts schema-identical results to the in-process path.
5. Every command logs an `action` event with `actor: ui | mcp | palette`; agent actions render with a badge in the UI timeline — MCP visible _in_ the product.

### AD-6 — Session event store: better-sqlite3 (WAL) in a worker thread + in-memory hot ring

**Tradeoff:** in-memory ring + JSON — fast but named snapshots must survive restarts, cross-session diffing needs queryable history, and continuous sampling overflows any ring. LevelDB — no secondary indexes; every correlation (traceId, epoch, time-range) hand-rolled. better-sqlite3 — native module rebuilds and a synchronous API, but real indexes and SQL joins for exactly the correlations the spec demands.
**Decision:** better-sqlite3 in a dedicated `worker_thread` (writes micro-batched ~16 ms/200 events), DB at `~/.localcoast/data/<projectHash>/events.db`; write-through hot ring (last ~90 s per target) serving live subscriptions and the last-60-seconds bug bundle with zero DB reads.
**Schema spine:** `sessions` (one per target attach; meta: git sha, env, framework) → `events` (monotonic id, `epoch`, `ts_wall` + `ts_mono`, dotted `type` taxonomy, `actor`, nullable `request_id`/`trace_id`/`span_id` correlation keys, JSON payload, out-of-row `blob_id`) + `blobs` (content-addressed, refcounted) + `samples` (fixed-shape high-frequency series: heap/DOM/listeners/fps — kept out of `events`) + `snapshots` (named, pinnable, anchored to an `event_id_at_capture`).
**Epoch semantics (resolves the spec's scoping):** `epoch` increments on explicit refresh only — SPA route changes do not. The Network panel's "persists across page changes; resets on refresh" is the default filter `epoch = current` — a **view filter, never a deletion** — so time travel and diff mode scrub across epochs freely.
**Retention:** size-targeted (default 1.5 GB/project): samples roll up raw→1s→10s→60s (continuous 1 Hz sampling <10 MB/day); blobs LRU-evict first (envelope survives with `blobEvicted: true`); whole old sessions pruned oldest-first, except ±30 s around pinned snapshots and sessions referenced by saved diff baselines.

### AD-7 — MCP: streamable HTTP served from the Electron main process; tools code-generated from the registry

**Tradeoff:** stdio subprocess is the zero-config default MCP clients know — but the client would spawn a _second_ headless instance fighting the running GUI for ports and CDP targets. HTTP requires discovery + auth but attaches N clients to the one live instance whose tabs, mocks, and snapshots are what the human is looking at.
**Decision:** streamable HTTP at `http://127.0.0.1:4820/mcp` (fallback to scanned free port), per-run bearer token, `Origin`/`Host` validation (anti-DNS-rebinding). A thin stdio shim (`localcoast mcp-stdio` in the CLI package) reads discovery, launches-or-focuses the app, and proxies stdio↔HTTP for stdio-only clients.
**Discovery (layered):** `~/.localcoast/instance.json` (url/port/pid/token, pid-staleness-checked); per-project `.localcoast/mcp.json` (gitignored via generated `.gitignore` — committable artifacts like profiles/fixtures live beside it and are _not_ ignored); `localcoast install-mcp` emitting the `claude mcp add --transport http ...` command.
**Tool taxonomy (~28 tools, generated — no hand-written tool bodies):**

- `lc_observe` → `session.observe`: the spec's Observation API — one composite call returning a11y tree + component tree + in-flight requests + recent console + URL/viewport/build status.
- `lc_observe_network|console|storage|resources|errors|build|hmr|auth|services|timeline` → corresponding Core queries.
- `lc_act_navigate|click|type|screenshot|record|replay_request|set_mock|snapshot|restore|inject_auth|run_test|load_fixture|dispatch` — `lc_act_dispatch` targets the palette action registry, making every palette action agent-reachable without dedicated tools.
- `lc_assert_run|wait_for|diff_begin|diff_end|reload_ok|a11y` — `lc_assert_reload_ok` answers "did the dev server pick up my change, hot or full reload"; `lc_assert_wait_for` polls an assertion to timeout (agent loops are request/response shaped; no MCP subscriptions in v1).
- `lc_manage_targets|sessions|export_bundle|actions_list` — targets exposes an optional advisory lease for agents wanting exclusive interaction during a scenario.
  **Multi-client:** all clients are peers; commands serialize per target through one queue; actor attribution makes human and agent actions mutually visible.

### AD-8 — Server-side data: three explicit acquisition tiers; the wrapper is an upgrade, never a requirement

**Decision:** every panel badges its current tier and offers a one-click upgrade path.

- **Tier 0 — zero-config:** port/process discovery (`lsof -iTCP -sTCP:LISTEN` → pid → cmdline/cwd); env-at-spawn via `ps eww` (macOS) / `/proc/<pid>/environ` (Linux); **HMR WebSocket sniffing** — the guest page's Vite/webpack/Next HMR socket already flows through our CDP WS capture, giving Build Status, Hot Reload Timeline, and build error payloads with zero setup; `lsof` ESTABLISHED sampling for coarse service-dependency edges; our own health pings; read-only Docker socket + PM2 home dir; an **OTLP receiver on 4317/4318** (bind-with-fallback if the user runs a real collector) lighting up Distributed Traces and DB spans for apps already exporting OTel. Explicitly _not_ available at T0: stdout of processes we didn't spawn, true runtime env, DB queries (absent OTel), test results.
- **Tier 1 — project-dir access** (root usually inferable from pid cwd, user confirms): `.env` parsing with framework precedence → attribution by matching `ps` env values to file contents; missing-var detection vs `.env.example`; config/monorepo intelligence + fs-watch; source-map root mapping; bundle manifests; one-line opt-in `@localcoast/reporter` for Vitest/Jest/Playwright; log-file tailing.
- **Tier 2 — wrapper (`localcoast run <cmd>`) and/or Node agent (`NODE_OPTIONS=--require @localcoast/node-agent`):** PTY-owned stdout (server console logs, structured log parsing), exact runtime env, safe one-click restart (we own the process); agent hooks on `pg`/`mysql2`/Prisma (`$on('query')`) with `AsyncLocalStorage` stacks → DB Query Inspector with N+1 detection; outbound `http`/`undici` patch → full-fidelity service graph; EXPLAIN via the app's own connection behind explicit user confirmation.
  **Rejected:** mandatory wrapper (violates the auto-detect product premise); ptrace/dtrace stdout attachment (SIP, non-portable); mandatory MITM for server traffic (AD-2 rationale).

### AD-9 — Process model and repo layout

**Decision:** Core runs **in the Electron main process** with hot paths off-thread (SQLite writer in a worker; diff/schema-inference in a worker pool). The package boundary makes later extraction to a daemon a host swap, not a rewrite — revisit only if profiling demands.
pnpm workspace + turborepo:

```
packages/
  protocol-types/   # Zod schemas ONLY: event taxonomy, query/command/sub IO, registry
                    # types, discovery/fixture/profile formats. Zero runtime deps.
  core/             # Headless core: event store, capability registry, engines (snapshot,
                    # diff, schema-inference, assertion), services. Depends on injected
                    # interfaces: CdpTransport, FileSystem, Clock, ProcessInspector.
                    # NO electron import — enforced by eslint no-restricted-imports.
  page-agent/       # Injected IIFE: framework adapters, overlays, scenario recorder,
                    # storage instrumentation. Tested in plain Chromium via Playwright.
  mcp/              # Streamable-HTTP server + stdio adapter + tool codegen from registry.
  desktop/          # Electron: main (hosts core+mcp, real adapters, cdp-mux), renderer
                    # (panels), preload. The ONLY package importing electron.
  cli-wrapper/      # `localcoast` bin: run-wrapper, node-agent, mcp-stdio shim, install-mcp.
```

**Testability is the boundary justification:** `core` gets its full suite on Node with a fake `CdpTransport` replaying recorded CDP fixtures + tempfile SQLite; `mcp` parity tests exercise generated tools over real HTTP; `page-agent` runs in headless Chromium without Electron; `desktop` reduces to glue with a handful of Playwright-Electron smoke tests.

### AD-10 — Committable artifacts and the tunnel

`.localcoast/` in the user's repo holds committable JSON artifacts — port profiles, fixtures, assertion suites, named scenarios — with schemas in `protocol-types` (the compatibility contract). Session sharing tunnels the guest port through a relay and serves the Core API remotely so the recipient gets live DevTools attached — one more reason the Core must never assume same-process callers. Single consumer → deliberately _not_ shared infrastructure; isolated behind `tunnel.open/close`, ships late. Default provider: bundled cloudflared quick tunnel, behind a pluggable interface.

---

## 2. Shared Infrastructure Layer (build before individual features)

| #   | Infrastructure                                                                                                                                                                                                                            | Consumed by (spec features)                                                                                                                                                                                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Session event store** (AD-6)                                                                                                                                                                                                            | Network panel; Console; Storage trail; Time Travel; Bug Bundles; Cross-session request diffing; Memory monitoring; HMR timeline; Bundle tracker; Test↔network/console linkage; Log correlation; Service graph; OAuth visualizer; Error aggregation; Split-view cross-timestamps |
| 2   | **CDP session manager (`cdp-mux`)** — single attach per WebContents, domain multiplexing, `Target.setAutoAttach` for iframes/workers/SWs, reconnect on crash/nav, `Fetch.enable` arbitration (mocks vs replay vs auth-injection share it) | Network capture; Mocks; Replay; Console; Screenshots/recordings; Perf; Memory; Coverage; a11y tree; Breakpoint tester; Cookie editing; click/type input; WS/SSE                                                                                                                 |
| 3   | **Page agent + message bus** (AD-4)                                                                                                                                                                                                       | Component Selection; component tree; state capture/restore; storage trail; form capture; state diffs; i18n inspection; focus order; scenario recording; send-into-WebSocket                                                                                                     |
| 4   | **Command dispatcher / action registry** — one registry: id, title, args schema, handler = Core command, keybinding, context predicate                                                                                                    | Command Palette; keyboard shortcuts; `lc_act_dispatch`; contextual shortcut display; Port Profiles (replay "open these tabs/panels" actions)                                                                                                                                    |
| 5   | **Snapshot engine** — capture/restore {storage, cookies, framework state, URL, forms}; content-addressed                                                                                                                                  | App State Snapshots; Time Travel jumps; Diff Mode baselines; Fixtures; Scenario preconditions; Bug bundles                                                                                                                                                                      |
| 6   | **Diff engine** — DOM tree, computed-style, order-insensitive JSON body, network delta, key-value                                                                                                                                         | Diff Mode; Replay inline diff; Cross-session request diffing; Env-var diff; Schema-drift flags; Bundle-size deltas                                                                                                                                                              |
| 7   | **Overlay renderer** — page-agent shadow-DOM layer, per-overlay toggle; host-side transparent `WebContentsView` escape hatch for apps whose observers break on injected DOM                                                               | Perf overlay; Focus order; Coverage; Error surface; Component-selection highlight; Breakpoint/RTL indicator                                                                                                                                                                     |
| 8   | **Project-context service** — root detection per port (pid cwd), `.env` parse/watch, workspace detection, config watcher, `.localcoast/` artifact IO                                                                                      | Env Inspector; Monorepo awareness; Config watcher; Profiles; Fixtures; Assertion suites; build-error path mapping; path relativization                                                                                                                                          |
| 9   | **Export/bundle builder** — event-range → artifact (zip/JSON/markdown) with a **redaction pass (tokens!)**                                                                                                                                | Bug bundles; Perf exports; log/storage copy-export; coverage/schema exports                                                                                                                                                                                                     |
| 10  | **Editor opener** — `vscode://`/`cursor://`/`zed://` builder + preference                                                                                                                                                                 | Error surface; Build errors; Component Selection; DB inspector; Test failures; palette jump-to-source                                                                                                                                                                           |
| 11  | **Port scanner / server registry** — periodic scan, process identification, target identity = port+project, liveness                                                                                                                      | Server List; Health dashboard; Split view; Port conflict resolver; Service graph nodes; Profiles; Build-status association; tunnel targeting                                                                                                                                    |
| 12  | **Dev-process ingestors** (one adapter interface, N adapters) — wrapper stdout parser, HMR sniffing parsers (Vite/webpack/Next), test reporters, OTLP receiver, DB-query shim, Docker/PM2 pollers                                         | Build status; HMR timeline; Build errors; Bundle tracker; server logs; Structured log parsing; Traces; DB inspector; Container status; Test integration                                                                                                                         |
| 13  | **Schema inference engine** — per-endpoint shape accumulator over stored traffic                                                                                                                                                          | API schema inference; response validation; cross-session diff normalization; GraphQL operation modeling                                                                                                                                                                         |
| 14  | **Assertion engine** — declarative check DSL over `session.observe` output                                                                                                                                                                | Assertion Runner; `lc_assert_wait_for`; Diff Mode acceptance; Scenario step verification                                                                                                                                                                                        |

---

## 3. Feature Implementation Order with Dependency Graph

### Package/infra dependency graph

```
protocol-types
   └── core ──────────────┬── mcp (tool codegen, HTTP transport)
        │                 └── desktop/main (hosts core + mcp + cdp-mux)
        │                        └── desktop/renderer (thin-client panels)
        ├── event store ◄── everything
        ├── engines: snapshot ── diff ── schema-inference ── assertion
page-agent (standalone IIFE; ← protocol-types)      cli-wrapper (← protocol-types)
```

### Feature dependency graph (arrows = "requires")

```
port scanner ──► Server List ──► tabs ──► split view
cdp-mux ──► network capture ──► Network panel ──► WS/SSE ──► GraphQL
                     │                    ├──► schema inference ──► validation flags
                     │                    ├──► replay (+diff engine)
                     │                    ├──► mocks ──► fixtures
                     │                    ├──► Token Vault ──► OAuth visualizer ──► auth injection
                     │                    └──► HMR sniffing ──► build status ──► hot-reload timeline
cdp-mux ──► console capture ──► error surface ──► error aggregation
page-agent ──► storage trail ──► Storage panel / cookie inspector
page-agent ──► framework adapters ──► Component Selection
                     └──► snapshot engine ──► time travel ──► diff mode
                                  └──► fixtures            └──► scenario playback
session.observe (a11y + tree + network + console) ──► assertion runner ──► lc_assert_wait_for
command dispatcher ──► palette ──► lc_act_dispatch
ingestors: wrapper ──► server logs / structured logs; node-agent ──► DB inspector, full service graph;
           reporters ──► test integration ──► coverage overlay; OTLP ──► traces ──► log correlation
```

### Order rationale

1. **Spine first** (types → core → MCP → shell + cdp-mux): MCP exists before any panel — structurally enforcing the first-class constraint.
2. **Network capture next**: it is the single highest-fanout data source (a dozen features consume the network store).
3. **Page agent third**: second-highest fanout, highest technical risk — early so risk retires early.
4. **Engines (snapshot/diff/assertion) before the features that compose them** (time travel, diff mode, fixtures, scenario playback).
5. **Ingestors and ecosystem panels last**: additive adapters over stable infrastructure; broad but shallow.

---

## 4. Phase Breakdown with Model Routing

Routing principle: **Fable** for novel/cross-cutting/underdetermined work (protocol multiplexing, prototype patching, restore semantics, schema/retention design) where a wrong turn is expensive to unwind. **Opus** for complex-but-pattern-established features. **Sonnet** for thin-client panels, parsers, codegen consumers, exporters, and tests against fixed contracts. Every phase's contracts land in `protocol-types` first, which is what makes the cheap-model delegation safe: Sonnet implements against schemas, not against ambiguity.

### Phase 0 — Scaffold + protocol contract _(Fable designs, Sonnet implements)_

Monorepo scaffold (pnpm + turborepo, eslint boundary rules, CI), `protocol-types`: event taxonomy, registry types, capability IO schemas, `.localcoast/` file formats.
**Fable:** event taxonomy + registry type design (everything downstream depends on it). **Sonnet:** Zod schema authoring from the agreed taxonomy, tsconfig/CI plumbing.

### Phase 1 — Headless core skeleton _(Fable)_

Capability registry + dispatch; event store (SQLite worker, hot ring, epoch semantics, retention); fake `CdpTransport` fixture harness.
**Fable:** registry ergonomics, store schema, retention/rollup logic, harness design. **Sonnet:** rollup queries, fixture recording utilities, store unit tests.

### Phase 2 — MCP server _(Fable core, Sonnet periphery)_ — before any UI panel exists

Tool codegen from registry, streamable HTTP + bearer auth + origin validation, discovery files, stdio shim, parity-test harness.
**Fable:** codegen + parity harness (the anti-drift enforcement itself). **Sonnet:** stdio shim, discovery writers, `install-mcp`.

### Phase 3 — Desktop shell + CDP spine _(Fable for cdp-mux; Sonnet for UI)_

Electron shell, preload (three channels only), port scanner/server registry, `WebContentsView` tab management, **cdp-mux** (single-attach multiplexing, auto-attach, reconnect, Fetch arbitration), network capture pipeline → event store. First thin-client panels: Server List (with screencast previews), Network panel.
**Fable:** cdp-mux + Fetch arbitration + body-eviction handling. **Opus:** capture pipeline. **Sonnet:** Server List UI, Network panel UI, port scanner, tab chrome.

### Phase 4 — Page agent + framework adapters _(Fable — highest-risk phase)_

Two-world injection, main-world patches (storage/cookie/WS/history), binding transport, devtools hook shims + embedded backends, `FrameworkAdapter` ×3, Component Selection end-to-end, overlay renderer base.
**Fable:** everything main-world, adapter semantics, L2 source resolution. **Sonnet:** overlay visual components, storage panel UI, selection UX polish.

### Phase 5 — Network suite depth _(Opus primary, Sonnet panels)_

Replay engine (+inline diff), mock intercepts + named fixtures, WS/SSE inspector (incl. send-into-socket via agent registry), GraphQL rendering, schema inference + validation flags, error surface (sourcemapped, editor-opener), Token Vault, cookie edit-in-place, OAuth visualizer, auth state injection.
**Opus:** replay engine, schema inference, OAuth chain reconstruction. **Sonnet:** all panels, JWT decode/countdown UI, editor opener, GraphQL/WS rendering, export buttons.

### Phase 6 — State engines: snapshots, time travel, diff _(Fable engines, Sonnet UI)_

Snapshot engine (capture/restore ordering, restore reports), time-travel diff pipeline + scrubber, diff engine (DOM/style/JSON/network).
**Fable:** restore semantics, incremental diff pipeline, diff algorithms. **Sonnet:** timeline scrubber UI, snapshot manager panel, diff visualizations.

### Phase 7 — Agent-native surface _(Fable for composite + DSL, Sonnet for panels)_

`session.observe` composite (a11y tree + component tree + in-flight + console in one call, with size budgets), assertion engine + runner + `wait_for`, Diff Mode (auto end-capture on HMR-sniffed reload), scenario recorder/playback via CDP Input.
**Fable:** observe composition/budgeting, assertion DSL, diff-mode lifecycle. **Sonnet:** assertion sidebar, scenario editor UI.

### Phase 8 — Server-side ingestors _(Opus primary)_

`localcoast run` wrapper (PTY, restart), Node agent (require hooks: DB drivers, Prisma, outbound http), HMR sniff parsers per framework, OTLP receiver, `@localcoast/reporter` for Vitest/Jest/Playwright, Docker/PM2 pollers, structured log parsing. Tier badges + upgrade-path UX.
**Opus:** node agent hooks + AsyncLocalStorage attribution, wrapper PTY. **Sonnet:** HMR payload parsers, log parsers, reporters, pollers, all panels (build status, build errors, HMR timeline, DB inspector, test integration, traces, container status).

### Phase 9 — Sensing panels _(Sonnet primary, Opus for tracing)_

Perf overlay (CDP Performance/Tracing + PerformanceObserver + per-component render timing from commit hooks), memory/resource sampling timeline, a11y audit (axe re-run on nav/HMR), focus-order visualizer, translation coverage, error aggregation/grouping, service graph + health dashboard, bundle tracker, coverage overlay.
**Opus:** tracing integration, per-component render attribution. **Sonnet:** everything else — these are adapters + panels over finished infrastructure.

### Phase 10 — Collaboration + DX polish _(Sonnet primary, Opus for tunnel)_

Command palette UI (dispatcher exists since phase 3), split view + shared-clock event interleaving, bug report bundles (redaction pass!), port profiles, fixtures composition (mocks+auth+snapshot), breakpoint tester + RTL, port conflict resolver, monorepo awareness, config watcher + restart (Tier-2-gated), session-sharing tunnel.
**Opus:** tunnel + remote Core serving. **Fable (single review):** bundle redaction rules. **Sonnet:** everything else.

### Routing summary

| Phase                   | Primary                 | Delegate to cheaper model             |
| ----------------------- | ----------------------- | ------------------------------------- |
| 0 Scaffold + contracts  | Fable (taxonomy)        | Sonnet: schemas, CI plumbing          |
| 1 Core skeleton         | Fable                   | Sonnet: queries, tests                |
| 2 MCP server            | Fable (codegen, parity) | Sonnet: shim, discovery               |
| 3 Shell + CDP spine     | Fable (cdp-mux)         | Opus: capture; Sonnet: all UI         |
| 4 Page agent + adapters | Fable                   | Sonnet: overlays, panel UI            |
| 5 Network suite         | Opus                    | Sonnet: all panels/exporters          |
| 6 State engines         | Fable                   | Sonnet: scrubber, viz                 |
| 7 Agent-native          | Fable (observe, DSL)    | Sonnet: panels                        |
| 8 Ingestors             | Opus                    | Sonnet: parsers, reporters, panels    |
| 9 Sensing panels        | Sonnet                  | Opus: tracing only                    |
| 10 Collab + polish      | Sonnet                  | Opus: tunnel; Fable: redaction review |

---

## 5. Verification

- **Phases 1–2:** core test suite + MCP parity harness on plain Node (no Electron required).
- **Phase 3:** launch the shell against 2–3 real dev servers (a Vite React app, a Next app, a plain API server) and confirm Network events reach SQLite.
- **Phase 4+:** frontend verification through the running app via the agent-browser MCP.
- **MCP surface:** point Claude Code at the discovery file and drive `lc_observe` / `lc_act_*` against a live guest app.
