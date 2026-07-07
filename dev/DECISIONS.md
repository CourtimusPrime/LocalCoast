# Decisions

This doc outlines why specific decisions were made.

## `pnpm` as the package manager

> Yes, `bun` is faster and more modern than `pnpm`, but this apps needs to run on Electron, which has its own Node build.

1. **SQLite needs a native binary, and that binary is picky.** `better-sqlite3` (our database library) isn't pure JS — part of it is compiled C++ code. That compiled code has to match the exact Node.js version it runs on. Electron ships its own custom Node build, which doesn't match regular Node. So we run the database in a separate plain-Node process and talk to it over messages, instead of loading it straight into Electron. This already works, and it works because of how pnpm handles native builds.

2. **pnpm has a safety switch for compiled code, and we're already using it.** Installing packages that compile native code (like `better-sqlite3`, `esbuild`, `electron`) can be a security risk — random packages shouldn't get to run arbitrary build scripts on your machine. pnpm requires you to explicitly allow which packages can do this (see `allowBuilds` in `pnpm-workspace.yaml`). It's already set up and tested. Switching package managers means redoing this from scratch, with no guarantee it works the same way.

3. **pnpm keeps packages honest.** In a monorepo (multiple packages living in one repo, like ours), it's easy to accidentally use a package you never actually installed — it just happens to be sitting in `node_modules` because some other package pulled it in. pnpm's stricter folder structure blocks that by default. That matters here because we have hard rules about which package can import what (e.g., `core` must never import `electron`), and a leaky `node_modules` makes those rules easier to accidentally break.

4. **pnpm + Turborepo is a well-worn path.** We use Turborepo to run builds/tests across packages efficiently. pnpm workspaces + Turborepo is a common, heavily-used combo — lots of prior art, fewer surprises. Other combos exist but are less proven, especially around caching behavior.

5. **Electron tooling assumes pnpm/npm/yarn.** Most guides, examples, and rebuild tools for Electron (handling that native-binary mismatch problem from #1) assume you're using one of the standard package managers. Straying from that means more time spent debugging tooling instead of building the app.

6. **Bottom line:** other package managers (like Bun) are faster at installing packages, but this project's riskiest, most fragile part — native SQLite code running safely inside Electron — already works with pnpm's setup. Speed isn't worth risking that.
