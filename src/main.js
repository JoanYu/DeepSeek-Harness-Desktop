/**
 * Electron entry point: orchestration and IO only.
 *
 * Every decision this file acts on is made in a module that can be tested without
 * Electron — what remains here is starting a process, opening a window, and wiring the
 * two together.
 *
 * @module main
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { mkdir, symlink } from 'node:fs/promises'
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
 * @returns {{binPath: string, nodePath: string, runElectronAsNode: boolean, root: string}}
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
    root,
  }
}

/**
 * Walks the bundled `node_modules/` and returns every package that declares
 * itself as a dsh bundle (i.e. has a `dsh.bundle.patch` in its package.json) —
 * skipping the kernel's own `@deepseek-ai/*` packages, which the profile template
 * already covers.
 *
 * Used to discover shipped plugins at runtime: any package laid down under
 * `resources/kernel/node_modules/` by the build pipeline that ships a patch
 * layer gets picked up automatically, with no separate manifest to keep in sync.
 *
 * @param {string} nodeModulesRoot - absolute path of the bundled `node_modules/`
 * @returns {string[]} package names, in `node_modules/` directory order
 */
function discoverShippedPlugins(nodeModulesRoot) {
  if (!existsSync(nodeModulesRoot)) return []
  /** @type {string[]} */
  const shipped = []
  for (const entry of readdirSync(nodeModulesRoot)) {
    if (entry.startsWith('.')) continue
    if (entry.startsWith('@deepseek-ai/')) continue
    const pkgPath = join(nodeModulesRoot, entry, 'package.json')
    if (!existsSync(pkgPath)) continue
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      if (pkg.dsh?.bundle?.patch !== undefined) shipped.push(entry)
    } catch {
      // An unreadable bundled package is a build error; surface it but do not
      // refuse to start the kernel over a missing optional plugin.
    }
  }
  return shipped
}

/**
 * Registers every shipped plugin into the user's profile manifest, so the kernel
 * loads it on boot the same way it would load a plugin the user installed
 * themselves.
 *
 * Why this is necessary: the kernel only loads packages listed in the profile's
 * `dsh.profile.bundles`. A plugin shipped alongside the kernel (laid down at build
 * time under `resources/kernel/node_modules/<plugin>/`) is reachable through the
 * install anchor when `resolveBundleDir` is asked for it — but it is not on the
 * bundle list until something puts it there. `dsh plugin --profile web add <path>`
 * would do this through pnpm, which would require pnpm to be on PATH on every
 * install. Editing the profile manifest directly avoids the pnpm dependency and
 * keeps the shipped copy where it already is: the user gets the same registry
 * entry as if they had installed it themselves, and `dsh plugin` later (which
 * pnpm does power) sees it as a regular dependency and leaves it alone.
 *
 * A second step is required because of how the kernel loads bundles: an entry
 * declared in a bundle's patch file is activated by `tree.import(<name>)` from
 * inside the profile directory, and Node's ESM resolution from there walks
 * `node_modules/` looking for `<name>`. The shipped copy sits in the kernel's
 * tree, not in the user's profile, and `healProfilesModuleFallback` only
 * symlinks the kernel manifest's declared dependencies — not anything added at
 * build time. Symlinking each shipped plugin into the profile's `node_modules/`
 * is what makes the dynamic import succeed without requiring pnpm to be on PATH.
 *
 * Idempotent: a profile that already lists every shipped plugin is left untouched
 * (the bundle list check is the source of truth); the symlink is also a no-op when
 * it already points at the same target.
 *
 * A failure here is logged but does not abort startup — the user gets a working
 * shell, just without the shipped plugins.
 *
 * @param {string} dshHome - this app's private kernel home
 * @param {string} shippedRoot - the directory of the bundled `node_modules/`
 * @returns {Promise<void>}
 */
async function ensureShippedPlugins(dshHome, shippedRoot) {
  const shippedNames = discoverShippedPlugins(shippedRoot)
  if (shippedNames.length === 0) return

  const profileDir = join(dshHome, 'profiles', 'web')
  const profileNodeModules = join(profileDir, 'node_modules')
  const manifestPath = join(profileDir, 'package.json')

  let existing = /** @type {{dependencies?: Record<string, string>, dsh?: {profile?: {bundles?: string[]}}} | null} */ (null)
  if (existsSync(manifestPath)) {
    try {
      existing = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch (error) {
      // A corrupt profile manifest is exactly what we are trying to amend — fall
      // through and rebuild the shape around the existing file rather than refusing
      // to start the kernel over a missing bundle.
      console.warn(`shipped plugins: existing profile manifest could not be parsed (${error instanceof Error ? error.message : String(error)}); rewriting`)
    }
  }

  const registeredBundles = new Set(existing?.dsh?.profile?.bundles ?? [])
  const missing = shippedNames.filter((name) => !registeredBundles.has(name))

  // Always ensure the symlinks, even on a re-run after the bundle list is already
  // up to date. A first launch that ran an earlier (no-symlink) version of this
  // step left the bundles registered but no profile-side link, which means a
  // later dynamic `import 'dshmarket'` from inside the profile still cannot
  // resolve the package.
  await mkdir(profileNodeModules, { recursive: true })
  const relinked = []
  for (const name of shippedNames) {
    const source = join(shippedRoot, name)
    const link = join(profileNodeModules, name)
    if (!existsSync(link)) {
      await mkdir(dirname(link), { recursive: true })
      await symlink(source, link, 'dir')
      relinked.push(name)
    }
  }
  if (relinked.length > 0) {
    console.log(`shipped plugins: linked ${relinked.join(', ')} into ${profileNodeModules}`)
  }

  if (missing.length === 0 && existing !== null) return

  // The bundles a fresh `dsh` profile starts with. Mirrors the template the
  // kernel's own `initProfile` would have written had it run first — and it
  // must, because this bootstrap runs before the kernel boots, so the kernel
  // sees the manifest as already initialised and skips its own template seed.
  // A profile that lists `dshmarket` but no `dsh-web-app` would boot the kernel
  // with no web surface at all.
  const WEB_PROFILE_TEMPLATE = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

  // `dependencies` and `bundles` both need the shipped name. `bundles` is what
  // `loadProfile` walks to resolve and activate a layer; `dependencies` is what
  // `dsh plugin` later reads to decide whether a package is still installed
  // (without an entry here, a future reconciliation would prune the bundle).
  const manifest = existing ?? {
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [...WEB_PROFILE_TEMPLATE] } },
  }
  manifest.dependencies = manifest.dependencies ?? {}
  manifest.dsh = manifest.dsh ?? {}
  manifest.dsh.profile = manifest.dsh.profile ?? {}
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles ?? [...WEB_PROFILE_TEMPLATE]

  for (const name of missing) {
    const source = join(shippedRoot, name)
    manifest.dependencies[name] = `file:${source}`
    if (!manifest.dsh.profile.bundles.includes(name)) {
      manifest.dsh.profile.bundles.push(name)
    }
  }

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(`shipped plugins: registered ${shippedNames.join(', ')} into profile at ${profileDir}`)
}

/**
 * Starts the kernel and waits until it is genuinely serving.
 *
 * @returns {Promise<{origin: string}>}
 * @throws when the kernel cannot be started or never becomes ready
 */
async function startKernel() {
  const { binPath, nodePath, runElectronAsNode, root: kernelRoot } = resolveKernelPaths()
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

  // Shipped plugins must be registered in the profile before the kernel starts, so
  // their patch layers are part of the very first profile load. Failures here are
  // logged and swallowed — the user still gets a working shell, just without the
  // bundled defaults.
  try {
    await ensureShippedPlugins(dshHome, join(kernelRoot, 'node_modules'))
  } catch (error) {
    console.warn(`shipped plugins bootstrap failed: ${error instanceof Error ? error.message : String(error)}`)
  }

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
