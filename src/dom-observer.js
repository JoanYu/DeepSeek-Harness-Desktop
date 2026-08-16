/**
 * Renderer-side observer script source, exposed as a string so the shell can
 * hand it to `webContents.executeJavaScript` once the page is ready.
 *
 * The observer detects the "agent finished a task" transition by watching
 * the kernel's web UI for an in-flight indicator (spinner / generating pill /
 * "thinking" text). When the indicator disappears, it calls
 * `window.shell.notify`, the locked-down bridge the preload exposes.
 *
 * Why observe the DOM rather than poll the kernel API:
 *
 *   1. The kernel's `/api/v1.*` endpoints require browser-trust markers
 *      (`Host`, `Sec-Fetch-Site`, `Origin`) the shell cannot produce from a
 *      separate process.
 *   2. The kernel is in developer preview; documented endpoints move between
 *      releases. Polling them couples the shell to a moving target.
 *   3. The "agent finished" signal *is* visible in the DOM — the indicator
 *      the kernel's UI plugins render while a turn is running.
 *
 * The matchers are kept loose and extensible: when a future kernel release
 * introduces a new indicator, adding it here is a one-line change.
 *
 * @module dom-observer
 */

/**
 * The complete observer script, as a string. The shell executes this in the
 * renderer's main world after every successful page load.
 */
export const OBSERVER_SOURCE = `(function () {
  if (window.__DSH_SHELL_OBSERVER__ === true) return
  window.__DSH_SHELL_OBSERVER__ = true

  var BUSY_SELECTORS = [
    '[aria-busy="true"]',
    '[data-state="generating"]',
    '[data-state="streaming"]',
    '[data-state="busy"]',
    '[data-loading="true"]',
    '.dsh-generating',
    '.dsh-thinking',
    '.dsh-streaming'
  ]

  var BUSY_TEXT_PATTERNS = [
    /generating/i,
    /thinking\\.{0,3}$/i,
    /思考中/i,
    /生成中/i
  ]

  function isBusy() {
    for (var i = 0; i < BUSY_SELECTORS.length; i++) {
      if (document.querySelector(BUSY_SELECTORS[i]) !== null) return true
    }
    var all = document.querySelectorAll('*')
    for (var j = 0; j < all.length; j++) {
      var text = all[j].textContent
      if (text === null) continue
      for (var k = 0; k < BUSY_TEXT_PATTERNS.length; k++) {
        if (BUSY_TEXT_PATTERNS[k].test(text)) return true
      }
    }
    return false
  }

  var busy = isBusy()

  var observer = new MutationObserver(function () {
    var now = isBusy()
    if (busy === now) return
    busy = now
    if (!busy && typeof window.shell === 'object' && typeof window.shell.notify === 'function') {
      window.shell.notify('DeepSeek Harness', 'The agent finished its current task.')
    }
  })

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-busy', 'data-state', 'data-loading', 'class']
  })

  // Close the window where a turn completes between observer attach and the
  // first MutationObserver tick.
  var attempts = 0
  var initial = setInterval(function () {
    attempts++
    var now = isBusy()
    if (busy !== now) {
      busy = now
      if (!busy && typeof window.shell === 'object' && typeof window.shell.notify === 'function') {
        window.shell.notify('DeepSeek Harness', 'The agent finished its current task.')
      }
    }
    if (attempts >= 5) clearInterval(initial)
  }, 1000)
})()`