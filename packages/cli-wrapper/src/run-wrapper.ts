import { spawn } from 'node:child_process';
import { IngestClient } from './ingest-client.js';
import { parseStructuredLog } from '@localcoast/core';

/**
 * `localcoast run <cmd...>` (AD-8 Tier 2): owns the dev server's stdout/stderr
 * and forwards it to the live instance as console entries (server source),
 * parsing structured JSON logs on the way. Output is also mirrored to our own
 * stdio so the terminal experience is unchanged. Process ownership also lights
 * up safe restart, but this wrapper's job is capture.
 */
export async function runWrapper(argv: string[]): Promise<void> {
  if (argv.length === 0) {
    console.error('usage: localcoast run <command> [args...]');
    process.exit(1);
  }

  const ingest = new IngestClient();
  const connected = await ingest.connect(6);
  if (!connected) {
    console.error('[localcoast] no running instance found — logs will not be captured, but the command still runs.');
  }

  const child = spawn(argv[0]!, argv.slice(1), {
    stdio: ['inherit', 'pipe', 'pipe'],
    env: { ...process.env, LOCALCOAST_WRAPPED: '1' },
  });

  const forward = (chunk: Buffer, stream: NodeJS.WriteStream, level: 'log' | 'error') => {
    stream.write(chunk);
    for (const line of chunk.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      const structured = parseStructuredLog(line);
      ingest.send({
        type: 'console.entry',
        actor: 'app',
        payload: {
          level: structured?.levelLabel
            ? levelFromLabel(structured.levelLabel)
            : level,
          source: 'server',
          text: (structured?.message ?? line).slice(0, 8192),
          structured: structured
            ? { levelLabel: structured.levelLabel, serviceName: structured.serviceName, fields: structured.fields }
            : undefined,
        },
      });
    }
  };

  child.stdout.on('data', (c: Buffer) => forward(c, process.stdout, 'log'));
  child.stderr.on('data', (c: Buffer) => forward(c, process.stderr, 'error'));
  child.on('exit', (code) => process.exit(code ?? 0));
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
}

function levelFromLabel(label: string): 'debug' | 'log' | 'info' | 'warn' | 'error' {
  return (
    { trace: 'debug', debug: 'debug', info: 'info', warn: 'warn', warning: 'warn', error: 'error', fatal: 'error' } as const
  )[label] ?? 'log';
}
