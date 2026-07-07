/**
 * Framework glyphs for the gallery card, keyed by DiscoveredServer.frameworkId.
 * Inline SVG only — the renderer CSP is `img-src 'self' data:`, so no remote
 * icon CDNs. Each entry is a simplified, single-colour mark that reads at 20px.
 * `currentColor` lets the card tint them; a couple keep brand colour inline.
 */

const G = (body: string): string =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${body}</svg>`;

const ICONS: Record<string, string> = {
  react: G(
    `<circle cx="12" cy="12" r="2" fill="#61dafb"/>` +
      `<g stroke="#61dafb" stroke-width="1" fill="none">` +
      `<ellipse cx="12" cy="12" rx="10" ry="4"/>` +
      `<ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)"/>` +
      `<ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)"/></g>`,
  ),
  vue: G(
    `<path d="M2 3h4l6 10L18 3h4L12 21z" fill="#41b883"/>` +
      `<path d="M6 3h3l3 5 3-5h3l-6 10z" fill="#35495e"/>`,
  ),
  svelte: G(`<path d="M6 20c-2-3-1-6 2-8l6-4c3-2 7-1 8 2s0 6-3 8l-6 4c-3 2-6 1-7-2z" fill="#ff3e00"/>`),
  angular: G(
    `<path d="M12 2l9 3-1.5 13L12 22l-7.5-4L3 5z" fill="#dd0031"/>` +
      `<path d="M12 5v13l5-3 1-9z" fill="#c3002f"/>` +
      `<path d="M9.5 15h5l-1-2.5H10.5zM12 8l1.5 3.5h-3z" fill="#fff"/>`,
  ),
  next: G(`<circle cx="12" cy="12" r="10" fill="#000"/><path d="M8 8v8M8 8l8 10M16 8v6" stroke="#fff" stroke-width="1.5"/>`),
  nuxt: G(`<path d="M2 20L10 6l4 7-3 5H2z" fill="#00dc82"/><path d="M11 20l6-11 5 11z" fill="#108775"/>`),
  remix: G(`<rect x="3" y="3" width="18" height="18" rx="4" fill="#000"/><path d="M8 16v-4h5a2 2 0 010 4M8 12V8h5a2 2 0 010 4" stroke="#fff" stroke-width="1.4" fill="none"/>`),
  astro: G(`<path d="M12 2l6 18-6-4-6 4z" fill="currentColor"/>`),
  vite: G(
    `<path d="M12 3l9 2-9 16L3 5z" fill="#646cff"/>` +
      `<path d="M12 6l5 1-5 11-5-11z" fill="#ffb020"/>`,
  ),
  express: G(`<text x="12" y="16" font-size="11" font-family="monospace" text-anchor="middle" fill="currentColor">ex</text>`),
  nest: G(`<path d="M12 2l8 4v12l-8 4-8-4V6z" fill="#e0234e"/>`),
  koa: G(`<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/>`),
  fastify: G(`<path d="M3 12h18M3 12l6-6M3 12l6 6" stroke="#000" stroke-width="1.6" fill="none"/>`),
  hapi: G(`<circle cx="12" cy="12" r="9" fill="#f5901e"/>`),
  solid: G(`<ellipse cx="12" cy="12" rx="10" ry="5" fill="#2c4f7c"/><circle cx="12" cy="12" r="3" fill="#4f88c6"/>`),
  python: G(
    `<path d="M12 3c-3 0-4 1-4 3v2h5v1H6c-2 0-3 1-3 4s1 4 3 4h1v-3c0-2 1-3 3-3h4c2 0 3-1 3-3V6c0-2-1-3-4-3z" fill="#3776ab"/>` +
      `<circle cx="9" cy="6" r="1" fill="#fff"/>`,
  ),
  go: G(`<text x="12" y="16" font-size="10" font-family="monospace" text-anchor="middle" fill="#00add8">go</text>`),
  ruby: G(`<path d="M4 8l8-5 8 5-4 11H8z" fill="#cc342d"/>`),
  node: G(`<path d="M12 2l9 5v10l-9 5-9-5V7z" fill="#539e43"/>`),
};

const FALLBACK = G(
  `<rect x="4" y="4" width="16" height="16" rx="3" fill="none" stroke="currentColor" stroke-width="1.5"/>` +
    `<path d="M9 9l-2 3 2 3M15 9l2 3-2 3" stroke="currentColor" stroke-width="1.3" fill="none"/>`,
);

/** SVG markup for a frameworkId; a generic braces glyph when unknown. */
export function frameworkIcon(frameworkId?: string): string {
  return (frameworkId && ICONS[frameworkId]) || FALLBACK;
}
