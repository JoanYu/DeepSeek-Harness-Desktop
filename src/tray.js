/**
 * System tray management for Windows.
 *
 * On Windows, closing the main window hides it to the system tray instead of
 * quitting the app; the user brings it back through the tray icon and quits
 * from the tray context menu. macOS keeps the app alive with no windows, so
 * this module also lets a Mac build use the same tray surface without changing
 * the close-to-tray policy.
 *
 * @module tray
 */

import { Tray, Menu, nativeImage, Notification, app } from 'electron'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** @type {Tray | null} */
let tray = null

/** @type {import('electron').BrowserWindow | null} */
let mainWindowRef = null

/**
 * Get the correct path to the tray icon, handling both dev and packaged scenarios.
 *
 * Windows prefers the .ico form (it carries the multi-resolution data the shell
 * expects); macOS has no use for .ico, so the PNG is reused there.
 *
 * @returns {string}
 */
function getIconPath() {
  if (app.isPackaged) {
    // In packaged app, extraResources puts files next to the asar archive.
    return join(process.resourcesPath, 'assets', trayIconFile())
  }
  return join(here, '..', 'assets', trayIconFile())
}

/**
 * Pick the right icon filename for the platform.
 * @returns {string}
 */
function trayIconFile() {
  return process.platform === 'win32' ? 'icon.ico' : 'icon.png'
}

/**
 * Build the tray icon image at the size the shell expects.
 *
 * @returns {Electron.NativeImage}
 */
function buildTrayImage() {
  const iconPath = getIconPath()
  const icon = nativeImage.createFromPath(iconPath)

  // Windows system tray icons render at 16x16; macOS uses 16x16 to 22x22 depending
  // on display scale. Resizing the PNG to 16x16 produces a crisp icon on both.
  if (extname(iconPath).toLowerCase() === '.png') {
    return icon.resize({ width: 16, height: 16 })
  }
  return icon
}

/**
 * @param {import('electron').BrowserWindow} window
 */
export function createTray(window) {
  mainWindowRef = window

  tray = new Tray(buildTrayImage())
  tray.setToolTip('DeepSeek Harness Desktop')

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Window',
      click: () => {
        if (mainWindowRef && !mainWindowRef.isDestroyed()) {
          mainWindowRef.show()
          mainWindowRef.focus()
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        // Use app.quit() to trigger proper quit flow (which runs `before-quit`,
        // which shuts the kernel down).
        app.quit()
      },
    },
  ])

  tray.setContextMenu(contextMenu)

  // On Windows the click handler is also fired for left-clicks; on macOS it is
  // not (left-click opens the menu). Toggle the window on either platform so
  // the behaviour stays consistent for users who run multiple platforms.
  tray.on('click', () => {
    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
      if (mainWindowRef.isVisible()) {
        mainWindowRef.focus()
      } else {
        mainWindowRef.show()
        mainWindowRef.focus()
      }
    }
  })

  return tray
}

/**
 * Show a notification when a task completes.
 *
 * @param {string} title
 * @param {string} body
 */
export function showTaskNotification(title, body) {
  if (!Notification.isSupported()) return

  const notification = new Notification({
    title,
    body,
    silent: false,
  })

  notification.on('click', () => {
    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
      mainWindowRef.show()
      mainWindowRef.focus()
    }
  })

  notification.show()
}

/**
 * Destroy the tray instance.
 */
export function destroyTray() {
  if (tray) {
    tray.destroy()
    tray = null
  }
}