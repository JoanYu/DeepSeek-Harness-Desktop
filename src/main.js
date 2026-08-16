/**
 * Electron entry point: orchestration and IO only.
 *
 * Every decision this file acts on is made in a module that can be tested without
 * Electron — what remains here is starting a process, opening a window, and wiring the
 * two together.
 *
 * @module main
 */

import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { KernelProcess, findFreePort } from './kernel-process.js'
import { buildKernelArgs, buildKernelEnv, isSupportedNodeVersion } from './kernel-runtime.js'
import { nodeBinaryName } from './node-runtime.js'
import { httpProbe, waitForReady } from './readiness.js'
import { buildShellPatch, serialisePatch } from './shell-patch.js'
import { writeFile } from 'node:fs/promises'
import { ShellTray, trayIconPath } from './tray.js'
import { OBSERVER_SOURCE } from './dom-observer.js'
import {
  SECURE_WEB_PREFERENCES,
  classifyWindowOpen,
  isAllowedNavigation,
  kernelOrigin,
} from './window-policy.js'

const HOST = '127.0.0.1'
const here = dirname(fileURLToPath(import.meta.url))

/** @type {KernelProcess | null} */
let kernel = null
/** @type {BrowserWindow | null} */
let mainWindow = null
/** @type {ShellTray | null} */
let tray = null

/**
 * Where the bundled kernel lives, packaged or not.
 *
 * `extraResources` places it beside the asar archive rather than inside it: files in an
 * asar cannot be spawned, so a kernel bundled the usual way would fail only once packaged.
 *
 * @returns {{binPath: string, nodePath: string, runElectronAsNode: boolean}}
 */
function resolveKernelPaths() {
  const root = app.isPackaged ? join(process.resourcesPath, 'kernel') : join(here, '..', 'resources', 'kernel')
  const binPath = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

  // A bundled Node is preferred when present: the kernel's dependencies are published and
  // tested against Node releases, and Electron's bundled Node is a different runtime that
  // merely resembles one. Falling back to Electron is supported, but it has to be told to
  // behave as Node — see buildKernelEnv.
  const bundled = join(root, nodeBinaryName(process.platform))
  const hasBundledNode = existsSync(bundled)

  return {
    binPath,
    nodePath: hasBundledNode ? bundled : process.execPath,
    runElectronAsNode: !hasBundledNode,
  }
}

/**
 * Starts the kernel and waits until it is genuinely serving.
 *
 * @returns {Promise<{origin: string}>}
 * @throws when the kernel cannot be started or never becomes ready
 */
async function startKernel() {
  const { binPath, nodePath, runElectronAsNode } = resolveKernelPaths()
  if (!existsSync(binPath)) {
    throw new Error(
      `The kernel is not installed at:\n  ${binPath}\n\nRun "npm run kernel:install" first.`,
    )
  }

  // When Electron is standing in for Node, the runtime the kernel gets is the one this
  // process is already running on, so `process.version` is exactly the version to check.
  if (runElectronAsNode && !isSupportedNodeVersion(process.version)) {
    throw new Error(
      `The kernel needs Node 22.15.0 or newer; this build of Electron provides ${process.version}.`,
    )
  }

  const dshHome = join(app.getPath('userData'), 'kernel-home')
  await mkdir(dshHome, { recursive: true })

  const patchEntries = buildShellPatch()
  /** @type {string[]} */
  const patchFiles = []
  if (patchEntries.length > 0) {
    const patchPath = join(app.getPath('userData'), 'shell.patch.yml')
    await writeFile(patchPath, serialisePatch(patchEntries), 'utf8')
    patchFiles.push(patchPath)
  }

  const port = await findFreePort(HOST)
  const args = buildKernelArgs({ binPath, port, patchFiles })
  const env = buildKernelEnv({ parentEnv: process.env, dshHome, runElectronAsNode })

  const process_ = new KernelProcess()
  process_.start({ nodePath, args, env, cwd: app.getPath('home') })
  kernel = process_

  // A kernel that dies after the window is up leaves the window showing a page it can no
  // longer reach, with nothing anywhere saying why. Record it, and say so.
  process_.onUnexpectedExit(({ code, signal }) => {
    const logPath = join(app.getPath('userData'), 'kernel-exit.log')
    void writeFile(
      logPath,
      `${new Date().toISOString()}\nkernel exited unexpectedly: code=${String(code)} signal=${String(signal)}\n\n${process_.logText()}\n`,
      'utf8',
    ).catch(() => undefined)

    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      dialog.showErrorBox(
        'The agent runtime stopped',
        `The kernel exited unexpectedly (code ${String(code)}).\n\nIts output was written to:\n${logPath}`,
      )
    }
  })

  const origin = kernelOrigin(HOST, port)
  const readiness = await waitForReady({
    url: `${origin}/`,
    isCurrent: () => process_.isRunning(),
    probe: httpProbe,
  })

  if (!readiness.ok) {
    const why =
      readiness.reason === 'process-gone'
        ? 'The kernel exited during startup.'
        : 'The kernel did not start responding in time.'
    throw new Error(`${why}\n\nRecent output:\n${tail(process_.logText(), 25)}`)
  }

  return { origin }
}

/**
 * @param {string} origin
 * @returns {BrowserWindow}
 */
function createWindow(origin) {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 800,
    minHeight: 600,
    show: false,
    backgroundColor: '#1b1b1f',
    title: 'DeepSeek Harness Desktop',
    icon: join(here, '..', 'assets', 'icon.png'),
    // Hide the menu bar: the chat UI is driven entirely by the rendered web
    // surface, and an Electron-native menu adds nothing the user can reach.
    // `autoHideMenuBar` is the legacy of the two for the small set of users
    // who press Alt to reveal one; `setApplicationMenu(null)` below takes the
    // bar out entirely.
    autoHideMenuBar: true,
    webPreferences: {
      ...SECURE_WEB_PREFERENCES,
      // Absolute path required by Electron — a relative preload silently fails
      // to attach (and the renderer is then unable to call `shell.notify`).
      // `here` is the directory of this `main.js` script, so the same path
      // works in dev (`src/preload.js`) and in the packaged app (asar:src/preload.js).
      preload: join(here, 'preload.js'),
    },
  })

  // The single Menu.setApplicationMenu call that hides the OS menu bar on
  // every platform. Without it, Linux/Windows show File / Edit / Help above
  // the rendered UI; macOS would still show the application menu in the menu
  // bar even after `autoHideMenuBar: true`.
  Menu.setApplicationMenu(null)

  // The preload (`src/preload.js`) is the only piece of shell-side code the
  // renderer can call into. Its surface is locked to `notify` and `onShown` —
  // see `src/preload.js` for the rationale.

  const { webContents } = window

  webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url, origin)) {
      event.preventDefault()
      if (classifyWindowOpen(url, origin) === 'external') void shell.openExternal(url)
    }
  })

  webContents.setWindowOpenHandler(({ url }) => {
    const action = classifyWindowOpen(url, origin)
    if (action === 'external') void shell.openExternal(url)
    // Never `allow`: a new BrowserWindow created this way would not inherit the policy
    // applied above, so kernel URLs are navigated in place instead.
    if (action === 'same-window') void webContents.loadURL(url)
    return { action: 'deny' }
  })

  // A webview can carry its own webPreferences and would bypass every setting above.
  webContents.on('will-attach-webview', (event) => event.preventDefault())

  webContents.on('render-process-gone', (_event, details) => {
    console.error(`renderer gone: ${details.reason}`)
  })

  // Install the busy→idle observer every time the page finishes loading. The
  // observer is idempotent (guards itself on `window.__DSH_SHELL_OBSERVER__`),
  // so re-injection on SPA route changes is cheap.
  webContents.on('did-finish-load', () => {
    void webContents.executeJavaScript(OBSERVER_SOURCE, true).catch((error) => {
      console.error(`observer inject failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  })

  // Hide-to-tray on close: when the window is the only one, closing it should
  // keep the kernel running invisibly. The `tray.isQuitting` flag — set by
  // the tray's own Quit menu item and by `before-quit` below — is what lets a
  // real quit through. Without that gate, `app.before-quit` would race the
  // close handler and the kernel would never get a clean SIGTERM.
  window.on('close', (event) => {
    if (tray === null || tray.isQuitting) return
    if (!window.isVisible()) return
    event.preventDefault()
    window.hide()
  })

  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    mainWindow = null
  })

  void window.loadURL(`${origin}/`)
  return window
}

/**
 * Restores and focuses the main window, then tells the renderer so it can
 * resume anything it was pausing while hidden.
 *
 * @returns {void}
 */
function showWindow() {
  if (mainWindow === null || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  mainWindow.webContents.send('shell:shown')
}

/**
 * @param {string} text
 * @param {number} lines
 * @returns {string}
 */
function tail(text, lines) {
  return text.split('\n').slice(-lines).join('\n')
}

/** @returns {Promise<void>} */
async function shutdown() {
  const running = kernel
  kernel = null
  if (running !== null) await running.stop()
}

// A second instance would start a second kernel against the same home directory, and the
// two would overwrite each other's state.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow === null) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    try {
      const { origin } = await startKernel()
      mainWindow = createWindow(origin)

      // The IPC channel from the locked-down preload. The renderer can only
      // call `shell.notify`; everything else in the kernel web UI has no
      // bridge into the shell.
      ipcMain.on('shell:notify', (_event, payload) => {
        if (tray === null) return
        const title = typeof payload?.title === 'string' ? payload.title : 'DeepSeek Harness'
        const body = typeof payload?.body === 'string' ? payload.body : ''
        tray.notify(title, body)
      })

      // Tray is attached after the window exists so its click handlers can
      // restore it. The tray owns the "is this an explicit quit" flag the
      // window-close handler reads.
      tray = new ShellTray()
      tray.attach({
        iconPath: trayIconPath(here),
        window: mainWindow,
        onShow: () => showWindow(),
        onQuit: () => {
          tray?.prepareQuit()
          app.quit()
        },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)

      // The dialog is transient and truncates; a startup failure is exactly when someone
      // needs the whole story, so it also goes to a file whose path the dialog names.
      const logPath = join(app.getPath('userData'), 'startup-error.log')
      try {
        await writeFile(logPath, `${new Date().toISOString()}\n\n${message}\n`, 'utf8')
      } catch {
        // Reporting the original failure matters more than reporting this one.
      }

      dialog.showErrorBox(
        'DeepSeek Harness Desktop could not start',
        `${message}\n\nWritten to:\n${logPath}`,
      )
      await shutdown()
      app.exit(1)
    }
  })

  // With a tray present, "last window closed" no longer means quit: the user
  // hid it deliberately, and the kernel should keep running so the background
  // task can finish. The tray's Quit menu item is the only path that calls
  // `app.quit()` from here on.
  app.on('window-all-closed', () => {
    // intentional no-op on every platform with a tray
  })

  app.on('activate', () => {
    if (mainWindow === null || mainWindow.isDestroyed()) return
    showWindow()
  })

  // `before-quit` is the last point at which the kernel can still be stopped; without it a
  // quit triggered from the menu or the OS would leave the process tree running.
  app.on('before-quit', () => {
    tray?.prepareQuit()
    void shutdown()
    tray?.destroy()
  })
}
