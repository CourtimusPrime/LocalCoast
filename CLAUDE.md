# LocalCoast

Desktop app (Electron) for browsing and inspecting localhost dev servers. Humans and
coding agents are co-primary users. Product spec: PLAN.md. Architecture + phasing:
IMPLEMENTATION_PLAN.md — read the relevant AD-* section before touching a subsystem.

## Repo layout (pnpm + turborepo)

- packages/protocol-types — Zod schemas only: event taxonomy, capability IO, file formats.
  Zero runtime deps. Every cross-package contract is defined HERE first.
- packages/core — headless core: event store, capability registry, engines. Never imports
  electron (eslint-enforced). Testable on plain Node with the fake CdpTransport.
- packages/page-agent — injected IIFE for guest pages. Tested in headless Chromium.
- packages/mcp — streamable-HTTP MCP server; tools are CODE-GENERATED from the registry.
- packages/desktop — the only package importing electron. main = core host + cdp-mux;
  renderer = thin-client panels; preload exposes ONLY core:query/command/subscribe.
- packages/cli-wrapper — `localcoast` bin: run-wrapper, node-agent, mcp-stdio, install-mcp.

## Non-negotiable invariants

1. Renderer panels read data ONLY via Core queries. There is no other IPC channel; do not
   add one. If a panel needs data, add a registry capability first.
2. Every registry capability is MCP-exposed by default. Opting out requires a written
   mcpExclusionReason or CI fails.
3. Definition of done for a feature: registry entries + generated MCP tool + palette
   action (if user-invokable) + panel. Panel LAST. Update parity tests.
4. Only ONE CDP debugger client can attach per WebContents — all CDP goes through
   cdp-mux. Never call webContents.debugger directly.
5. Page-agent ↔ host communication uses CDP Runtime bindings only, never the renderer.
6. Main-world guest patches must capture pristine natives at bootstrap and keep patched
   functions' name/length/toString consistent. The inspected page is UNTRUSTED: validate
   every binding payload against protocol-types schemas; never eval page-supplied data.
7. Event store writes go through the worker-thread writer. `epoch` increments only on
   explicit refresh. "Reset" semantics are view filters — never deletions.
8. Exports/bundles must pass the redaction pass (auth tokens, cookies) before leaving
   the process.

## Commands

- pnpm install && pnpm build — build all packages (turbo-ordered)
- pnpm test — full suite; core tests run on Node with fake CDP fixtures
- pnpm --filter @localcoast/desktop dev — launch the app
- pnpm --filter @localcoast/mcp test:parity — MCP/UI parity harness (run after adding
  any capability)
- pnpm --filter @localcoast/page-agent test:chromium — agent tests in headless Chromium

## Testing conventions

- New Core logic: unit tests against fake CdpTransport fixtures (record real CDP traffic
  with the fixture recorder in core/test/harness).
- New capability: schema round-trip test in protocol-types + parity test entry.
- Frontend/panel changes: verify in the running app via the agent-browser MCP.
- Do NOT launch Electron in unit tests; only the desktop smoke suite does that.

## Model routing for tasks (see IMPLEMENTATION_PLAN.md §4)

cdp-mux, main-world patches, framework adapters, snapshot/restore semantics, event-store
schema changes, MCP codegen → strongest model. Panels, parsers, exporters, reporters,
tests against existing schemas → cheaper model is fine.
