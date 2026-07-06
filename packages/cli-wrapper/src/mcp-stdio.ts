import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readInstanceInfo } from '@localcoast/mcp';

/**
 * Thin stdio↔HTTP shim (AD-7): lets stdio-only MCP clients attach to the one
 * live LocalCoast instance instead of spawning a second headless copy. Pure
 * message-level proxy — no MCP semantics live here; the session belongs to the
 * HTTP server.
 */

const RETRY_MS = 500;
const RETRIES = 10;

export async function runMcpStdio(): Promise<void> {
  let instance = await readInstanceInfo();
  for (let i = 0; !instance && i < RETRIES; i++) {
    await new Promise((r) => setTimeout(r, RETRY_MS));
    instance = await readInstanceInfo();
  }
  if (!instance) {
    console.error(
      'localcoast mcp-stdio: no running LocalCoast instance found (~/.localcoast/instance.json missing or stale). Start the LocalCoast app, then retry.',
    );
    process.exit(1);
  }

  const http = new StreamableHTTPClientTransport(new URL(instance.url), {
    requestInit: { headers: { Authorization: `Bearer ${instance.token}` } },
  });
  const stdio = new StdioServerTransport();

  stdio.onmessage = (msg) => {
    void http.send(msg).catch((err) => {
      console.error(`localcoast mcp-stdio: upstream send failed: ${err}`);
      process.exit(1);
    });
  };
  http.onmessage = (msg) => {
    void stdio.send(msg);
  };
  const shutdown = () => {
    void Promise.allSettled([http.close(), stdio.close()]).then(() => process.exit(0));
  };
  stdio.onclose = shutdown;
  http.onclose = shutdown;
  http.onerror = (err) => console.error(`localcoast mcp-stdio: upstream error: ${err}`);

  await http.start();
  await stdio.start();
}
