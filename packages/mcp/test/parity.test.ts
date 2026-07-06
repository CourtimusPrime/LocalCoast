import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import type { Core, EventStore } from '@localcoast/core';
import { generateTools, McpHttpServer } from '../src/index.js';
import { PARITY_CASES, seededCore } from './harness.js';

/**
 * Parity harness (AD-5 rule 4): every MCP-exposed query runs through the REAL
 * streamable-HTTP transport and must return results identical to the
 * in-process Core path. This is the mechanical guarantee that the agent
 * surface and the UI read the same world.
 */

let core: Core;
let store: EventStore;
let server: McpHttpServer;
let client: Client;

beforeAll(async () => {
  ({ core, store } = await seededCore());
  core.registry.registerCommand({
    name: 'test.parityCmd',
    description: 'test command for parity',
    input: z.object({ sessionId: z.string() }),
    output: z.object({ echoed: z.string() }),
    surfaces: { palette: true },
    paletteTitle: 'Parity test command',
    handler: async (input) => ({ echoed: input.sessionId }),
  });

  server = new McpHttpServer({ core, port: 14820 });
  await server.start();

  client = new Client({ name: 'parity-client', version: '0.0.1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${server.token}` } },
    }),
  );
});

afterAll(async () => {
  await client?.close();
  await server?.stop();
  await store?.close();
});

const jsonNormalize = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

describe('MCP parity', () => {
  it('every MCP-exposed query capability has a parity case', () => {
    const queryTools = generateTools(core).filter((t) => t.kind === 'query');
    const missing = queryTools
      .map((t) => t.capabilityName)
      .filter((name) => !(name in PARITY_CASES));
    expect(missing, `add parity cases for: ${missing.join(', ')}`).toEqual([]);
  });

  it('lists generated tools over HTTP', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('lc_events_query');
    expect(names).toContain('lc_network_list');
    expect(names).toContain('lc_act_dispatch');
    // Subscriptions never become tools.
    expect(names.every((n) => !n.includes('subscribe'))).toBe(true);
  });

  for (const [capability, input] of Object.entries(PARITY_CASES)) {
    it(`parity: ${capability}`, async () => {
      const inProcess = await core.query(capability, input, { actor: 'mcp' });
      const toolName = `lc_${capability.replace(/[.-]/g, '_')}`;
      const viaHttp = await client.callTool({
        name: toolName,
        arguments: input as Record<string, unknown>,
      });
      expect(viaHttp.isError ?? false).toBe(false);
      expect(viaHttp.structuredContent).toEqual(jsonNormalize(inProcess));
    });
  }

  it('commands dispatch over HTTP with mcp actor attribution in the audit trail', async () => {
    const result = await client.callTool({
      name: 'lc_test_parityCmd',
      arguments: { sessionId: 's-1' },
    });
    expect(result.structuredContent).toEqual({ echoed: 's-1' });

    const audits = await store.query({ types: ['action.dispatched'], limit: 10 });
    const audit = audits.find(
      (a) => (a.payload as { capability: string }).capability === 'test.parityCmd',
    );
    expect(audit?.actor).toBe('mcp');
  });

  it('invalid input surfaces as a tool error, not a transport failure', async () => {
    const result = await client.callTool({
      name: 'lc_network_get',
      arguments: { requestId: 12345 },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('invalid_input');
  });
});

describe('MCP auth boundary', () => {
  it('rejects missing token', async () => {
    const res = await fetch(server.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects wrong token', async () => {
    const res = await fetch(server.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer wrong-token',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects foreign Origin headers (DNS rebinding)', async () => {
    const res = await fetch(server.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${server.token}`,
        origin: 'https://evil.example.com',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(res.status).toBe(403);
  });
});
