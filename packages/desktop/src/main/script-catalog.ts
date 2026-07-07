import { AnyMap, type TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
import type { GuestCdp } from './cdp-mux.js';

interface ScriptInfo {
  url: string;
  sourceMapURL?: string;
}

export interface OriginalLocation {
  /** Bundler-flavored source path (e.g. turbopack://[project]/components/X.tsx). */
  source: string;
  /** 1-based line in the original source. */
  line: number;
}

/**
 * scriptId → source URL + source map (Debugger.scriptParsed). Powers the L2
 * universal source-resolution fallback (AD-3): component function →
 * [[FunctionLocation]] → scriptId → URL. Works on React 19 where _debugSource
 * is gone. When the script carries a source map, resolveOriginal() translates
 * the compiled position back to the ORIGINAL source file+line so bundled apps
 * (Next/Turbopack/webpack) resolve to `components/X.tsx`, not a `_next` chunk.
 */
export class ScriptCatalog {
  private scripts = new Map<string, ScriptInfo>();
  /** Parsed source maps, lazily loaded once per scriptId (null = unavailable). */
  private maps = new Map<string, Promise<TraceMap | null>>();
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly cdp: GuestCdp) {}

  async start(): Promise<void> {
    this.unsubscribe = this.cdp.onEvent(({ method, params }) => {
      if (method === 'Debugger.scriptParsed') {
        const url = params.url as string;
        if (url) {
          this.scripts.set(params.scriptId as string, {
            url,
            sourceMapURL: (params.sourceMapURL as string) || undefined,
          });
        }
      }
    });
    await this.cdp.enableDomain('Debugger');
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.scripts.clear();
    this.maps.clear();
  }

  urlOf(scriptId: string): string | undefined {
    return this.scripts.get(scriptId)?.url;
  }

  /**
   * Map a compiled (line0, column0) — CDP's 0-based coordinates — back to the
   * original source via the script's source map. Returns undefined when there
   * is no source map or it can't be resolved (caller keeps the compiled URL).
   */
  async resolveOriginal(
    scriptId: string,
    line0: number,
    column0: number,
  ): Promise<OriginalLocation | undefined> {
    const map = await this.loadMap(scriptId);
    if (!map) return undefined;
    // TraceMap wants 1-based line, 0-based column.
    const pos = originalPositionFor(map, { line: line0 + 1, column: column0 });
    if (!pos.source || pos.line == null) return undefined;
    return { source: pos.source, line: pos.line };
  }

  private loadMap(scriptId: string): Promise<TraceMap | null> {
    const cached = this.maps.get(scriptId);
    if (cached) return cached;
    const promise = this.fetchMap(scriptId);
    this.maps.set(scriptId, promise);
    return promise;
  }

  private async fetchMap(scriptId: string): Promise<TraceMap | null> {
    const info = this.scripts.get(scriptId);
    if (!info?.sourceMapURL) return null;
    try {
      const raw = await this.loadSourceMapText(info.sourceMapURL, info.url);
      // AnyMap (not TraceMap) so sectioned "index" maps — what Turbopack/webpack
      // emit per chunk — resolve as well as flat maps.
      return raw ? AnyMap(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  }

  private async loadSourceMapText(sourceMapURL: string, scriptUrl: string): Promise<string | null> {
    if (sourceMapURL.startsWith('data:')) {
      const comma = sourceMapURL.indexOf(',');
      if (comma === -1) return null;
      const meta = sourceMapURL.slice(5, comma);
      const data = sourceMapURL.slice(comma + 1);
      return meta.includes('base64')
        ? Buffer.from(data, 'base64').toString('utf8')
        : decodeURIComponent(data);
    }
    // Sibling/absolute URL — resolve against the script URL and fetch it
    // (dev-server source maps are public and same-origin as localhost).
    let resolved: string;
    try {
      resolved = new URL(sourceMapURL, scriptUrl).href;
    } catch {
      return null;
    }
    if (!/^https?:/.test(resolved)) return null;
    const res = await fetch(resolved);
    return res.ok ? await res.text() : null;
  }
}

/**
 * Normalize a bundler-flavored source URL to a repo-relative path:
 *   webpack://pkg/./src/App.tsx → src/App.tsx
 *   turbopack://[project]/components/App.tsx → components/App.tsx
 *   http://localhost:5173/src/App.tsx?t=123 → src/App.tsx
 *   /@fs/abs/path (vite) and file paths → relative to projectRoot when known
 */
export function relativizeSourcePath(raw: string, projectRoot?: string): string {
  let path = raw;
  // Absolute file URLs (Turbopack/webpack index-map sources) → absolute path,
  // so the projectRoot strip below can make it repo-relative.
  if (path.startsWith('file://')) {
    try {
      path = decodeURIComponent(new URL(path).pathname);
    } catch {
      /* leave as-is */
    }
  } else {
    // Bundler scheme prefixes: webpack://<ns>/, turbopack://[project]/, rspack://…
    // The namespace/[project] segment is a placeholder, not a real dir.
    const scheme = /^[a-z]+:\/\/(?:\[[^\]]*\]|[^/]*)\/(.+)$/.exec(path);
    if (scheme) path = scheme[1]!;
  }
  path = path.replace(/^\.\//, '');
  const http = /^https?:\/\/[^/]+\/(.+)$/.exec(path);
  if (http) path = http[1]!;
  path = path.split('?')[0]!;
  if (path.startsWith('/@fs/')) path = path.slice('/@fs'.length);
  if (projectRoot && path.startsWith(projectRoot)) {
    path = path.slice(projectRoot.length).replace(/^\//, '');
  }
  // Strip common bundler-internal prefixes left after the namespace.
  path = path.replace(/^\.\//, '').replace(/^\(app-[^)]*\)\//, '');
  return path;
}
