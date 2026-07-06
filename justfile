# LocalCoast task runner. `just` = list recipes.

_default:
    @just --list

# Install workspace dependencies
install:
    pnpm install

# Build all packages (turbo-ordered)
build:
    pnpm build

# Run the full test suite (Node; no Electron)
test:
    pnpm test

# Lint (includes the electron/renderer import-boundary rules)
lint:
    pnpm lint

# Typecheck every package
typecheck:
    pnpm typecheck

# Launch the desktop app
dev:
    pnpm --filter @localcoast/desktop dev

# MCP/UI parity harness (run after adding any capability)
parity:
    pnpm --filter @localcoast/mcp test:parity

# Page-agent tests in headless Chromium (framework adapters, storage patches)
chromium:
    pnpm --filter @localcoast/page-agent test:chromium

# End-to-end desktop smoke: real Electron + real dev server, driven via MCP
smoke:
    node packages/desktop/scripts/smoke.mjs

# CI invariant 2: every capability is MCP-exposed or has a written reason
check-mcp:
    pnpm --filter @localcoast/core run build && pnpm --filter @localcoast/core run check:mcp-exposure

# Build + lint + test — the pre-push gate
verify: build lint test

# Remove build artifacts
clean:
    rm -rf packages/*/dist packages/*/dist-types .turbo packages/*/.turbo
