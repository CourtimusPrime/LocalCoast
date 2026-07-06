# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## LocalCoast

Desktop app (Electron) for browsing and inspecting localhost dev servers. Humans and
coding agents are co-primary users. Product spec: PLAN.md. Architecture + phasing:
IMPLEMENTATION_PLAN.md — read the relevant AD-* section before touching a subsystem.
Per-phase build status, verification evidence, and committed deviations: PROGRESS.md.

## Repo layout (pnpm + turborepo)

- packages/protocol-types — Zod schemas only: event taxonomy, capability IO, file formats,
  page-agent wire contract. Zero runtime deps. Every cross-package contract is defined HERE
  first; edit these before the code that consumes them.
- packages/core — headless core: event store, capability registry + dispatch, and the
  `src/engines/` layer (diff, replay, jwt, schema-infer, assertion, redaction, log-parse,
  hmr-parse — all pure, unit-testable on plain Node). Never imports electron (eslint-enforced).
- packages/page-agent — injected two-world IIFE for guest pages. Built to string templates by
  esbuild (`scripts/build.mjs`), injected by the host with a per-target nonce binding. Tested
  in headless Chromium.
- packages/mcp — streamable-HTTP MCP server; tools are CODE-GENERATED from the registry
  (`src/codegen.ts`). Also serves the Tier-2 `/ingest` endpoint.
- packages/desktop — the only package importing electron. main = core host + cdp-mux +
  capability modules (`*-capabilities.ts`, one per feature area); renderer = thin-client
  panels; preload exposes ONLY core:query/command/subscribe.
- packages/cli-wrapper — `localcoast` bin: run-wrapper, node-agent, mcp-stdio, install-mcp.

## Non-negotiable invariants

1. Renderer panels read data ONLY via Core queries. There is no other IPC channel; do not
   add one. If a panel needs data, add a registry capability first.
2. Every registry capability is MCP-exposed by default. Opting out requires a written
   mcpExclusionReason or CI fails. Registration itself throws on a violation.
3. Definition of done for a feature: registry entries + generated MCP tool + palette
   action (if user-invokable) + panel. Panel LAST. Add a parity case (mcp/test/harness.ts)
   for any new query, or the parity suite fails.
4. Only ONE CDP debugger client can attach per WebContents — all CDP goes through
   cdp-mux. Never call webContents.debugger directly.
5. Page-agent ↔ host communication uses CDP Runtime bindings only, never the renderer.
6. Main-world guest patches must capture pristine natives at bootstrap and keep patched
   functions' name/length/toString consistent. The inspected page is UNTRUSTED: validate
   every binding payload against protocol-types schemas; never eval page-supplied data.
7. Event store writes go through the off-thread writer (see "SQLite writer" below).
   `epoch` increments only on explicit refresh. "Reset" semantics are view filters —
   never deletions.
8. Exports/bundles must pass the redaction pass (`core/src/engines/redaction.ts`) before
   leaving the process. Redact BEFORE writing to disk.

## Commands

- `just` — list all recipes (thin wrappers over the pnpm scripts below)
- `pnpm install && pnpm build` — build all packages (turbo-ordered)
- `pnpm test` — full suite; core tests run on plain Node with fake CDP fixtures
- One package: `pnpm --filter @localcoast/core test`
- One test file / name: `cd packages/core && npx vitest run test/store.test.ts -t 'epoch'`
- `pnpm --filter @localcoast/desktop dev` — launch the app
- `pnpm --filter @localcoast/mcp test:parity` — MCP/UI parity harness (run after any capability)
- `pnpm --filter @localcoast/page-agent test:chromium` — agent + framework-adapter tests
- `node packages/desktop/scripts/smoke.mjs` (`just smoke`) — the primary end-to-end check:
  launches real Electron against a real dev server and drives ~48 assertions through the
  MCP surface. Run this after any change to capture, cdp-mux, tabs, or a capability.

## Build gotchas (cost real time to rediscover)

- **SQLite writer runs off the main thread via a backend abstraction** (core/src/events/store.ts).
  Plain-Node hosts use `WorkerBackend` (worker thread); the Electron host uses
  `ChildProcessBackend` — a spawned **system-Node child process** — because better-sqlite3's
  prebuilt binary targets the Node ABI and cannot load inside Electron. That child speaks
  JSON IPC with a base64 Buffer codec (`events/ipc-codec.ts`), NOT structured-clone, because
  Electron's V8 and system Node's V8 aren't wire-compatible. Importing `writer.ts` anywhere
  the Electron main process reaches would pull the native binding in — keep it behind the
  backend.
- **Never send a CDP command before the guest renderer exists** — it never resolves. TabManager
  loads `about:blank` first, then attaches. `cdp-mux` also wraps every send in a timeout.
- **Epoch bumps are guarded against double-firing**: a LocalCoast-initiated reload bumps in
  `reload()`; guest-initiated refresh bumps in the `did-start-navigation` handler. The
  `pendingReloadBump` set prevents both firing for one reload.
- **Response bodies ride the `network.finished` event's blob**, not `network.response` —
  they're fetched eagerly on loadingFinished (Chromium evicts them from its buffers).
- **Zod 4**: use `.prefault({})` (not `.default({})`) for an object schema whose fields have
  their own inner defaults; `.default` wants a fully-formed output value.
- **pnpm build-script approvals** live in `pnpm-workspace.yaml` `allowBuilds` (esbuild,
  better-sqlite3, electron). If the electron binary is missing after install, run its
  `node_modules/electron/install.js` directly.

## Testing conventions

- New Core logic: unit tests against the fake CdpTransport / in-process store (see
  core/test/helpers.ts). Engines are pure — test them directly.
- New capability: capability test in core (or the owning package) + a parity case in
  mcp/test/harness.ts `PARITY_CASES`.
- Frontend/panel changes: the renderer is Electron-IPC-driven, so it's exercised end-to-end
  by the smoke suite. For a visual check, serve the built `packages/desktop/dist/renderer`
  with a stubbed `window.core` and open it in a browser.
- Do NOT launch Electron in unit tests; only the smoke suite does that.

## Model routing for tasks (see IMPLEMENTATION_PLAN.md §4)

cdp-mux, main-world patches, framework adapters, snapshot/restore semantics, event-store
schema changes, MCP codegen → strongest model. Panels, parsers, exporters, reporters,
tests against existing schemas → cheaper model is fine.
