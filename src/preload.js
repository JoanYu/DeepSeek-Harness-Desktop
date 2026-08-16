/**
 * Sandboxed preload — the only piece of shell-side code the renderer ever sees.
 *
 * Everything else in the window runs in the kernel-served web UI, which is
 * untrusted by design (see `window-policy.js`). The preload is locked down
 * (`sandbox: true`, `contextIsolation: true`, no `nodeIntegration`) and exposes
 * exactly two methods via `contextBridge`:
 *
 *   `notify(title, body)` — fire a desktop notification through the OS shell.
 *   `onShown(handler)`     — invoke `handler()` whenever the window is unhidden
 *                            from the tray, so the renderer can resume any work
 *                            it was pausing.
 *
 * That is the entire surface. A larger surface is the failure mode this preload
 * exists to prevent: every new export is another piece of the kernel's web UI
 * that can be addressed from a compromised renderer, which is precisely what
 * the upstream policy was written to forbid.
 *
 * Sandboxed preloads run in a V8 context that has no Node module loader:
 * neither `require` nor `import` from `'electron'` resolve, because no Node
 * runtime is present. Electron instead exposes the whitelisted APIs
 * (`contextBridge`, `ipcRenderer`, `webFrame`) as plain globals in the preload
 * scope, and this file uses them directly.
 *
 * @module preload
 */

// The runtime names `contextBridge` and `ipcRenderer` exist as globals in the
// sandboxed preload scope; TypeScript has no declaration for them because the
// `electron` module typings assume `import { ... } from 'electron'`, which does
// not resolve here. The `@ts-ignore` comments let the cast below type-check
// without polluting the rest of the file with `any` types.
/** @type {import('electron').ContextBridge} */
// @ts-ignore — Electron global available at runtime in the preload context
const contextBridgeApi = /** @type {any} */ (contextBridge)
/** @type {import('electron').IpcRenderer} */
// @ts-ignore — Electron global available at runtime in the preload context
const ipcRendererApi = /** @type {any} */ (ipcRenderer)

if (!contextBridgeApi || !ipcRendererApi) {
  throw new Error('preload: Electron globals contextBridge/ipcRenderer are not available')
}

contextBridgeApi.exposeInMainWorld('shell', Object.freeze({
  /**
   * Posts a desktop notification through the shell's `Notification` instance.
   *
   * Failures are swallowed: a renderer that is mid-unload, or a notification
   * daemon that is not running, should not propagate exceptions back into the
   * page that asked for them.
   *
   * @param {string} title
   * @param {string} body
   * @returns {void}
   */
  notify(title, body) {
    try {
      ipcRendererApi.send('shell:notify', { title: String(title), body: String(body) })
    } catch {
      // intentionally empty
    }
  },

  /**
   * Subscribes to the "window was just unhidden" event so the renderer can
   * resume polling or visual updates it had paused. Multiple subscribers are
   * allowed; the underlying listener is fanned out.
   *
   * @param {() => void} handler
   * @returns {() => void} unsubscribe
   */
  onShown(handler) {
    if (typeof handler !== 'function') return () => {}
    const listener = () => {
      try { handler() } catch { /* ignore renderer errors */ }
    }
    ipcRendererApi.on('shell:shown', listener)
    return () => ipcRendererApi.removeListener('shell:shown', listener)
  },
}))