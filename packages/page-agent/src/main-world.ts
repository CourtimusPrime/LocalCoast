/**
 * Main-world agent (AD-4). Runs before any app code via
 * Page.addScriptToEvaluateOnNewDocument. Same-realm patching is unavoidable
 * here — everything else lives in the isolated world.
 *
 * Injection-time placeholders (replaced by the host per target):
 *   __LC_BINDING__ — nonce-named CDP binding for this target
 *
 * Security posture (invariant 6): pristine natives captured at bootstrap;
 * patched functions keep name/length and spoof toString; the binding
 * reference is captured into a closure and deleted from window; nothing here
 * trusts or evals page data.
 */

declare global {
  interface Window {
    __LC_SEND__?: (payload: string) => void;
    __localcoastSockets?: Map<number, WebSocket>;
  }
}

(() => {
  const BINDING = '__LC_BINDING__';
  if ((window as unknown as Record<string, unknown>)['__lcMainWorldInstalled']) return;
  Object.defineProperty(window, '__lcMainWorldInstalled', { value: true, enumerable: false });

  // -- pristine natives, captured before app code can pollute prototypes -----
  const pristine = {
    stringify: JSON.stringify.bind(JSON),
    now: performance.now.bind(performance),
    timeOrigin: performance.timeOrigin,
    defineProperty: Object.defineProperty.bind(Object),
    getOwnPropertyDescriptor: Object.getOwnPropertyDescriptor.bind(Object),
    raf: window.requestAnimationFrame.bind(window),
    setTimeout: window.setTimeout.bind(window),
    funcToString: Function.prototype.toString,
    MapCtor: Map,
    error: Error,
  };

  // -- binding capture: closure the reference, remove it from window ---------
  type Sender = (payload: string) => void;
  let send: Sender | null = null;
  const bindingFn = (window as unknown as Record<string, Sender>)[BINDING];
  if (typeof bindingFn === 'function') {
    send = bindingFn;
    try {
      delete (window as unknown as Record<string, unknown>)[BINDING];
    } catch {
      /* non-configurable in some embedders; nonce name still unguessable */
    }
  } else if (typeof window.__LC_SEND__ === 'function') {
    // Test-harness fallback (playwright exposeFunction shim).
    send = (payload) => window.__LC_SEND__!(payload);
  }

  // -- batching ring, flushed per rAF (AD-4) ----------------------------------
  interface Msg {
    kind: string;
    t: number;
    [key: string]: unknown;
  }
  const RING_MAX = 512;
  let ring: Msg[] = [];
  let flushScheduled = false;

  function flush(): void {
    flushScheduled = false;
    if (!send || ring.length === 0) return;
    const batch = ring;
    ring = [];
    try {
      send(
        pristine.stringify({
          v: 1,
          world: 'main',
          epochHint: pristine.timeOrigin,
          messages: batch,
        }),
      );
    } catch {
      /* binding gone (navigation teardown) — drop silently */
    }
  }

  function emit(msg: Msg): void {
    if (ring.length >= RING_MAX) ring.shift();
    ring.push(msg);
    if (!flushScheduled) {
      flushScheduled = true;
      // rAF is throttled in occluded tabs; back it with a timeout so the trail
      // keeps flowing for background guests.
      pristine.raf(() => flush());
      pristine.setTimeout(flush, 250);
    }
  }

  // -- patch helper: keep name/length, spoof toString (invariant 6) ----------
  const patchedToOriginal = new pristine.MapCtor<unknown, unknown>();
  const originalToString = pristine.funcToString;
  // One global toString spoof: patched functions report their original source.
  // Honest limitation: pathological feature detection can still notice.
  Function.prototype.toString = function toString(this: unknown): string {
    const original = patchedToOriginal.get(this);
    return originalToString.call(original !== undefined ? original : this) as string;
  };
  patchedToOriginal.set(Function.prototype.toString, originalToString);

  function mimic<T extends (...args: never[]) => unknown>(patched: T, original: unknown): T {
    const orig = original as { name: string; length: number };
    try {
      pristine.defineProperty(patched, 'name', { value: orig.name, configurable: true });
      pristine.defineProperty(patched, 'length', { value: orig.length, configurable: true });
    } catch {
      /* best effort */
    }
    patchedToOriginal.set(patched, original);
    return patched;
  }

  function trimmedStack(): Array<{ functionName?: string; url?: string; line?: number }> | undefined {
    const raw = new pristine.error().stack;
    if (!raw) return undefined;
    const frames: Array<{ functionName?: string; url?: string; line?: number }> = [];
    for (const line of raw.split('\n').slice(3, 9)) {
      const m = /at (?:(.+?) \()?(.+?):(\d+):\d+\)?$/.exec(line.trim());
      if (m) frames.push({ functionName: m[1], url: m[2], line: Number(m[3]) });
    }
    return frames.length > 0 ? frames : undefined;
  }

  const preview = (value: unknown): string => String(value).slice(0, 256);

  /** One hostile/unavailable API must never take down the rest of the agent. */
  function section(name: string, install: () => void): void {
    try {
      install();
    } catch (err) {
      emit({ kind: 'agent.error', message: `${name}: ${String(err)}`.slice(0, 2048), t: pristine.now() });
    }
  }

  // -- storage trail: Storage.prototype patch (invariant: every op logged) ---
  function patchStorage(area: 'localStorage' | 'sessionStorage'): void {
    // Throws on opaque origins (sandboxed iframes, data: URLs) — section guard applies.
    const storage = window[area];
    if (!storage) return;
    const proto = Object.getPrototypeOf(storage) as Record<string, unknown>;
    const original = {
      getItem: proto.getItem as (k: string) => string | null,
      setItem: proto.setItem as (k: string, v: string) => void,
      removeItem: proto.removeItem as (k: string) => void,
      clear: proto.clear as () => void,
    };

    // Prototype patch catches app AND third-party lib access; the per-area
    // wrapping closure keys events to the right area at call time.
    const areaOf = (self: unknown): 'localStorage' | 'sessionStorage' | null =>
      self === window.localStorage ? 'localStorage' : self === window.sessionStorage ? 'sessionStorage' : null;

    proto.getItem = mimic(function getItem(this: Storage, key: string) {
      const a = areaOf(this);
      if (a) emit({ kind: 'storage.op', area: a, op: 'read', key: String(key).slice(0, 1024), t: pristine.now() });
      return original.getItem.call(this, key);
    }, original.getItem);

    proto.setItem = mimic(function setItem(this: Storage, key: string, value: string) {
      const a = areaOf(this);
      if (a) {
        emit({
          kind: 'storage.op',
          area: a,
          op: 'write',
          key: String(key).slice(0, 1024),
          valueSize: String(value).length,
          valuePreview: preview(value),
          stack: trimmedStack(),
          t: pristine.now(),
        });
      }
      return original.setItem.call(this, key, value);
    }, original.setItem);

    proto.removeItem = mimic(function removeItem(this: Storage, key: string) {
      const a = areaOf(this);
      if (a) emit({ kind: 'storage.op', area: a, op: 'remove', key: String(key).slice(0, 1024), stack: trimmedStack(), t: pristine.now() });
      return original.removeItem.call(this, key);
    }, original.removeItem);

    proto.clear = mimic(function clear(this: Storage) {
      const a = areaOf(this);
      if (a) emit({ kind: 'storage.op', area: a, op: 'clear', stack: trimmedStack(), t: pristine.now() });
      return original.clear.call(this);
    }, original.clear);
  }
  // Storage.prototype is shared — ONE patch covers both areas via areaOf().
  section('storage', () => patchStorage('localStorage'));

  // -- document.cookie accessor wrap ------------------------------------------
  section('cookie', () => {
  const cookieDesc =
    pristine.getOwnPropertyDescriptor(Document.prototype, 'cookie') ??
    pristine.getOwnPropertyDescriptor(HTMLDocument.prototype, 'cookie');
  if (cookieDesc?.get && cookieDesc.set) {
    const cookieProto = pristine.getOwnPropertyDescriptor(Document.prototype, 'cookie')
      ? Document.prototype
      : HTMLDocument.prototype;
    pristine.defineProperty(cookieProto, 'cookie', {
      configurable: true,
      get: mimic(function cookie(this: Document) {
        emit({ kind: 'storage.op', area: 'cookie', op: 'read', t: pristine.now() });
        return cookieDesc.get!.call(this) as string;
      }, cookieDesc.get),
      set: mimic(function cookie(this: Document, value: string) {
        const name = String(value).split('=')[0] ?? '';
        emit({
          kind: 'storage.op',
          area: 'cookie',
          op: 'write',
          key: name.trim().slice(0, 1024),
          valueSize: String(value).length,
          valuePreview: preview(value),
          stack: trimmedStack(),
          t: pristine.now(),
        });
        cookieDesc.set!.call(this, value);
      }, cookieDesc.set),
    });
  }
  });

  // -- WebSocket wrap: registry enables send-into-socket (AD-2 gap) -----------
  section('websocket', () => {
  const sockets = new pristine.MapCtor<number, WebSocket>();
  let socketSeq = 0;
  const NativeWebSocket = window.WebSocket;
  const PatchedWebSocket = mimic(function WebSocket(
    this: unknown,
    url: string | URL,
    protocols?: string | string[],
  ) {
    const ws =
      protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
    const socketId = ++socketSeq;
    sockets.set(socketId, ws);
    emit({ kind: 'ws', socketId, phase: 'created', url: String(url).slice(0, 4096), t: pristine.now() });
    ws.addEventListener('close', () => {
      sockets.delete(socketId);
      emit({ kind: 'ws', socketId, phase: 'closed', t: pristine.now() });
    });
    return ws;
  } as unknown as (...args: never[]) => unknown, NativeWebSocket) as unknown as typeof WebSocket;
  PatchedWebSocket.prototype = NativeWebSocket.prototype;
  pristine.defineProperty(PatchedWebSocket, 'CONNECTING', { value: NativeWebSocket.CONNECTING });
  pristine.defineProperty(PatchedWebSocket, 'OPEN', { value: NativeWebSocket.OPEN });
  pristine.defineProperty(PatchedWebSocket, 'CLOSING', { value: NativeWebSocket.CLOSING });
  pristine.defineProperty(PatchedWebSocket, 'CLOSED', { value: NativeWebSocket.CLOSED });
  window.WebSocket = PatchedWebSocket;
  // Registry access for the host's send-into-socket command (via Runtime.evaluate
  // in THIS world — never exposed to the page by enumerable name).
  pristine.defineProperty(window, '__localcoastSockets', { value: sockets, enumerable: false });
  });

  // -- history patch: SPA route trail ------------------------------------------
  section('history', () => {
  const origPush = history.pushState.bind(history);
  const origReplace = history.replaceState.bind(history);
  let lastUrl = location.href;
  const routeEmit = (to: string, routeKind: 'push' | 'replace' | 'pop' | 'hashchange') => {
    emit({ kind: 'state.route', from: lastUrl.slice(0, 4096), to: to.slice(0, 4096), routeKind, t: pristine.now() });
    lastUrl = to;
  };
  history.pushState = mimic(function pushState(this: History, data: unknown, unused: string, url?: string | URL | null) {
    origPush(data, unused, url ?? undefined);
    routeEmit(location.href, 'push');
  }, History.prototype.pushState);
  history.replaceState = mimic(function replaceState(this: History, data: unknown, unused: string, url?: string | URL | null) {
    origReplace(data, unused, url ?? undefined);
    routeEmit(location.href, 'replace');
  }, History.prototype.replaceState);
  window.addEventListener('popstate', () => routeEmit(location.href, 'pop'));
  window.addEventListener('hashchange', () => routeEmit(location.href, 'hashchange'));
  });

  // -- framework detection via devtools hook shims (L1) ------------------------
  function reportFramework(framework: 'react' | 'vue' | 'svelte', version?: string, devBuild?: boolean): void {
    emit({ kind: 'framework.detected', framework, version, devBuild, t: pristine.now() });
  }

  // React fiber roots, maintained by the hook shim; consumed by getTree /
  // componentAt below. (Interim tree source until react-devtools-core is
  // embedded behind the same hook — AD-3 L1.)
  interface FiberNode {
    type: unknown;
    return: FiberNode | null;
    child: FiberNode | null;
    sibling: FiberNode | null;
    _debugSource?: { fileName?: string; lineNumber?: number };
  }
  const reactRoots = new Set<{ current: FiberNode }>();
  let pendingCommits = 0;
  let commitFlushScheduled = false;
  function noteCommit(): void {
    pendingCommits++;
    if (!commitFlushScheduled) {
      commitFlushScheduled = true;
      pristine.raf(() => {
        commitFlushScheduled = false;
        emit({ kind: 'state.commit', framework: 'react', count: pendingCommits, t: pristine.now() });
        pendingCommits = 0;
      });
    }
  }

  section('framework-hooks', () => {
  const w = window as unknown as Record<string, unknown>;
  if (!w.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
    const renderers = new pristine.MapCtor<number, unknown>();
    let rendererSeq = 0;
    w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      renderers,
      supportsFiber: true,
      inject(renderer: { version?: string; bundleType?: number }) {
        const id = ++rendererSeq;
        renderers.set(id, renderer);
        reportFramework('react', renderer?.version, renderer?.bundleType === 1);
        return id;
      },
      onCommitFiberRoot(_id: number, root: { current: FiberNode }) {
        reactRoots.add(root);
        noteCommit();
      },
      onCommitFiberUnmount() {},
      onPostCommitFiberRoot() {},
      checkDCE() {},
    };
  }
  if (!w.__VUE_DEVTOOLS_GLOBAL_HOOK__) {
    const emitVue = (event: string, ...args: unknown[]) => {
      if (event === 'app:init') {
        const app = args[0] as { version?: string } | undefined;
        reportFramework('vue', app?.version);
      }
    };
    w.__VUE_DEVTOOLS_GLOBAL_HOOK__ = { events: new pristine.MapCtor(), on() {}, once() {}, off() {}, emit: emitVue, apps: [] };
  }
  document.addEventListener('SvelteRegisterComponent', () => reportFramework('svelte'), {
    once: true,
  });
  });

  // -- Redux DevTools shim (AD-3 L3): anything wired for the extension
  // connects to US — full action stream + jumpable state history. -------------
  section('redux-shim', () => {
  const w = window as unknown as Record<string, unknown>;
  if (w.__REDUX_DEVTOOLS_EXTENSION__) return; // real extension present — defer to it
  interface StoreConn {
    id: string;
    name: string;
    states: unknown[];
    actions: string[];
    actionCount: number;
    subs: Set<(msg: unknown) => void>;
  }
  const HISTORY_MAX = 50;
  const storeConns = new pristine.MapCtor<string, StoreConn>();
  let storeSeq = 0;

  w.__REDUX_DEVTOOLS_EXTENSION__ = {
    connect(options?: { name?: string }) {
      const id = String(++storeSeq);
      const conn: StoreConn = {
        id,
        name: options?.name ?? `store-${id}`,
        states: [],
        actions: [],
        actionCount: 0,
        subs: new Set(),
      };
      storeConns.set(id, conn);
      const record = (actionType: string, state: unknown) => {
        conn.states.push(state);
        conn.actions.push(actionType);
        conn.actionCount++;
        if (conn.states.length > HISTORY_MAX) {
          conn.states.shift();
          conn.actions.shift();
        }
        emit({
          kind: 'state.action',
          storeId: `${conn.id}:${conn.name}`.slice(0, 256),
          actionType: actionType.slice(0, 256),
          t: pristine.now(),
        });
      };
      return {
        init: (state: unknown) => record('@@INIT', state),
        send: (action: unknown, state: unknown) => {
          const type =
            typeof action === 'string'
              ? action
              : ((action as { type?: unknown })?.type !== undefined
                  ? String((action as { type: unknown }).type)
                  : 'unknown');
          record(type, state);
        },
        subscribe: (cb: (msg: unknown) => void) => {
          conn.subs.add(cb);
          return () => conn.subs.delete(cb);
        },
        unsubscribe: () => conn.subs.clear(),
        error: () => {},
      };
    },
    disconnect() {},
  };

  // Host access (Runtime.evaluate in this world only — invariant 5).
  pristine.defineProperty(window, '__localcoastStores', {
    enumerable: false,
    value: {
      list: () =>
        [...storeConns.values()].map((c) => ({
          storeId: `${c.id}:${c.name}`,
          name: c.name,
          actionCount: c.actionCount,
          historyLength: c.states.length,
        })),
      getState: (storeId: string) => {
        const conn = storeConns.get(storeId.split(':')[0]!);
        return conn ? conn.states[conn.states.length - 1] : undefined;
      },
      /** True time travel: replay a retained state into every subscriber
       *  (Redux DevTools DISPATCH/JUMP_TO_STATE protocol). */
      jump: (storeId: string, index: number) => {
        const conn = storeConns.get(storeId.split(':')[0]!);
        if (!conn || index < 0 || index >= conn.states.length) return false;
        const state = pristine.stringify(conn.states[index]);
        for (const cb of conn.subs) {
          try {
            cb({ type: 'DISPATCH', payload: { type: 'JUMP_TO_STATE', actionId: index }, state });
          } catch {
            /* subscriber threw — page problem, not ours */
          }
        }
        return true;
      },
      /** Snapshot restore: push a serialized state into a store matched by
       *  NAME (connection ids change across reloads). */
      restoreByName: (name: string, stateJson: string) => {
        const conn = [...storeConns.values()].find((c) => c.name === name);
        if (!conn) return false;
        for (const cb of conn.subs) {
          try {
            cb({ type: 'DISPATCH', payload: { type: 'JUMP_TO_STATE', actionId: -1 }, state: stateJson });
          } catch {
            /* subscriber threw */
          }
        }
        return true;
      },
    },
  });
  });

  // -- component resolution: tree + at-point (AD-3 L1/L2) ----------------------
  section('component-resolver', () => {
  function fiberComponentName(fiber: FiberNode): string | null {
    const t = fiber.type as { displayName?: string; name?: string } | string | null;
    if (typeof t === 'function') {
      const fn = t as { displayName?: string; name?: string };
      return fn.displayName ?? fn.name ?? null;
    }
    if (t && typeof t === 'object') {
      // memo/forwardRef wrappers
      const inner = (t as { type?: { displayName?: string; name?: string }; render?: { displayName?: string; name?: string } });
      return inner.type?.displayName ?? inner.type?.name ?? inner.render?.displayName ?? inner.render?.name ?? null;
    }
    return null;
  }

  interface TreeNode {
    name: string;
    framework: string;
    sourcePath?: string;
    children: TreeNode[];
  }

  function walkFiber(fiber: FiberNode | null, depth: number, budget: { nodes: number }, out: TreeNode[]): void {
    let node = fiber;
    while (node && budget.nodes > 0) {
      const name = fiberComponentName(node);
      if (name && typeof node.type === 'function') {
        budget.nodes--;
        const entry: TreeNode = {
          name,
          framework: 'react',
          sourcePath: node._debugSource?.fileName,
          children: [],
        };
        out.push(entry);
        if (depth > 0) walkFiber(node.child, depth - 1, budget, entry.children);
      } else if (depth > 0) {
        // Host/fragment fibers are pass-through: children lift to this level.
        walkFiber(node.child, depth, budget, out);
      }
      node = node.sibling;
    }
  }

  pristine.defineProperty(window, '__localcoastComponents', {
    enumerable: false,
    value: {
      getTree: (maxDepth: number, maxNodes: number) => {
        const budget = { nodes: maxNodes };
        const roots: TreeNode[] = [];
        for (const root of reactRoots) walkFiber(root.current.child, maxDepth, budget, roots);
        if (roots.length === 0) return null;
        return {
          framework: 'react',
          truncated: budget.nodes <= 0,
          tree: { name: '#root', framework: 'react', children: roots },
        };
      },
      at: (x: number, y: number) => {
        let el = document.elementFromPoint(x, y);
        while (el) {
          const keys = Object.keys(el);
          const fiberKey = keys.find((k) => k.startsWith('__reactFiber$'));
          if (fiberKey) {
            let fiber = (el as unknown as Record<string, FiberNode | null>)[fiberKey];
            while (fiber) {
              const name = fiberComponentName(fiber);
              if (name && typeof fiber.type === 'function') {
                (window as unknown as Record<string, unknown>).__lcPickedFn = fiber.type;
                return {
                  framework: 'react',
                  componentName: name,
                  file: fiber._debugSource?.fileName,
                  line: fiber._debugSource?.lineNumber,
                  hasFn: true,
                };
              }
              fiber = fiber.return;
            }
          }
          const vue = (el as unknown as { __vueParentComponent?: { type?: { name?: string; __name?: string; __file?: string } } })
            .__vueParentComponent;
          if (vue?.type) {
            return {
              framework: 'vue',
              componentName: vue.type.name ?? vue.type.__name,
              file: vue.type.__file,
              hasFn: false,
            };
          }
          const svelte = (el as unknown as { __svelte_meta?: { loc?: { file?: string; line?: number } } }).__svelte_meta;
          if (svelte?.loc) {
            return { framework: 'svelte', file: svelte.loc.file, line: svelte.loc.line, hasFn: false };
          }
          el = el.parentElement;
        }
        return null;
      },
    },
  });
  });

  // -- long task observer (perf overlay feed) -----------------------------------
  section('longtask', () => {
  if (typeof PerformanceObserver === 'undefined') return;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      emit({ kind: 'perf.longTask', durationMs: entry.duration, t: entry.startTime });
    }
  }).observe({ entryTypes: ['longtask'] });
  });

  // Flush whatever accumulated before teardown.
  window.addEventListener('pagehide', flush);
})();

export {};
