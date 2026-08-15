'use strict';

/**
 * The contextBridge surface — the only channel between the renderer and anything privileged.
 *
 * Deliberately narrow, and deliberately an explicit allow-list of named functions rather than a
 * generic invoke(channel, …) passthrough, which would just be nodeIntegration with extra steps.
 * The renderer never sees the API key, never touches the filesystem, and never makes the
 * network call itself. See ARCHITECTURE §2.
 */

const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  // Real frame zoom rather than a CSS transform: it scales layout the way Ctrl+/− does and
  // leaves position:fixed elements (the modals) correctly anchored to the viewport, which a
  // `zoom` or `scale()` on <body> would not.
  ui: {
    setZoom: (factor) => webFrame.setZoomFactor(factor),
    getZoom: () => webFrame.getZoomFactor()
  },

  settings: {
    load: () => ipcRenderer.invoke('settings:load'),
    save: (payload) => ipcRenderer.invoke('settings:save', payload),
    clearKey: () => ipcRenderer.invoke('settings:clearKey')
  },

  ai: {
    test: (override) => ipcRenderer.invoke('ai:test', override)
  },

  plans: {
    import: () => ipcRenderer.invoke('plans:import'),
    onProgress: (fn) => {
      const handler = (_e, payload) => fn(payload);
      ipcRenderer.on('plans:progress', handler);
      return () => ipcRenderer.removeListener('plans:progress', handler);
    }
  },

  workspace: {
    export: (data) => ipcRenderer.invoke('workspace:export', data),
    import: () => ipcRenderer.invoke('workspace:import'),
    autosave: (data) => ipcRenderer.invoke('workspace:autosave', data),
    restore: () => ipcRenderer.invoke('workspace:restore')
  },

  // Checking, downloading and installing all happen in the main process. What crosses here is
  // a state object to render and four verbs to trigger — never a URL to fetch or a file to write.
  updates: {
    status: () => ipcRenderer.invoke('updates:status'),
    check: () => ipcRenderer.invoke('updates:check'),
    download: () => ipcRenderer.invoke('updates:download'),
    install: () => ipcRenderer.invoke('updates:install'),
    onChange: (fn) => {
      const handler = (_e, payload) => fn(payload);
      ipcRenderer.on('updates:changed', handler);
      return () => ipcRenderer.removeListener('updates:changed', handler);
    }
  },

  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  platform: process.platform
});
