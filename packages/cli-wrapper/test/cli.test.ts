import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  Core,
  EventStore,
  InProcessBackend,
  registerBuiltins,
} from '@localcoast/core';
import { McpHttpServer, writeInstanceInfo } from '@localcoast/mcp';
import { runInstallMcp } from '../src/install-mcp.js';

/**
 * End-to-end shim test: a real McpHttpServer + a real instance.json under a
 * temp LOCALCOAST_HOME, with the built cli spawned as a subprocess and driven
 * over stdio by the SDK client. Proves the stdio↔HTTP proxy carries the full
 * MCP handshake and tool calls.
 */

let store: EventStore;
let server: McpHttpServer;
let home: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'localcoast-cli-home-'));
  process.env.LOCALCOAST_HOME = home;

  const dbPath = join(mkdtempSync(join(tmpdir(), 'localcoast-cli-db-')), 'events.db');
  store = new EventStore({ backend: new InProcessBackend(dbPath), batchMs: 1 });
  await store.open();
  const core = new Core(store);
  registerBuiltins(core, {
    inspector: { listListeningServers: async () => [], envOf: async () => undefined },
  });

  server = new McpHttpServer({ core, port: 14850 });
  await server.start();
  await writeInstanceInfo({
    version: 1,
    url: server.url,
    port: server.port,
    pid: process.pid,
    token: server.token,
    startedAtWall: Date.now(),
  });
});

afterAll(async () => {
  await server?.stop();
  await store?.close();
  delete process.env.LOCALCOAST_HOME;
});

describe('localcoast mcp-stdio', () => {
  it('proxies the MCP handshake and tool calls to the HTTP instance', async () => {
    const cliPath = new URL('../dist/cli.js', import.meta.url).pathname;
    const client = new Client({ name: 'stdio-e2e', version: '0.0.1' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliPath, 'mcp-stdio'],
      env: { ...process.env, LOCALCOAST_HOME: home } as Record<string, string>,
    });
    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('lc_sessions_list');

    const result = await client.callTool({ name: 'lc_sessions_list', arguments: {} });
    expect(result.structuredContent).toEqual({ sessions: [] });
    await client.close();
  }, 20_000);
});

describe('localcoast install-mcp', () => {
  it('writes gitignored mcp.json pointing at the live instance', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'localcoast-proj-'));
    await runInstallMcp(projectRoot);

    const config = JSON.parse(readFileSync(join(projectRoot, '.localcoast', 'mcp.json'), 'utf8'));
    expect(config.url).toBe(server.url);
    expect(config.token).toBe(server.token);

    const gitignore = readFileSync(join(projectRoot, '.localcoast', '.gitignore'), 'utf8');
    const rules = gitignore.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
    // Only the token-bearing pointer is ignored; committable artifacts are not.
    expect(rules).toEqual(['mcp.json']);
  });
});
