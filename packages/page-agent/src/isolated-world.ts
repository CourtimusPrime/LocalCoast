/**
 * Isolated-world agent (AD-4): the default home for everything that does not
 * require same-realm access. Phase 4 scaffold: overlay root (closed ShadowRoot,
 * pointer-events none, tagged data-localcoast so our own DOM diffs and
 * scenario selectors exclude it) + right-click hit capture groundwork for
 * Component Selection.
 */

declare global {
  interface Window {
    __LC_ISOLATED_SEND__?: (payload: string) => void;
  }
}

(() => {
  const BINDING = '__LC_ISO_BINDING__';
  const w = window as unknown as Record<string, unknown>;
  if (w['__lcIsolatedInstalled']) return;
  w['__lcIsolatedInstalled'] = true;

  let send: ((payload: string) => void) | null = null;
  const bindingFn = (window as unknown as Record<string, (p: string) => void>)[BINDING];
  if (typeof bindingFn === 'function') {
    send = bindingFn;
  } else if (typeof window.__LC_ISOLATED_SEND__ === 'function') {
    send = (p) => window.__LC_ISOLATED_SEND__!(p);
  }

  // -- overlay root -------------------------------------------------------------
  function mountOverlay(): ShadowRoot | null {
    if (!document.documentElement) return null;
    const host = document.createElement('div');
    host.setAttribute('data-localcoast', 'overlay-host');
    host.style.cssText =
      'position:fixed;inset:0;pointer-events:none;z-index:2147483646;contain:strict;';
    const shadow = host.attachShadow({ mode: 'closed' });
    const mount = () => document.documentElement.appendChild(host);
    if (document.body) mount();
    else document.addEventListener('DOMContentLoaded', mount, { once: true });
    return shadow;
  }
  const overlay = mountOverlay();
  void overlay; // per-overlay renderers (perf HUD, focus order, coverage) land in later phases

  // -- Component Selection groundwork: capture-phase right-click hit test --------
  document.addEventListener(
    'contextmenu',
    (evt) => {
      const target = evt.target as Element | null;
      if (!target || target.closest?.('[data-localcoast]')) return;
      if (!send) return;
      // Report a cheap structural locator; the host resolves it to a framework
      // instance + source path via the main world / CDP (L2).
      const path: string[] = [];
      let el: Element | null = target;
      while (el && path.length < 12) {
        const idPart = el.id ? `#${el.id}` : '';
        const testId = el.getAttribute?.('data-testid');
        path.unshift(testId ? `[data-testid="${testId}"]` : `${el.tagName.toLowerCase()}${idPart}`);
        el = el.parentElement;
      }
      try {
        send(
          JSON.stringify({
            v: 1,
            world: 'isolated',
            messages: [],
            hit: { selectorPath: path.join(' > '), x: evt.clientX, y: evt.clientY, t: performance.now() },
          }),
        );
      } catch {
        /* binding torn down */
      }
    },
    true,
  );
})();

export {};
