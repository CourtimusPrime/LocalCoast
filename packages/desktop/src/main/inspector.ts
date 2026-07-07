import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
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
        // Human label for the server-list card: package.json name, else a
        // meaningful folder name (walking past technical dirs like src/backend).
        if (srv.cwd) {
          srv.projectName = await deriveProjectName(srv.cwd);
          const cls = await classifyServer(srv.cwd, srv.cmd);
          srv.serverType = cls.serverType;
          srv.frameworkId = cls.frameworkId;
          srv.frameworkHint = cls.frameworkHint;
        }
      }),
    );

    // One batched `ps` for CPU / RSS / start-time across all discovered pids.
    await this.attachProcessMetrics([...servers.values()]);

    return [...servers.values()].sort((a, b) => a.port - b.port);
  }

  /** Fill cpuPercent / memBytes / startedAtWall via a single `ps` call. */
  private async attachProcessMetrics(servers: DiscoveredServer[]): Promise<void> {
    const pids = servers.map((s) => s.pid).filter((p): p is number => typeof p === 'number');
    if (pids.length === 0) return;
    let stdout: string;
    try {
      // lstart is a fixed-width date ("Wed Jul  2 09:14:03 2025"); keep it last.
      ({ stdout } = await exec(
        'ps',
        ['-o', 'pid=,%cpu=,rss=,lstart=', '-p', pids.join(',')],
        { timeout: 3000 },
      ));
    } catch (err) {
      stdout = (err as { stdout?: string }).stdout ?? '';
    }
    const byPid = new Map(servers.map((s) => [s.pid, s]));
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // pid %cpu rss <lstart: 5 whitespace-separated tokens>
      const parts = trimmed.split(/\s+/);
      if (parts.length < 4) continue;
      const pid = Number(parts[0]);
      const srv = byPid.get(pid);
      if (!srv) continue;
      const cpu = Number(parts[1]);
      const rssKb = Number(parts[2]);
      if (Number.isFinite(cpu)) srv.cpuPercent = cpu;
      if (Number.isFinite(rssKb)) srv.memBytes = rssKb * 1024;
      const lstart = parts.slice(3).join(' ');
      const started = Date.parse(lstart);
      if (Number.isFinite(started)) srv.startedAtWall = started;
    }
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

/** Folder names that describe project structure, not the project itself. */
export const TECHNICAL_DIR_NAMES = new Set([
  'src',
  'backend',
  'frontend',
  'server',
  'client',
  'app',
  'apps',
  'web',
  'api',
  'dist',
  'build',
  'packages',
  'public',
  'www',
]);

/** True when `name` is a structural folder token rather than a project name. */
export function isTechnicalName(name: string): boolean {
  return TECHNICAL_DIR_NAMES.has(name.toLowerCase());
}

async function pkgNameAt(dir: string): Promise<string | undefined> {
  try {
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { name?: unknown };
    if (typeof pkg.name === 'string' && pkg.name.trim()) {
      // Strip an npm scope ("@acme/gopher" → "gopher") for a cleaner card label.
      const raw = pkg.name.trim();
      const unscoped = raw.startsWith('@') && raw.includes('/') ? raw.split('/')[1] : raw;
      return unscoped || raw;
    }
  } catch {
    // no package.json / unreadable / malformed.
  }
  return undefined;
}

/**
 * Human label for the card: package.json `name`, else the folder name — but if
 * that folder name is a technical token (src/backend/frontend…), walk parents
 * until a real project name is found. Bounded to a few hops, stops at $HOME/root.
 */
export async function deriveProjectName(cwd: string): Promise<string> {
  const home = homedir();
  let dir = cwd;
  for (let hops = 0; hops < 5; hops++) {
    const named = await pkgNameAt(dir);
    if (named && !isTechnicalName(named)) return named;
    const folder = basename(dir);
    if (folder && !isTechnicalName(folder)) return folder;
    const parent = dirname(dir);
    if (parent === dir || dir === home || parent === home) break;
    dir = parent;
  }
  return basename(cwd);
}

interface Classification {
  serverType?: 'frontend' | 'backend' | 'fullstack';
  frameworkId?: string;
  frameworkHint?: string;
}

/** Ordered dep → (type, id, label). First match wins. */
const FRAMEWORK_TABLE: Array<{
  dep: string;
  serverType: 'frontend' | 'backend' | 'fullstack';
  id: string;
  hint: string;
}> = [
  { dep: 'next', serverType: 'fullstack', id: 'next', hint: 'Next.js' },
  { dep: 'nuxt', serverType: 'fullstack', id: 'nuxt', hint: 'Nuxt' },
  { dep: '@remix-run/react', serverType: 'fullstack', id: 'remix', hint: 'Remix' },
  { dep: 'remix', serverType: 'fullstack', id: 'remix', hint: 'Remix' },
  { dep: '@sveltejs/kit', serverType: 'fullstack', id: 'svelte', hint: 'SvelteKit' },
  { dep: 'astro', serverType: 'fullstack', id: 'astro', hint: 'Astro' },
  { dep: '@nestjs/core', serverType: 'backend', id: 'nest', hint: 'NestJS' },
  { dep: 'express', serverType: 'backend', id: 'express', hint: 'Express' },
  { dep: 'fastify', serverType: 'backend', id: 'fastify', hint: 'Fastify' },
  { dep: 'koa', serverType: 'backend', id: 'koa', hint: 'Koa' },
  { dep: '@hapi/hapi', serverType: 'backend', id: 'hapi', hint: 'hapi' },
  { dep: '@angular/core', serverType: 'frontend', id: 'angular', hint: 'Angular' },
  { dep: 'react', serverType: 'frontend', id: 'react', hint: 'React' },
  { dep: 'vue', serverType: 'frontend', id: 'vue', hint: 'Vue' },
  { dep: 'svelte', serverType: 'frontend', id: 'svelte', hint: 'Svelte' },
  { dep: 'solid-js', serverType: 'frontend', id: 'solid', hint: 'Solid' },
  { dep: 'vite', serverType: 'frontend', id: 'vite', hint: 'Vite' },
];

/**
 * Pure classifier: given a merged deps map (name → version) and the process
 * command, return the type badge + framework. Unit-tested directly.
 */
export function classifyDeps(deps: Record<string, string>, cmd?: string): Classification {
  for (const row of FRAMEWORK_TABLE) {
    if (deps[row.dep]) {
      return { serverType: row.serverType, frameworkId: row.id, frameworkHint: row.hint };
    }
  }
  // No JS framework matched. Infer non-JS runtimes from the command → backend.
  const c = (cmd ?? '').toLowerCase();
  if (/python|gunicorn|uvicorn|flask|django/.test(c))
    return { serverType: 'backend', frameworkId: 'python', frameworkHint: 'Python' };
  if (/\bgo\b|main\.go/.test(c))
    return { serverType: 'backend', frameworkId: 'go', frameworkHint: 'Go' };
  if (/ruby|rails|puma/.test(c))
    return { serverType: 'backend', frameworkId: 'ruby', frameworkHint: 'Ruby' };
  if (Object.keys(deps).length > 0)
    return { serverType: 'backend', frameworkId: 'node', frameworkHint: 'Node' };
  return { serverType: 'backend' };
}

/** Read package.json deps at cwd (then one level up), classify. */
export async function classifyServer(cwd: string, cmd?: string): Promise<Classification> {
  for (const dir of [cwd, dirname(cwd)]) {
    try {
      const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (Object.keys(deps).length > 0) return classifyDeps(deps, cmd);
    } catch {
      // try the parent dir, then fall through.
    }
  }
  return classifyDeps({}, cmd);
}
