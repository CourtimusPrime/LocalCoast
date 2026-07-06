import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DiscoveredServer, ProcessInspector } from '@localcoast/core';

const exec = promisify(execFile);

/**
 * Tier-0 port/process discovery (AD-8, infra #11): `lsof` for listeners,
 * `lsof -a -d cwd` for working directories, `ps eww` for env-at-spawn.
 * macOS + Linux. Ports bound by our own pid tree (the MCP server, Electron
 * helpers) are filtered out.
 */
export class LsofInspector implements ProcessInspector {
  constructor(private readonly excludePorts: () => number[] = () => []) {}

  async listListeningServers(): Promise<DiscoveredServer[]> {
    let stdout: string;
    try {
      ({ stdout } = await exec('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-FpcnT'], {
        timeout: 5000,
      }));
    } catch (err) {
      // lsof exits 1 when some pids are inaccessible but still prints the rest.
      stdout = (err as { stdout?: string }).stdout ?? '';
    }

    const excluded = new Set(this.excludePorts());
    const servers = new Map<number, DiscoveredServer>();
    let pid = 0;
    let cmd = '';
    for (const line of stdout.split('\n')) {
      const tag = line[0];
      const value = line.slice(1);
      if (tag === 'p') pid = Number(value);
      else if (tag === 'c') cmd = value;
      else if (tag === 'n') {
        const match = /:(\d+)$/.exec(value);
        if (!match) continue;
        const port = Number(match[1]);
        // Dev servers only: unprivileged ports, loopback or wildcard binds.
        const local =
          value.startsWith('127.0.0.1:') ||
          value.startsWith('[::1]:') ||
          value.startsWith('*:') ||
          value.startsWith('[::]:');
        if (!local || port < 1024 || excluded.has(port) || pid === process.pid) continue;
        if (!servers.has(port)) {
          servers.set(port, { port, pid, cmd, protocol: 'http' });
        }
      }
    }

    await Promise.all(
      [...servers.values()].map(async (srv) => {
        if (!srv.pid) return;
        try {
          const { stdout: cwdOut } = await exec(
            'lsof',
            ['-a', '-p', String(srv.pid), '-d', 'cwd', '-Fn'],
            { timeout: 3000 },
          );
          const line = cwdOut.split('\n').find((l) => l.startsWith('n'));
          if (line) srv.cwd = line.slice(1);
        } catch {
          // cwd unavailable (permissions) — tier badge stays honest.
        }
      }),
    );

    return [...servers.values()].sort((a, b) => a.port - b.port);
  }

  async envOf(pid: number): Promise<Record<string, string> | undefined> {
    try {
      if (process.platform === 'darwin') {
        const { stdout } = await exec('ps', ['eww', '-o', 'command=', '-p', String(pid)], {
          timeout: 3000,
        });
        const env: Record<string, string> = {};
        for (const token of stdout.split(' ')) {
          const eq = token.indexOf('=');
          if (eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(token.slice(0, eq))) {
            env[token.slice(0, eq)] = token.slice(eq + 1).trim();
          }
        }
        return Object.keys(env).length > 0 ? env : undefined;
      }
      const { readFile } = await import('node:fs/promises');
      const raw = await readFile(`/proc/${pid}/environ`, 'utf8');
      const env: Record<string, string> = {};
      for (const pair of raw.split('\0')) {
        const eq = pair.indexOf('=');
        if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
      return env;
    } catch {
      return undefined;
    }
  }
}
