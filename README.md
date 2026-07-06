# LocalCoast

An Electon app for browsing and inspecting ’localhost’ dev servers. 

> A single surface that replaces browser DevTools, terminal output, and debugging. **Your next web-dev toolkit.**

Built for humans and agents via MCP.

## Why

Debugging a local app means juggling three disconnected views:

- The browser's
DevTools (usually Chromium, which is memory-intensive)
- The terminal running the server
- One-off tools used to fill the gaps, like variable injectors (e.g. Doppler) and debugging assistants (e.g. Claude, Playwright).

None of them share a timeline, are readable by an agent, nor
survive a page refresh. 

LocalCoast attaches the Chrome DevTools Protocol to
each guest server, funnels page events, network traffic, framework state, and
server-side signals into one queryable event store, and renders it as panels
for humans and as MCP tools for agents — off the same registry, so the two can
never drift apart.

## Features at a glance

- **Server list** — localhost servers detected automatically, opened as tabs
  with full instrumentation attached before the first navigation.
- **Network** — every request with bodies, timing, WS/SSE frames, GraphQL
  operations; replay with an inline response diff; mock intercepts; live
  API-schema inference with drift flags.
- **Console & errors** — structured-log aware (pino/winston/bunyan), errors
  grouped by stack fingerprint.
- **Storage** — full local/session/cookie state plus a usage trail of every
  read and write with the JS stack that did it.
- **Component selection** — right-click any rendered component to copy its
  repo-relative source path (React incl. 19, Vue, Svelte).
- **State & time travel** — app-state snapshots, a scrubbable timeline, and
  Redux-DevTools-based store time travel.
- **Agent-native** — a single `session.observe` call returns the a11y tree,
  component tree, in-flight requests, and recent console; an assertion runner
  verifies behavior between edits.
- **Auth** — Token Vault (JWT decode + expiry), auth injection, cookie
  edit-in-place.
- **Build awareness** — normalized build/HMR status sniffed from the dev
  server's own WebSocket.
- **Server-side (opt-in tiers)** — `localcoast run` captures server logs;
  the Node agent surfaces DB queries and outbound calls; an OTLP receiver
  lights up distributed traces.
- **DX polish** — bug-report bundles (secrets redacted), port profiles,
  fixtures, port-conflict resolver, responsive breakpoint tester, split view,
  and a `Cmd/Ctrl+K` command palette.

## Requirements

- Node.js ≥ 22
- pnpm 11 (`corepack enable` will provide it)
- macOS or Linux (the Tier-0 process discovery uses `lsof` / `ps`)

## Getting started

```bash
pnpm install      # or: just install
pnpm build        # or: just build   (turbo-ordered across packages)
pnpm --filter @localcoast/desktop dev   # or: just dev
```

The app scans for listening localhost servers and lists them. Click one to
open it as a tab with capture attached.

## Connecting a coding agent (MCP)

LocalCoast serves a streamable-HTTP MCP endpoint from the running app (default
`http://127.0.0.1:4820/mcp`, per-run bearer token). With the app running:

```bash
# writes .localcoast/mcp.json and prints the exact registration command
node packages/cli-wrapper/dist/cli.js install-mcp
```

Then register it with your client, e.g. Claude Code:

```bash
claude mcp add --transport http localcoast http://127.0.0.1:4820/mcp \
  --header "Authorization: Bearer <token>"
```

Stdio-only clients can use the shim, which proxies to the live instance rather
than spawning a second one:

```bash
claude mcp add localcoast -- localcoast mcp-stdio
```

The agent gets ~57 tools (`lc_observe`, `lc_network_*`, `lc_act_*`,
`lc_assert_*`, …). Every agent action is attributed and shows up in the same
timeline the human sees.

## Server-side capture (optional tiers)

Zero-config gets you port discovery, HMR/build status, and client-observed
service edges. To capture more, opt in per tier:

```bash
# Tier 2 — own the dev-server process: server logs, structured-log parsing
localcoast run pnpm dev

# Tier 2 — DB queries (pg/mysql2/Prisma) + outbound HTTP, request-attributed
NODE_OPTIONS='--import @localcoast/node-agent' pnpm dev
```

Apps already exporting OpenTelemetry (JSON/OTLP) to `127.0.0.1:4318` light up
the trace viewer with no changes.

## Architecture

A pnpm + turborepo workspace. The load-bearing rule: the renderer and the MCP
server are both thin clients of one typed **capability registry** — there is no
other data path, so a feature is agent-reachable the moment it exists.

| Package          | Responsibility                                                                                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `protocol-types` | Zod schemas only — event taxonomy, capability IO, file formats. Every contract is defined here first.                                                           |
| `core`           | Headless: event store (SQLite worker), capability registry + dispatch, engines (diff, replay, schema inference, assertions, redaction). Never imports electron. |
| `page-agent`     | Injected two-world IIFE for guest pages: framework adapters, storage/WS/history patches, overlays.                                                              |
| `mcp`            | Streamable-HTTP server; tools code-generated from the registry.                                                                                                 |
| `desktop`        | The only package importing electron: main hosts core + cdp-mux; renderer is thin-client panels; preload exposes only `core:query/command/subscribe`.            |
| `cli-wrapper`    | The `localcoast` bin: run-wrapper, node-agent, MCP stdio shim, install-mcp.                                                                                     |

Key decisions and their tradeoffs are recorded as AD-1…AD-10 in
[`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md); the non-negotiable
invariants live in [`CLAUDE.md`](./CLAUDE.md).

## Development

```bash
just            # list all recipes
just verify     # build + lint + test — the pre-push gate
just test       # full suite on plain Node (no Electron)
just chromium   # page-agent tests in headless Chromium
just smoke      # end-to-end: real Electron + dev server, driven via MCP
just parity     # MCP/UI parity harness — run after adding any capability
just check-mcp  # enforce that every capability is MCP-exposed (invariant 2)
```

**Definition of done for a feature** (invariant): registry entry + generated
MCP tool + palette action (if user-invokable) + panel, with the panel last.
Adding a capability without a parity case, or opting out of MCP without a
written reason, fails CI.

## Status

All architecture phases are implemented and verified — see
[`PROGRESS.md`](./PROGRESS.md) for the per-phase breakdown, the test/smoke
evidence, and the documented deviations from the plan. The session-sharing
tunnel is the one deliberately-deferred item.

## License

See [`LICENSE`](./LICENSE).
