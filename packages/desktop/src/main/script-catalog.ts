import type { GuestCdp } from './cdp-mux.js';

/**
 * scriptId → source URL map (Debugger.scriptParsed). Needed for the L2
 * universal source-resolution fallback (AD-3): component function →
 * [[FunctionLocation]] → scriptId → URL → repo-relative path. Works on React
 * 19 where _debugSource is gone.
 */
export class ScriptCatalog {
  private urls = new Map<string, string>();
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly cdp: GuestCdp) {}

  async start(): Promise<void> {
    this.unsubscribe = this.cdp.onEvent(({ method, params }) => {
      if (method === 'Debugger.scriptParsed') {
        const url = params.url as string;
        if (url) this.urls.set(params.scriptId as string, url);
      }
    });
    await this.cdp.enableDomain('Debugger');
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  urlOf(scriptId: string): string | undefined {
    return this.urls.get(scriptId);
  }
}

/**
 * Normalize a bundler-flavored source URL to a repo-relative path:
 *   webpack://pkg/./src/App.tsx → src/App.tsx
 *   http://localhost:5173/src/App.tsx?t=123 → src/App.tsx
 *   /@fs/abs/path (vite) and file paths → relative to projectRoot when known
 */
export function relativizeSourcePath(raw: string, projectRoot?: string): string {
  let path = raw;
  const webpack = /^webpack:\/\/[^/]*\/(.+)$/.exec(path);
  if (webpack) path = webpack[1]!;
  path = path.replace(/^\.\//, '');
  const http = /^https?:\/\/[^/]+\/(.+)$/.exec(path);
  if (http) path = http[1]!;
  path = path.split('?')[0]!;
  if (path.startsWith('/@fs/')) path = path.slice('/@fs'.length);
  if (projectRoot && path.startsWith(projectRoot)) {
    path = path.slice(projectRoot.length).replace(/^\//, '');
  }
  return path;
}
