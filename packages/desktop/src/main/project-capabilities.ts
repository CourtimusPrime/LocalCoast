import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { shell } from 'electron';
import { CapabilityFault, type Core, type ProcessInspector } from '@localcoast/core';
import {
  FixtureLoadInput,
  FixtureLoadOutput,
  FixtureSchema,
  PortProfileSchema,
  SafeName,
  TargetKillInput,
  TargetKillOutput,
  TargetOpenExternalInput,
  TargetOpenExternalOutput,
} from '@localcoast/protocol-types';
import { z } from 'zod';
import type { MockEngine } from './mocks.js';
import type { TabManager } from './tabs.js';

const exec = promisify(execFile);

/**
 * Defense-in-depth against path traversal: schemas already constrain artifact
 * names (SafeName), but any name that reaches a filesystem join is re-checked
 * here so a future schema regression can't open a traversal hole.
 */
export function assertSafeName(name: string): string {
  const parsed = SafeName.safeParse(name);
  if (!parsed.success || basename(name) !== name) {
    throw new CapabilityFault('invalid_input', `unsafe artifact name: ${name}`);
  }
  return name;
}

/**
 * Project & configuration intelligence (AD-8 Tier 1, infra #8) + Fixture
 * composition (infra #5). Committable `.localcoast/` artifacts are read/written
 * under the target's project root (inferred from pid cwd).
 */
export function registerProjectCapabilities(
  core: Core,
  tabs: TabManager,
  mocks: MockEngine,
  inspector: ProcessInspector,
): void {
  async function rootFor(sessionId: string): Promise<string> {
    const tab = tabs.get(sessionId);
    if (!tab) throw new CapabilityFault('target_gone', `no open tab ${sessionId}`);
    const servers = await inspector.listListeningServers();
    const root = servers.find((s) => s.port === tab.port)?.cwd;
    if (!root) throw new CapabilityFault('tier_unavailable', 'project root not inferable (Tier 1 needs pid cwd)');
    return root;
  }

  // -- port conflict resolver ------------------------------------------------------

  core.registry.registerQuery({
    name: 'ports.conflict',
    description:
      'Identify the process holding a port (leftover dev server, system service, another project) so a conflict can be understood and resolved.',
    input: z.object({ port: z.number().int().min(1).max(65535) }),
    output: z.object({
      port: z.number().int(),
      inUse: z.boolean(),
      pid: z.number().int().optional(),
      command: z.string().optional(),
      cwd: z.string().optional(),
    }),
    handler: async (input) => {
      const servers = await inspector.listListeningServers();
      const match = servers.find((s) => s.port === input.port);
      return {
        port: input.port,
        inUse: match !== undefined,
        pid: match?.pid,
        command: match?.cmd,
        cwd: match?.cwd,
      };
    },
  });

  core.registry.registerCommand({
    name: 'ports.release',
    description:
      'Release a port by terminating the process holding it (SIGTERM). Destructive — targets the exact pid from ports.conflict. Use to clear a leftover dev server blocking a restart.',
    input: z.object({ port: z.number().int().min(1).max(65535) }),
    output: z.object({ released: z.boolean(), pid: z.number().int().optional() }),
    surfaces: { palette: true },
    paletteTitle: 'Release port…',
    handler: async (input) => {
      const servers = await inspector.listListeningServers();
      const match = servers.find((s) => s.port === input.port);
      if (!match?.pid) return { released: false };
      try {
        process.kill(match.pid, 'SIGTERM');
        return { released: true, pid: match.pid };
      } catch {
        return { released: false, pid: match.pid };
      }
    },
  });

  // -- gallery card actions --------------------------------------------------------

  core.registry.registerCommand({
    name: 'targets.openExternal',
    description:
      "Open a discovered server's URL (http://localhost:<port>) in the OS default browser.",
    input: TargetOpenExternalInput,
    output: TargetOpenExternalOutput,
    surfaces: { palette: true },
    paletteTitle: 'Open in browser…',
    handler: async (input) => {
      await shell.openExternal(`http://localhost:${input.port}/`);
      return { opened: true };
    },
  });

  core.registry.registerCommand({
    name: 'targets.kill',
    description:
      'Terminate the dev-server process holding a port (SIGTERM). Destructive — the server stops. Used by the gallery card Kill action.',
    input: TargetKillInput,
    output: TargetKillOutput,
    surfaces: { palette: true },
    paletteTitle: 'Kill server…',
    handler: async (input) => {
      const servers = await inspector.listListeningServers();
      const match = servers.find((s) => s.port === input.port);
      if (!match?.pid) return { killed: false };
      try {
        process.kill(match.pid, 'SIGTERM');
        return { killed: true, pid: match.pid };
      } catch {
        return { killed: false, pid: match.pid };
      }
    },
  });

  // -- port profiles ---------------------------------------------------------------

  core.registry.registerCommand({
    name: 'profile.save',
    description:
      'Save a named port profile (which ports to load, which panels to open, breakpoint, pinned snapshots) into .localcoast/profiles/<name>.json — committable so the whole team opens the same view.',
    input: z.object({
      sessionId: z.string(),
      profile: PortProfileSchema.omit({ version: true, kind: true }),
    }),
    output: z.object({ path: z.string() }),
    surfaces: { palette: true },
    paletteTitle: 'Save port profile…',
    handler: async (input) => {
      const root = await rootFor(input.sessionId);
      const dir = join(root, '.localcoast', 'profiles');
      await mkdir(dir, { recursive: true });
      const path = join(dir, `${assertSafeName(input.profile.name)}.json`);
      await writeFile(
        path,
        JSON.stringify(PortProfileSchema.parse({ version: 1, kind: 'portProfile', ...input.profile }), null, 2),
      );
      return { path };
    },
  });

  core.registry.registerCommand({
    name: 'profile.load',
    description:
      'Load a saved port profile and open its ports as tabs. Returns the opened session ids. Restores the committed team view.',
    input: z.object({ sessionId: z.string(), name: SafeName }),
    output: z.object({ opened: z.array(z.object({ port: z.number().int(), sessionId: z.string() })) }),
    surfaces: { palette: true },
    paletteTitle: 'Load port profile…',
    handler: async (input) => {
      const root = await rootFor(input.sessionId);
      const raw = await readFile(join(root, '.localcoast', 'profiles', `${assertSafeName(input.name)}.json`), 'utf8').catch(() => {
        throw new CapabilityFault('not_found', `profile ${input.name}`);
      });
      const profile = PortProfileSchema.parse(JSON.parse(raw));
      const opened: Array<{ port: number; sessionId: string }> = [];
      for (const p of profile.ports) {
        const tab = await tabs.open(p.port);
        opened.push({ port: p.port, sessionId: tab.sessionId });
      }
      return { opened };
    },
  });

  // -- fixtures (mocks + auth + snapshot in one action) -----------------------------

  core.registry.registerCommand({
    name: 'fixture.load',
    description:
      'Fixture Management: one named action that simultaneously seeds mock intercepts, injects auth tokens, and restores an app-state snapshot — collapsing multi-step setup into a single known-state load. Fixtures live in .localcoast/fixtures and are committable.',
    input: FixtureLoadInput,
    output: FixtureLoadOutput,
    surfaces: { palette: true },
    paletteTitle: 'Load fixture…',
    handler: async (input) => {
      const root = await rootFor(input.sessionId);
      const raw = await readFile(join(root, '.localcoast', 'fixtures', `${assertSafeName(input.name)}.json`), 'utf8').catch(() => {
        throw new CapabilityFault('not_found', `fixture ${input.name}`);
      });
      const fixture = FixtureSchema.parse(JSON.parse(raw));

      let mockCount = 0;
      for (const m of fixture.mocks) {
        await mocks.set({ pattern: m.pattern, response: m.response });
        mockCount++;
      }
      let tokenCount = 0;
      for (const t of fixture.authTokens) {
        await core.command(
          'auth.inject',
          { sessionId: input.sessionId, token: t.token, placement: t.placement, key: t.key, cookieFlags: t.cookieFlags },
          { actor: 'system' },
        );
        tokenCount++;
      }
      let snapshotRestored = false;
      if (fixture.snapshotName) {
        const snapshots = (await core.query('snapshots.list', { sessionId: input.sessionId }, { actor: 'system' })) as {
          snapshots: Array<{ snapshotId: string; name?: string }>;
        };
        const snap = snapshots.snapshots.find((s) => s.name === fixture.snapshotName);
        if (snap) {
          await core.command('snapshot.restore', { snapshotId: snap.snapshotId }, { actor: 'system' });
          snapshotRestored = true;
        }
      }
      return { applied: { mocks: mockCount, tokens: tokenCount, snapshotRestored } };
    },
  });

  core.registry.registerQuery({
    name: 'fixture.list',
    description: 'List committed fixtures available under .localcoast/fixtures for the target project.',
    input: z.object({ sessionId: z.string() }),
    output: z.object({ fixtures: z.array(z.object({ name: z.string(), description: z.string().optional() })) }),
    handler: async (input) => {
      const root = await rootFor(input.sessionId);
      const dir = join(root, '.localcoast', 'fixtures');
      const files = await readdir(dir).catch(() => [] as string[]);
      const fixtures: Array<{ name: string; description?: string }> = [];
      for (const file of files.filter((f) => f.endsWith('.json'))) {
        try {
          const parsed = FixtureSchema.parse(JSON.parse(await readFile(join(dir, file), 'utf8')));
          fixtures.push({ name: parsed.name, description: parsed.description });
        } catch {
          /* skip malformed */
        }
      }
      return { fixtures };
    },
  });

  // -- env inspector (Tier 1) -------------------------------------------------------

  core.registry.registerQuery({
    name: 'env.inspect',
    description:
      'Environment Variable Inspector: variables loaded into the running process (from ps env-at-spawn), with which .env file each was likely sourced from and any required vars missing versus .env.example.',
    input: z.object({ sessionId: z.string() }),
    output: z.object({
      vars: z.array(z.object({ key: z.string(), value: z.string(), source: z.string().optional() })),
      missing: z.array(z.string()),
    }),
    handler: async (input) => {
      const tab = tabs.get(input.sessionId);
      if (!tab) throw new CapabilityFault('target_gone', `no open tab ${input.sessionId}`);
      const servers = await inspector.listListeningServers();
      const server = servers.find((s) => s.port === tab.port);
      const runtimeEnv = server?.pid ? await inspector.envOf(server.pid) : undefined;
      const root = server?.cwd;

      // Attribute each var to the .env file whose content matches.
      const sources = new Map<string, string>();
      if (root) {
        for (const name of ['.env.local', '.env.development', '.env']) {
          const content = await readFile(join(root, name), 'utf8').catch(() => '');
          for (const line of content.split('\n')) {
            const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
            if (m && !sources.has(m[1]!)) sources.set(m[1]!, name);
          }
        }
      }
      const example = root ? await readFile(join(root, '.env.example'), 'utf8').catch(() => '') : '';
      const required = [...example.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)].map((m) => m[1]!);

      const vars = Object.entries(runtimeEnv ?? {})
        .filter(([k]) => sources.has(k))
        .map(([key, value]) => ({ key, value, source: sources.get(key) }));
      const present = new Set(Object.keys(runtimeEnv ?? {}));
      const missing = required.filter((r) => !present.has(r));
      return { vars, missing };
    },
  });

  void exec; // reserved for git-sha stamping in a later pass
}
