/**
 * Isolated-world agent (AD-4): the default home for everything that does not
 * require same-realm access. Hosts the overlay root (closed ShadowRoot,
 * pointer-events none, tagged data-localcoast so our own DOM diffs and
 * scenario selectors exclude it), right-click hit capture, and the Option-hold
 * component inspect mode (highlight + tooltip + click-to-pick). Component
 * name/path resolution lives host-side: hover coords go out over the binding,
 * the host resolves via the main world and pushes the label back through
 * window.__lcInspect (this world cannot touch main-world globals).
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

  function sendMsg(msg: Record<string, unknown>): void {
    if (!send) return;
    try {
      send(JSON.stringify({ v: 1, world: 'isolated', messages: [msg] }));
    } catch {
      /* binding torn down */
    }
  }

  // -- overlay root -------------------------------------------------------------
  // This script runs at document creation (addScriptToEvaluateOnNewDocument),
  // before <html> exists — build the host detached and append once the tree is
  // parseable (createElement/attachShadow need no connected DOM).
  const overlayHost = document.createElement('div');
  overlayHost.setAttribute('data-localcoast', 'overlay-host');
  overlayHost.style.cssText =
    'position:fixed;inset:0;pointer-events:none;z-index:2147483646;contain:strict;';
  const overlay = overlayHost.attachShadow({ mode: 'closed' });
  function ensureOverlayMounted(): void {
    if (!overlayHost.isConnected && document.documentElement) {
      document.documentElement.appendChild(overlayHost);
    }
  }
  ensureOverlayMounted();
  document.addEventListener('DOMContentLoaded', ensureOverlayMounted, { once: true });

  function buildSelectorPath(target: Element): string {
    const path: string[] = [];
    let el: Element | null = target;
    while (el && path.length < 12) {
      const idPart = el.id ? `#${el.id}` : '';
      const testId = el.getAttribute?.('data-testid');
      path.unshift(testId ? `[data-testid="${testId}"]` : `${el.tagName.toLowerCase()}${idPart}`);
      el = el.parentElement;
    }
    return path.join(' > ');
  }

  // -- component inspect mode (Option-hold highlight / click-to-pick) ------------
  const inspect = (() => {
    const box = document.createElement('div');
    box.style.cssText =
      'position:fixed;display:none;pointer-events:none;box-sizing:border-box;' +
      'border:1.5px solid #4a9eff;background:rgba(74,158,255,.12);border-radius:2px;';
    const tip = document.createElement('div');
    tip.style.cssText =
      'position:fixed;display:none;pointer-events:none;max-width:70vw;' +
      'font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;' +
      'background:#1b1f24;color:#e8f0ff;padding:4px 8px;border-radius:4px;' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' +
      'box-shadow:0 2px 8px rgba(0,0,0,.35);';
    overlay.append(box, tip);

    const cursorStyle = document.createElement('style');
    cursorStyle.setAttribute('data-localcoast', 'inspect-cursor');
    cursorStyle.textContent = '*{cursor:pointer!important}';

    const state = {
      sticky: false,
      altHeld: false,
      entered: false,
      seq: 0,
      lastEl: null as Element | null,
      lastX: 0,
      lastY: 0,
      /** No highlight until the first pointermove — before that the cursor
       *  position is unknown and (0,0) would hit-test the wrong element. */
      hasPointer: false,
      rafPending: false,
      label: '',
    };
    const active = () => state.sticky || state.altHeld;

    function fallbackLabel(el: Element): string {
      const id = el.id ? `#${el.id}` : '';
      const cls =
        typeof el.className === 'string' && el.className
          ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
          : '';
      return `${el.tagName.toLowerCase()}${id}${cls}`;
    }

    function drawBox(rect: DOMRect): void {
      box.style.left = `${rect.left}px`;
      box.style.top = `${rect.top}px`;
      box.style.width = `${rect.width}px`;
      box.style.height = `${rect.height}px`;
      box.style.display = 'block';
    }

    function drawTip(rect: DOMRect): void {
      tip.textContent = state.label;
      tip.style.display = 'block';
      const tipH = tip.offsetHeight || 24;
      const tipW = tip.offsetWidth || 0;
      const above = rect.top - tipH - 6;
      tip.style.top = `${above >= 4 ? above : Math.min(rect.bottom + 6, innerHeight - tipH - 4)}px`;
      tip.style.left = `${Math.max(4, Math.min(rect.left, innerWidth - tipW - 4))}px`;
    }

    function hide(): void {
      box.style.display = 'none';
      tip.style.display = 'none';
    }

    function hitTest(): void {
      if (!active() || !state.hasPointer) return;
      const el = document.elementFromPoint(state.lastX, state.lastY);
      if (!el || el.closest?.('[data-localcoast]')) {
        hide();
        state.lastEl = null;
        return;
      }
      if (el !== state.lastEl) {
        state.lastEl = el;
        state.seq += 1;
        state.label = fallbackLabel(el);
        sendMsg({
          kind: 'component.hover',
          x: Math.max(0, Math.round(state.lastX)),
          y: Math.max(0, Math.round(state.lastY)),
          seq: state.seq,
          t: performance.now(),
        });
      }
      const rect = el.getBoundingClientRect();
      drawBox(rect);
      drawTip(rect);
    }

    function scheduleHitTest(): void {
      if (state.rafPending) return;
      state.rafPending = true;
      requestAnimationFrame(() => {
        state.rafPending = false;
        hitTest();
      });
    }

    function enter(): void {
      if (state.entered) return;
      state.entered = true;
      ensureOverlayMounted(); // SPA hydration can rewrite documentElement children
      if (document.documentElement && !cursorStyle.isConnected) {
        document.documentElement.appendChild(cursorStyle);
      }
      hitTest();
    }

    function exit(): void {
      if (!state.entered) return;
      state.entered = false;
      cursorStyle.remove();
      hide();
      state.lastEl = null;
    }

    function sync(): void {
      if (active()) enter();
      else exit();
    }

    window.addEventListener(
      'keydown',
      (evt) => {
        if (evt.key === 'Alt') {
          state.altHeld = true;
          sync();
          return;
        }
        if (evt.key === 'Escape' && active()) {
          evt.preventDefault();
          evt.stopImmediatePropagation();
          if (state.sticky) {
            state.sticky = false;
            sendMsg({ kind: 'component.mode', enabled: false, t: performance.now() });
          }
          state.altHeld = false;
          sync();
        }
      },
      true,
    );
    window.addEventListener(
      'keyup',
      (evt) => {
        if (evt.key !== 'Alt') return;
        state.altHeld = false;
        sync();
      },
      true,
    );
    window.addEventListener(
      'blur',
      () => {
        state.altHeld = false;
        sync();
      },
      true,
    );
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        state.altHeld = false;
        sync();
      }
    });

    window.addEventListener(
      'pointermove',
      (evt) => {
        state.lastX = evt.clientX;
        state.lastY = evt.clientY;
        state.hasPointer = true;
        // Mouse events always reach the hovered view; keydown only when the
        // guest is focused — the modifier flag is the source of truth.
        state.altHeld = evt.altKey;
        sync();
        if (active()) scheduleHitTest();
      },
      { capture: true, passive: true },
    );
    window.addEventListener(
      'scroll',
      () => {
        if (active()) scheduleHitTest();
      },
      { capture: true, passive: true },
    );
    window.addEventListener('resize', () => {
      if (active()) scheduleHitTest();
    });

    // Swallow the whole click gesture while inspecting — the app must never
    // see it (DevTools inspect-mode convention). Our pre-app window capture
    // listeners run before anything the app registers.
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup'] as const) {
      window.addEventListener(
        type,
        (evt) => {
          if (!active()) return;
          evt.preventDefault();
          evt.stopImmediatePropagation();
        },
        true,
      );
    }
    window.addEventListener(
      'click',
      (evt) => {
        if (!active()) return;
        evt.preventDefault();
        evt.stopImmediatePropagation();
        // Re-hit synchronously: the rAF hit-test may not have run between the
        // final pointermove and this click, leaving lastEl/seq stale.
        state.lastX = evt.clientX;
        state.lastY = evt.clientY;
        state.hasPointer = true;
        hitTest();
        const el = state.lastEl;
        state.label = 'copying…';
        if (el) drawTip(el.getBoundingClientRect());
        sendMsg({
          kind: 'component.pick',
          x: Math.max(0, Math.round(evt.clientX)),
          y: Math.max(0, Math.round(evt.clientY)),
          seq: state.seq,
          selectorPath: el ? buildSelectorPath(el) : undefined,
          t: performance.now(),
        });
      },
      true,
    );

    return {
      setMode(on: boolean): void {
        state.sticky = Boolean(on);
        sync();
      },
      setLabel(p: { seq?: number; name?: string; path?: string; line?: number; copied?: boolean }): void {
        if (typeof p !== 'object' || p === null) return;
        if (p.seq !== state.seq) return; // stale resolve for an older hover target
        const loc = p.path ? `${p.path}${p.line ? `:${p.line}` : ''}` : '';
        const base = p.name && loc ? `${p.name} · ${loc}` : p.name || loc || state.label;
        state.label = p.copied ? `Copied ✓ ${base}` : base;
        if (state.lastEl && state.entered) drawTip(state.lastEl.getBoundingClientRect());
      },
      _state() {
        return { active: active(), sticky: state.sticky, label: state.label, seq: state.seq };
      },
    };
  })();

  Object.defineProperty(window, '__lcInspect', {
    enumerable: false,
    configurable: false,
    writable: false,
    value: inspect,
  });

  // -- Component Selection groundwork: capture-phase right-click hit test --------
  document.addEventListener(
    'contextmenu',
    (evt) => {
      const target = evt.target as Element | null;
      if (!target || target.closest?.('[data-localcoast]')) return;
      if (!send) return;
      // Report a cheap structural locator; the host resolves it to a framework
      // instance + source path via the main world / CDP (L2).
      try {
        send(
          JSON.stringify({
            v: 1,
            world: 'isolated',
            messages: [],
            hit: {
              selectorPath: buildSelectorPath(target),
              x: evt.clientX,
              y: evt.clientY,
              t: performance.now(),
            },
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
