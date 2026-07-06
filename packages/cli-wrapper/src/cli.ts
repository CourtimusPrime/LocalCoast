#!/usr/bin/env node
import { runInstallMcp } from './install-mcp.js';
import { runMcpStdio } from './mcp-stdio.js';
import { runWrapper } from './run-wrapper.js';

const command = process.argv[2];

switch (command) {
  case 'mcp-stdio':
    await runMcpStdio();
    break;
  case 'install-mcp':
    await runInstallMcp(process.argv[3]);
    break;
  case 'run':
    // Tier-2 run-wrapper: owns dev-server stdout and forwards it as server logs.
    await runWrapper(process.argv.slice(3));
    break;
  default:
    console.log(`localcoast — LocalCoast CLI

Usage:
  localcoast mcp-stdio            stdio↔HTTP MCP shim for stdio-only clients
  localcoast install-mcp [dir]    write .localcoast/mcp.json + print client setup
  localcoast run <cmd...>         wrap a dev server for Tier-2 log capture

Node agent (Tier 2): NODE_OPTIONS='--require @localcoast/node-agent' <cmd>
`);
    process.exit(command ? 1 : 0);
}
