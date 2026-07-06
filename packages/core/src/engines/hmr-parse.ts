/**
 * HMR/build sniff parsers (AD-8 Tier 0, infra #12). The guest's Vite/webpack/
 * Next HMR WebSocket already flows through CDP WS capture — parse those frames
 * into normalized build-status / hmr-update / build-error signals with zero
 * setup. One parser per tool; `sniff` picks by frame shape.
 */

export interface HmrSignal {
  kind: 'build.status' | 'hmr.update' | 'build.error';
  tool: 'vite' | 'webpack' | 'next' | 'turbopack';
  state?: 'building' | 'ok' | 'error';
  updateKind?: 'hot' | 'full';
  file?: string;
  modules?: string[];
  message?: string;
  errorFile?: string;
  errorLine?: number;
}

export function sniffHmrFrame(payload: string): HmrSignal[] {
  let msg: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(payload);
    if (parsed === null || typeof parsed !== 'object') return [];
    msg = parsed as Record<string, unknown>;
  } catch {
    return [];
  }

  const type = msg.type as string | undefined;

  // -- Vite: { type: 'update'|'full-reload'|'error', updates: [{path,...}] } --
  if (type === 'update' && Array.isArray(msg.updates)) {
    return (msg.updates as Array<{ path?: string; acceptedPath?: string }>).map((u) => ({
      kind: 'hmr.update' as const,
      tool: 'vite' as const,
      updateKind: 'hot' as const,
      file: u.path ?? u.acceptedPath,
    }));
  }
  if (type === 'full-reload') {
    return [{ kind: 'hmr.update', tool: 'vite', updateKind: 'full', file: msg.path as string | undefined }];
  }
  if (type === 'error') {
    const err = msg.err as { message?: string; id?: string; loc?: { line?: number } } | undefined;
    return [
      { kind: 'build.status', tool: 'vite', state: 'error' },
      {
        kind: 'build.error',
        tool: 'vite',
        message: err?.message ?? 'build error',
        errorFile: err?.id,
        errorLine: err?.loc?.line,
      },
    ];
  }

  // -- webpack-dev-server / HMR: { type: 'ok'|'hash'|'errors'|'warnings'|'invalid' } --
  if (type === 'invalid') return [{ kind: 'build.status', tool: 'webpack', state: 'building' }];
  if (type === 'ok') return [{ kind: 'build.status', tool: 'webpack', state: 'ok' }];
  if (type === 'static-changed') {
    return [{ kind: 'hmr.update', tool: 'webpack', updateKind: 'full' }];
  }
  if (type === 'errors' && Array.isArray(msg.data)) {
    const signals: HmrSignal[] = [{ kind: 'build.status', tool: 'webpack', state: 'error' }];
    for (const e of msg.data as Array<{ message?: string; moduleName?: string } | string>) {
      signals.push({
        kind: 'build.error',
        tool: 'webpack',
        message: typeof e === 'string' ? e : (e.message ?? 'build error'),
        errorFile: typeof e === 'string' ? undefined : e.moduleName,
      });
    }
    return signals;
  }

  // -- Next.js (turbopack/webpack) HMR: { action: 'building'|'built'|'sync', ... } --
  const action = msg.action as string | undefined;
  if (action === 'building') return [{ kind: 'build.status', tool: 'next', state: 'building' }];
  if (action === 'built' || action === 'sync') {
    const signals: HmrSignal[] = [{ kind: 'build.status', tool: 'next', state: 'ok' }];
    const errors = msg.errors as unknown[] | undefined;
    if (errors && errors.length > 0) {
      signals[0]!.state = 'error';
      for (const e of errors) {
        signals.push({ kind: 'build.error', tool: 'next', message: String(e) });
      }
    } else {
      signals.push({ kind: 'hmr.update', tool: 'next', updateKind: 'hot' });
    }
    return signals;
  }

  return [];
}
