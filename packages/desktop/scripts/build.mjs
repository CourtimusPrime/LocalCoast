import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

/**
 * Desktop build: main as ESM (import.meta.url must survive for core's worker
 * URL resolution — workspace deps stay external), preload bundled to CJS
 * (sandboxed preloads cannot load ESM), renderer bundled for the browser.
 */

await build({
  entryPoints: ['src/main/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'dist/main.mjs',
  external: ['electron', '@localcoast/core', '@localcoast/mcp', '@localcoast/page-agent', '@localcoast/protocol-types', 'better-sqlite3', 'zod', '@modelcontextprotocol/sdk'],
  sourcemap: true,
});

await build({
  entryPoints: ['src/preload/preload.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist/preload.cjs',
  external: ['electron'],
  sourcemap: true,
});

await build({
  entryPoints: ['src/renderer/main.ts'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  outfile: 'dist/renderer/bundle.js',
  sourcemap: true,
});

mkdirSync('dist/renderer', { recursive: true });
cpSync('src/renderer/index.html', 'dist/renderer/index.html');
cpSync('src/renderer/styles.css', 'dist/renderer/styles.css');
console.log('desktop build done');
