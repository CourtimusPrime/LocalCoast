# LocalCoast

LocalCoast is a lightweight browser application for browsing and inspecting localhost servers. It provides a unified development surface for humans and coding agents alike, replacing the fragmented workflow of browser DevTools, terminal output, and separate debugging utilities with a single source of truth about what is happening in a running local application.

---

## Features

### Server List

On the main app page, view all active localhost servers with a live content preview. Click any server to open it in another tab within the same app.

- Servers are detected automatically and listed by port
- Each entry shows a content preview so you can identify the right server at a glance
- Multiple servers can be open simultaneously in separate tabs

---

### Dev Tools

A right-hand toggle sidebar with tabbed panels for inspecting the running application.

#### Network

Monitor data transfer for the current session.

- Shows total data uploaded and downloaded
- Breakdown of individual package sizes per request
- Persists across page changes; resets on refresh (`Cmd+R` / `Ctrl+R`)

#### Console Logs

A formatted, readable stream of server logs.

- Pretty-printed log output with syntax highlighting and log level indicators
- Copy button to export the full console log to clipboard

#### Local Storage

A complete view of everything stored in local storage for the current session, including session cookies and auth tokens.

- Timestamps showing when each entry was first set
- A usage trail showing every subsequent read or write
- Copy button to export the full log to clipboard

---

### Component Selection

Right-click any rendered component to automatically copy its relative file path to your clipboard. Useful for quickly referencing components in code, documentation, or agent prompts.

---

### MCP Access

Coding agents including Claude Code can interact with localhost servers through LocalCoast via the Model Context Protocol. The agent surface supports:

- Navigation, clicking, and typing within the running application
- Screenshots and screen recordings
- Reading network logs, console logs, and local storage state

---

### State and Time Travel

Tools for capturing, restoring, and replaying application state across the full development session.

#### Request Replay

Re-fire any past network request directly from the Network panel.

- Editable request headers and body before resending
- Response diff shown inline against the original response
- No need to context-switch to Postman or curl for quick request iteration

#### App State Snapshots

Bookmark the complete UI state at any point and restore it later.

- Captures local storage, in-memory framework state (React, Vue, Svelte), URL params, and active form inputs
- Named snapshots persist across restarts
- Essential for bugs that only reproduce after a specific multi-step navigation sequence

#### Time Travel Debugging

A scrubable log of state diffs across the session lifetime.

- Records a diff on every meaningful state change event
- Scrub backwards through the timeline to see exactly how the application reached its current state
- Pairs with App State Snapshots: jump to any prior snapshot from the timeline

---

### Deep Inspection

Extended inspection panels beyond network and logs.

#### Environment Variable Inspector

A live view of the environment variables loaded into the current running process.

- Shows which `.env` file each variable was sourced from
- Diff view highlights any variables that changed since the last server restart
- Surfaces missing required variables with callouts

#### Database Query Inspector

Intercepts and surfaces ORM and raw database queries as they execute.

- Shows each query, its execution time, and the component or function that triggered it
- Inline query plan (EXPLAIN) viewer for slow queries
- Highlights N+1 patterns and duplicate queries within a single page load

#### Performance Profiler Overlay

Inline performance metrics without opening browser DevTools.

- Frame rate, paint time, and long JavaScript task indicators rendered as an overlay on the live preview
- Timeline view of render cycles per component
- Exportable performance snapshots for sharing or attaching to bug reports

#### Memory and Resource Monitoring

A persistent timeline of JavaScript heap usage, DOM node count, and active event listener count, sampled at a configurable interval.

- Runs continuously in the background so anomalies are visible without having to manually initiate a recording session
- Correlate memory spikes with specific user actions or code changes using the session timeline
- Available through the MCP surface so agents can read resource state without triggering a separate DevTools session
- Useful for catching leaks that only manifest after a specific sequence of interactions, not just on initial load

---

### Collaboration and Sharing

Tools for involving teammates or handing context to agents without setup overhead.

#### Session Sharing

Expose a running localhost server via an instant tunnel link.

- One click generates a shareable URL routed through a secure tunnel
- The recipient sees the live application with full LocalCoast Dev Tools attached
- No separate ngrok or Cloudflare tunnel configuration required

#### Bug Report Bundles

A one-click export that assembles everything needed to reproduce a bug.

- Packages the current screenshot, the last 60 seconds of console logs, the last 30 network requests, and the current local storage state into a single artifact
- Bundles include the current URL, active environment name, and Node/runtime version
- Can be attached to GitHub Issues, Linear tickets, or pasted directly into an agent prompt

#### Multi-Port Split View

View multiple localhost servers side by side within the same LocalCoast window.

- Useful when a frontend (e.g. port 3000) and an API server (e.g. port 8080) need to be observed simultaneously
- Actions taken in one pane are timestamped alongside events in the other, making cross-service cause-and-effect visible

---

### Agent-Native Surface

A structured interface layer designed for coding agents operating on the running application.

#### Observation API

A structured JSON endpoint that exposes the full observable state of the running application in a single call.

- Returns the current DOM accessibility tree, active framework component tree, in-flight network requests, and recent console events
- Eliminates the need for agents to infer application state by parsing screenshots
- Dramatically reduces agent loop latency compared to screenshot-based workflows

#### Assertion Runner

A lightweight behavioral check system that agents (or developers) can author and run repeatedly.

- Assertions are expressed as simple declarative checks against the Observation API response (e.g. "cart item count is 2 after this click")
- Results are shown inline in the Dev Tools sidebar
- Acts as a fast verification layer between code edits without requiring a full Playwright or Cypress suite

#### Diff Mode

A before/after comparison of full rendered application state across any code change.

- Captures a snapshot before a change is applied, then automatically diffs the result once the dev server reloads
- Visual diff highlights DOM changes, style changes, and network request deltas side by side
- Gives agents a deterministic confirmation that a fix had the intended effect with no unintended regressions

---

### DX Polish

Quality-of-life features that reduce friction across the full development workflow.

#### Port Configuration Profiles

Save named workspace layouts that restore a specific LocalCoast configuration.

- Each profile remembers which ports to load, which Dev Tools tabs to open, active breakpoint size, and pinned snapshots
- Profiles can be committed to the repository so the whole team opens the same view

#### Error Surface

When a runtime error or failed request occurs, LocalCoast renders a cleaned-up error overlay.

- Stack traces are resolved to original source files via source maps
- File paths are clickable and open the relevant line directly in the configured editor (`vscode://`, `cursor://`, `zed://`)
- Error overlays are also exposed through the MCP surface so agents can read and act on them without a screenshot

#### Mock Server Intercepts

Overwrite any outgoing request's response inline from the Network panel.

- Define a mock response body, status code, and latency for any matched URL pattern
- Mocks persist across page reloads and can be saved as named fixtures
- Useful for testing error states, empty states, and third-party API failures without standing up a separate mock server

#### Responsive Breakpoint Tester

Resize the application preview to any viewport width with named breakpoint presets.

- Standard presets (mobile, tablet, desktop) plus custom dimensions
- Active breakpoint is shown persistently in the toolbar and included in bug report bundles
- One-click RTL toggle applies `direction: rtl` to the full document to surface right-to-left layout bugs without requiring a separate locale or manual DOM editing

#### Command Palette

A keyboard-driven entry point for all LocalCoast actions, with a built-in shortcut reference.

- Accessible via `Cmd+K` / `Ctrl+K` from anywhere in the application
- Supports navigation between ports, triggering screenshots and screen recordings, copying logs, jumping to source, running assertions, and applying state snapshots
- Fully accessible to agents via the MCP surface as a structured action dispatcher
- Displays contextual keyboard shortcuts for the current panel, making shortcut discovery part of the same interface rather than a separate overlay

---

### Authentication and Identity Management

#### Token Vault and Inspector

A dedicated panel that automatically parses and displays every JWT in local storage, cookies, and Authorization headers.

- Decoded header and payload with human-readable timestamps for `iat`, `exp`, and `nbf`
- Visual countdown to token expiry
- One-click refresh that fires the refresh token endpoint
- Available through the MCP surface so agents can verify identity claims after an action without parsing raw base64

#### OAuth Flow Visualizer

When the application initiates an OAuth or OIDC flow, render the full redirect chain as a step-by-step diagram.

- Shows the authorization request, code exchange, and token response with each step's parameters and response codes
- Makes the PKCE challenge, state parameter, and scope negotiation legible without requiring the developer to manually parse query strings in the network panel
- Particularly useful for debugging redirect URI mismatches and scope errors, which are common in localhost development where redirect URIs differ from production

#### Auth State Injection

Let the developer (or agent) manually inject a token with specific claims into the current session without going through the login flow.

- Critical for testing role-based access control without maintaining multiple test accounts
- Agents can use this to test permissioned flows without needing to automate the full login sequence

#### Cookie Inspector with Edit-in-Place

A dedicated cookie panel with the ability to edit cookie values, expiry dates, and flags directly.

- Edit `HttpOnly`, `SameSite`, and `Secure` flags inline, with a plain-English explanation of each flag's effect
- Many auth bugs on localhost are caused by `SameSite` mismatches or `HttpOnly` flags preventing JavaScript access -- having a visual editor for these is significantly more usable than the Chrome DevTools Application tab
- Changes are reflected immediately in the running session without a page reload

---

### Build and Compilation Awareness

#### Build Status Indicator

A persistent indicator in the server list showing whether each server is currently building, hot-reloading, or in an error state.

- Shows build duration and a diff of which files changed since the last successful build
- Normalizes the fragmented per-framework indicators (Vite's error overlay, Next's fast refresh banner) into a single consistent surface

#### Bundle Size Tracker

For each page load or hot reload, show a breakdown of JavaScript bundle sizes by route, chunk, and dependency.

- Tracks bundle size changes across the session so you can immediately see the impact of adding a new import
- Prevents silent bundle bloat by making the cost of every dependency addition visible in real time

#### Hot Reload Timeline

A log of every hot module replacement event with the file that changed, the modules that were invalidated, the reload latency, and whether the reload was a full page reload or a hot update.

- Useful for identifying slow rebuild paths
- Available through the MCP surface so agents can verify that a code change was successfully picked up by the dev server before proceeding with the next step

#### Build Error Aggregator

TypeScript errors, ESLint violations, and build warnings surfaced in a unified panel inside LocalCoast.

- Shows file, line, rule, and severity for every error; entries are clickable to open in the configured editor
- Especially important for the agent surface: an agent that can read structured build errors from LocalCoast can close the TypeScript feedback loop without relying on terminal output parsing

---

### API Development and Contract Testing

#### Automatic API Schema Inference and Validation

As requests flow through the Network panel, LocalCoast infers a schema from the request and response shapes, building a live OpenAPI-style spec from observed traffic.

- Inferred schemas are used to validate subsequent responses from the same endpoint, flagging mismatches inline in the Network panel
- Catches the common case where a frontend type definition and the actual API response drift apart silently over time
- No developer-provided schema required; the spec is derived from observed traffic and updated as new response shapes are seen

#### Request Diffing Across Sessions

Compare a request and its response from this session against the same endpoint's response from a previous session or snapshot.

- Invaluable for verifying that a backend change did not alter the response contract in an unexpected way
- Provides basic API contract regression testing without a dedicated tool

#### WebSocket and SSE Inspector

A dedicated panel for WebSocket connections and Server-Sent Events streams.

- Shows the connection lifecycle, the full message stream with timestamps and message sizes
- Ability to send arbitrary messages into an open WebSocket for testing
- SSE streams are shown as a live feed with per-event metadata

#### GraphQL Support

LocalCoast detects GraphQL traffic and renders it as named operations rather than opaque `POST /graphql` entries.

- Shows operation name, variables, response data tree, and any errors returned in the response body alongside the HTTP 200
- Query, mutation, and subscription types are visually distinct
- Subscription streams are shown as live feeds in the same panel

---

### Testing and Verification Integration

#### Test Runner Integration

Connect to a running test watcher (Jest, Vitest, Playwright) and display test results inline in the sidebar.

- Shows which tests are passing, failing, or currently running, with the ability to re-run individual tests without switching to the terminal
- Failed tests are linked to the specific network requests and console logs that occurred during the test run, so you can see exactly what the application was doing when the assertion failed
- Test results are available through the MCP surface so agents can run a test, read the result, and iterate on a fix without leaving the agent loop

#### Coverage Overlay

With coverage data from a running test suite, render a visual overlay on the live application showing which UI regions and code paths are covered by tests and which are not.

- Makes test gap identification spatial and intuitive rather than requiring you to mentally map a coverage report back to the rendered UI
- Overlay updates automatically as tests run, giving a live view of coverage as the test suite evolves

#### Scenario Playback

Record a sequence of user interactions (clicks, form inputs, navigation) as a replayable scenario.

- Produces an editable, structured sequence of DOM events rather than a video, which can be replayed deterministically against the running application
- Distinct from MCP screen recordings: playback is inspectable, editable, and re-runnable, not just a passive recording
- Used to reproduce specific bug paths or handed to an agent as a concrete definition of a workflow to verify

#### Fixture Management

A panel for managing test fixtures: static JSON files, seeded database states, or mocked API responses that set the application into a known initial state.

- One-click fixture loading simultaneously seeds mock server intercepts, injects auth tokens via the Token Vault, and restores a named app state snapshot
- Collapses a multi-step manual setup process into a single named action
- Fixtures can be committed to the repository and shared across the team

---

### Observability and Error Monitoring

#### Structured Log Parsing

Most production logging libraries (Winston, Pino, Bunyan) emit JSON-structured logs that currently display as raw objects in the Console panel. LocalCoast detects structured log format and renders it properly.

- Expandable fields, filterable by log level, service name, trace ID, and custom fields
- Copy functionality exports as either raw JSON or a formatted table

#### Distributed Trace Viewer

If the application emits OpenTelemetry spans, render them as a waterfall trace view without requiring a separate Jaeger or Honeycomb instance.

- Activates automatically when OTel spans are detected; adds no friction for applications that do not use it
- Shows the full request lifecycle across service boundaries in a zero-configuration local environment
- Particularly valuable for microservice stacks where a single user action touches multiple services

#### Error Aggregation and Grouping

Rather than showing every error occurrence as a separate console entry, group errors by their stack trace fingerprint and show a count.

- Makes high-frequency errors (a component that re-renders repeatedly and throws each time) immediately obvious rather than flooding the console
- Each error group shows first occurrence, most recent occurrence, and the full trace for any instance

---

### Multi-Service and Microservice Awareness

#### Service Dependency Graph

Infer and render the dependency graph between running services based on observed network traffic.

- Shows which ports are calling which other ports, with request frequency and average latency per edge
- Makes it immediately clear when a service is unavailable because something it depends on is down
- Gives agents a map of the local architecture without needing to read `docker-compose.yml`

#### Health Check Dashboard

Periodically ping each registered service's health endpoint (or fall back to a TCP connection check) and show a real-time status indicator.

- When a service goes down, shows which other services have made failed requests to it in the last N seconds
- Collapses what is currently a painful distributed debugging task into a single view

#### Log Correlation Across Services

When a request passes through multiple services, correlate the log entries across all of them by trace ID or request ID.

- The localhost equivalent of what Datadog or Honeycomb does in production, oriented toward understanding and fixing behavior rather than alerting on it

#### Container and Process Status

A read-only panel showing the running status and resource usage of Docker containers or process manager processes (PM2, Foreman, Overmind) associated with the current project.

- Surfaces their logs alongside the LocalCoast-normalized log view for unified observability
- Scoped to monitoring only; process control (restarting, killing) is intentionally out of scope and left to the terminal or dedicated process manager tools

---

### Accessibility and Internationalization

#### Accessibility Audit Panel

Run axe-core or a similar accessibility rule engine against the current page state and surface violations in a dedicated panel.

- Shows severity, the specific DOM node, a plain-English description of the problem, and a link to the relevant WCAG criterion for each violation
- Re-runs automatically on every page change or hot reload so regressions are caught immediately
- Results are available through the MCP surface so agents can write code, reload, check for accessibility violations, and iterate without human involvement

#### Focus Order Visualizer

Render an overlay on the live application showing the tab focus order as a numbered sequence of highlighted elements.

- Focus order bugs (elements that are visually laid out in one sequence but tab in a completely different order due to DOM structure) are nearly invisible without this tool
- Particularly useful for keyboard-only and assistive technology users whose experience depends entirely on focus order being logical

#### Translation Coverage Inspector

For applications using i18n libraries (i18next, react-intl, vue-i18n), show the runtime translation state of the current page.

- Which translation keys are active on the current page
- Which keys are missing for each configured locale
- Which strings on the page appear to be hardcoded rather than going through the i18n system
- Distinct from static linting: this is a runtime view of actual key resolution, which catches locale gaps that only appear when navigating to specific pages or states

---

### Project and Configuration Intelligence

#### Port Conflict Resolver

When a port is already in use, identify the process holding it and offer to resolve the conflict.

- Shows what the conflicting process is (leftover dev server, system service, another project)
- One-click action to release the port
- Interrupts the development flow multiple times per week for most developers; removing this friction has outsized value relative to implementation cost

#### Monorepo Awareness

Detect workspace configuration files (Turborepo, Nx, pnpm workspaces, Lerna) and group servers in the Server List by their workspace package.

- Shows the dependency graph between packages
- Indicates which packages have active dev servers running

#### Configuration File Watcher

Track changes to configuration files (`vite.config.ts`, `next.config.js`, `package.json`, `tsconfig.json`) and surface a notice when a change requires a server restart.

- Includes a one-click restart button
- Currently this information is buried in the framework's own console output, if it surfaces at all
