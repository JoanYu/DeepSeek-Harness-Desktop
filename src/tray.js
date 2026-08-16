/**
 * System tray integration: hide-to-tray, click-to-toggle, and the desktop
 * notification the shell uses when the agent finishes work while the window
 * is in the background.
 *
 * @module tray
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

// `electron` is reached lazily through `createRequire`, so plain-Node unit
// tests can import this module without Electron being present. Module-scope
// `import { Tray } from 'electron'` would throw synchronously outside the
// Electron runtime, because Electron's main module is a native binding that
// only resolves inside it.
const nodeRequire = createRequire(import.meta.url)
const loadElectron = () => nodeRequire('electron')

/**
 * Resolves the tray icon path relative to `here` (the directory of the
 * calling module, set by `main.js`).
 *
 * The icon lives at `assets/icon.png` at the project root — both in
 * development (next to `src/`) and inside the asar in packaged builds
 * (Electron's `Tray` reads files out of the asar transparently).
 *
 * @param {string} here - directory of the calling module, e.g. `.../src`
 * @returns {string}
 */
export function trayIconPath(here) {
  return join(here, '..', 'assets', 'icon.png')
}

/**
 * Manages the lifecycle of a single Tray instance and the window that pairs
 * with it.
 *
 * The instance owns three pieces of state that the rest of the shell reads:
 *
 *   `isQuitting` — set by `prepareQuit()`. The window's "user closed" handler
 *     reads it to decide between hiding and actually closing; without the
 *     flag, `app.before-quit` would race the close handler and end up
 *     destroying the window before the kernel could shut down cleanly.
 *
 *   `isWindowVisible` — kept in sync with `BrowserWindow.isVisible()` so the
 *     context menu label ("Hide" / "Show") can be rendered correctly.
 *
 *   `tray` — the underlying Electron Tray, kept here so it is never garbage-
 *     collected (which is exactly what silently turns a tray icon into a
 *     missing tray icon).
 */
export class ShellTray {
  /** @type {import('electron').Tray | null} */
  #tray = null
  /** @type {import('electron').BrowserWindow | null} */
  #window = null
  /** @type {() => void} */
  #focus = () => {}
  /** @type {() => void} */
  #quit = () => {}
  #isQuitting = false
  #isWindowVisible = false
  /** @type {Set<(visible: boolean) => void>} */
  #visibilityListeners = new Set()

  /**
   * Creates the tray, attaches the click handlers, and wires the context menu.
   *
   * The icon file must exist; a tray with a missing icon is a tray the user
   * cannot see, which is worse than no tray at all.
   *
   * @param {object} options
   * @param {string} options.iconPath
   * @param {import('electron').BrowserWindow} options.window
   * @param {() => void} options.onShow - restore and focus the window
   * @param {() => void} options.onQuit - tear down everything and exit
   * @returns {void}
   */
  attach({ iconPath, window, onShow, onQuit }) {
    if (this.#tray !== null) return
    if (!existsSync(iconPath)) {
      throw new Error(`tray icon missing: ${iconPath}`)
    }
    this.#window = window
    this.#focus = onShow
    this.#quit = onQuit

    const tray = new (loadElectron().Tray)(iconPath)
    tray.setToolTip('DeepSeek Harness Desktop')
    tray.on('click', () => this.#onClick())
    tray.on('double-click', () => this.#focus())
    tray.setContextMenu(this.#buildMenu())
    this.#tray = tray

    window.on('show', () => this.#setVisible(true))
    window.on('hide', () => this.#setVisible(false))
  }

  /**
   * Sets the flag that tells the window-close handler to allow close (rather
   * than hiding). Called from `before-quit` so an explicit Quit always wins.
   *
   * @returns {void}
   */
  prepareQuit() {
    this.#isQuitting = true
  }

  /**
   * Whether the shell is currently shutting down. Read by the window-close
   * handler in `main.js`.
   *
   * @returns {boolean}
   */
  get isQuitting() {
    return this.#isQuitting
  }

  /**
   * Whether the window is currently visible. Read by the close handler so
   * closing an already-hidden window can be passed through to the OS (e.g.
   * when the user runs Quit from somewhere).
   *
   * @returns {boolean}
   */
  get isWindowVisible() {
    return this.#isWindowVisible
  }

  /**
   * Registers a listener fired when the window's visibility changes.
   *
   * @param {(visible: boolean) => void} listener
   * @returns {() => void} unsubscribe
   */
  onVisibilityChange(listener) {
    this.#visibilityListeners.add(listener)
    return () => this.#visibilityListeners.delete(listener)
  }

  /**
   * Posts a desktop notification through the shell's `Notification` API.
   *
   * Notifications that the OS cannot display (no `Notification.isSupported`,
   * or no notification daemon) are dropped silently: a tray icon is still
   * useful without a working notification subsystem.
   *
   * @param {string} title
   * @param {string} body
   * @returns {void}
   */
  notify(title, body) {
    const { Notification } = loadElectron()
    if (!Notification.isSupported()) return
    const notification = new Notification({
      title,
      body,
      silent: false,
    })
    notification.on('click', () => this.#focus())
    notification.show()
  }

  /**
   * Tears down the tray. Called on quit.
   *
   * @returns {void}
   */
  destroy() {
    this.#tray?.destroy()
    this.#tray = null
  }

  /**
   * @returns {Electron.Menu}
   */
  #buildMenu() {
    // Lazy load — the menu module is only required when the tray is first
    // attached, and createRequire keeps the load path pure-Node compatible.
    const { Menu } = loadElectron()
    return Menu.buildFromTemplate([
      {
        label: this.#isWindowVisible ? 'Hide window' : 'Show window',
        click: () => (this.#isWindowVisible ? this.#hide() : this.#focus()),
      },
      { type: 'separator' },
      { label: 'Quit', click: () => this.#quit() },
    ])
  }

  /** @returns {void} */
  #onClick() {
    if (this.#isWindowVisible) this.#hide()
    else this.#focus()
  }

  /**
   * @param {boolean} visible
   * @returns {void}
   */
  #setVisible(visible) {
    if (this.#isWindowVisible === visible) return
    this.#isWindowVisible = visible
    this.#tray?.setContextMenu(this.#buildMenu())
    if (visible) this.#broadcast(true)
    else this.#broadcast(false)
  }

  /** @returns {void} */
  #hide() {
    this.#window?.hide()
  }

  /**
   * @param {boolean} visible
   * @returns {void}
   */
  #broadcast(visible) {
    for (const listener of this.#visibilityListeners) {
      try { listener(visible) } catch { /* ignore listener errors */ }
    }
  }
}