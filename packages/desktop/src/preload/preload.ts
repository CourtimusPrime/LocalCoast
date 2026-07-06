import { contextBridge, ipcRenderer } from 'electron';

/**
 * The renderer's ENTIRE world (invariant 1): query, command, subscribe.
 * No CDP, no SQLite, no fs. Panels that need more data add a registry
 * capability first.
 */

let subCounter = 0;

contextBridge.exposeInMainWorld('core', {
  query: (name: string, input: unknown) => ipcRenderer.invoke('core:query', name, input),
  command: (name: string, input: unknown) => ipcRenderer.invoke('core:command', name, input),
  subscribe: (name: string, input: unknown, onData: (data: unknown) => void) => {
    const subId = `sub-${++subCounter}`;
    const channel = `core:sub:${subId}`;
    const listener = (_evt: unknown, data: unknown) => onData(data);
    ipcRenderer.on(channel, listener);
    void ipcRenderer.invoke('core:subscribe', subId, name, input);
    return () => {
      ipcRenderer.removeListener(channel, listener);
      void ipcRenderer.invoke('core:unsubscribe', subId);
    };
  },
});
