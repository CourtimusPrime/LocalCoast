import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { CapabilityFault, type Core } from '@localcoast/core';
import { dispatchTool, generateTools, type GeneratedTool } from './codegen.js';

/**
 * Streamable-HTTP MCP host (AD-7): one HTTP endpoint on 127.0.0.1 serving the
 * live instance, per-run bearer token, Host/Origin validation against DNS
 * rebinding. Multiple clients attach as peers; every tool call dispatches
 * through Core with `actor: 'mcp'`, so agent activity is visible in the
 * product timeline.
 */

export const DEFAULT_MCP_PORT = 4820;
const PORT_SCAN_RANGE = 20;

export interface McpHttpServerOptions {
  core: Core;
  /** Preferred port; falls back to a scanned free port. */
  port?: number;
  /** Per-run bearer token; generated when omitted. */
  token?: string;
  serverName?: string;
  serverVersion?: string;
  /**
   * Tier-2 ingest sink (AD-8): the run-wrapper, node-agent, and reporters POST
   * batches of pre-shaped events here. The host supplies the sink so it can
   * stamp session ids and forward into the store. Omit to disable ingest.
   */
  onIngest?: (events: unknown[]) => void;
}

async function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

export async function findFreePort(preferred: number): Promise<number> {
  for (let port = preferred; port < preferred + PORT_SCAN_RANGE; port++) {
    if (await portIsFree(port)) return port;
  }
  throw new Error(`no free port in ${preferred}..${preferred + PORT_SCAN_RANGE}`);
}

export class McpHttpServer {
  readonly token: string;
  port = 0;
  private readonly core: Core;
  private readonly serverName: string;
  private readonly serverVersion: string;
  private http: HttpServer | null = null;
  private transports = new Map<string, StreamableHTTPServerTransport>();
  private tools: GeneratedTool[] = [];

  constructor(private readonly opts: McpHttpServerOptions) {
    this.core = opts.core;
    this.token = opts.token ?? randomBytes(24).toString('base64url');
    this.serverName = opts.serverName ?? 'localcoast';
    this.serverVersion = opts.serverVersion ?? '0.1.0';
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  async start(): Promise<void> {
    this.tools = generateTools(this.core);
    this.port = await findFreePort(this.opts.port ?? DEFAULT_MCP_PORT);
    this.http = createServer((req, res) => {
      void this.handle(req, res).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.http!.once('error', reject);
      this.http!.listen(this.port, '127.0.0.1', () => resolve());
    });
  }

  async stop(): Promise<void> {
    for (const transport of this.transports.values()) await transport.close();
    this.transports.clear();
    if (this.http) {
      await new Promise<void>((resolve) => this.http!.close(() => resolve()));
      this.http = null;
    }
  }

  private authorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return false;
    const presented = Buffer.from(header.slice('Bearer '.length));
    const expected = Buffer.from(this.token);
    return presented.length === expected.length && timingSafeEqual(presented, expected);
  }

  /** Anti-DNS-rebinding: local Host, and when a browser sends Origin it must be local. */
  private originOk(req: IncomingMessage): boolean {
    const host = req.headers.host ?? '';
    const hostname = host.split(':')[0];
    if (hostname !== '127.0.0.1' && hostname !== 'localhost') return false;
    const origin = req.headers.origin;
    if (origin) {
      try {
        const parsed = new URL(origin);
        if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    if (url.pathname !== '/mcp' && url.pathname !== '/ingest') {
      res.writeHead(404).end();
      return;
    }
    if (!this.originOk(req)) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden host/origin' }));
      return;
    }
    if (!this.authorized(req)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing or invalid bearer token' }));
      return;
    }

    // Tier-2 ingest endpoint: POST { events: [...] } from wrapper/agent/reporter.
    if (url.pathname === '/ingest') {
      if (!this.opts.onIngest) {
        res.writeHead(503).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { events?: unknown[] };
        if (Array.isArray(body.events)) this.opts.onIngest(body.events);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400).end();
      }
      return;
    }

    const sessionId = req.headers['mcp-session-id'];
    const existing = typeof sessionId === 'string' ? this.transports.get(sessionId) : undefined;
    if (existing) {
      await existing.handleRequest(req, res);
      return;
    }

    // New session: create a transport + server pair and let the transport
    // negotiate the session id on initialize.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        this.transports.set(id, transport);
      },
      onsessionclosed: (id) => {
        this.transports.delete(id);
      },
    });
    await this.buildServer().connect(transport);
    await transport.handleRequest(req, res);
  }

  private buildServer(): Server {
    const server = new Server(
      { name: this.serverName, version: this.serverVersion },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: this.tools.map((t) => ({
        name: t.toolName,
        description: t.description,
        inputSchema: t.inputSchema as { type: 'object' },
        outputSchema: t.outputSchema as { type: 'object' },
      })),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const result = await dispatchTool(
          this.core,
          this.tools,
          request.params.name,
          request.params.arguments ?? {},
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result as Record<string, unknown>,
        };
      } catch (err) {
        const message =
          err instanceof CapabilityFault
            ? `${err.code}: ${err.message}${err.details ? ` ${JSON.stringify(err.details)}` : ''}`
            : String(err);
        return { content: [{ type: 'text', text: message }], isError: true };
      }
    });

    return server;
  }
}
