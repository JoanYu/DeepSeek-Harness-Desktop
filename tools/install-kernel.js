#!/usr/bin/env node
/**
 * Installs the pinned kernel into `resources/kernel`, ready to be bundled.
 *
 * Two properties this script exists to hold:
 *
 * Install scripts are disabled. The kernel pulls in several hundred transitive packages,
 * none of which have been audited here; an install script runs arbitrary code as whoever
 * is building, which is not a thing to accept by default for a dependency that only needs
 * to sit in a directory.
 *
 * The result is read back and checked. `npm install` reporting success says the command
 * ran, not that what landed on disk is the artefact this repository pinned. The check
 * fails the build rather than warning — a warning in build output is a warning nobody
 * reads.
 *
 * @module tools/install-kernel
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const kernelDir = join(repoRoot, 'resources', 'kernel')

/** @typedef {{kernel: {name: string, version: string, integrity: string, bin: string}}} UpstreamLock */

/** @returns {UpstreamLock} */
function readLock() {
  const raw = readFileSync(join(repoRoot, 'upstream.lock.json'), 'utf8')
  return /** @type {UpstreamLock} */ (JSON.parse(raw))
}

function main() {
  const { kernel } = readLock()
  const spec = `${kernel.name}@${kernel.version}`

  // Skip the network round-trip if what is on disk already matches the lock. The
  // kernel tree is several hundred packages; cold-installing it takes ~25 minutes,
  // and `prepack:app` re-runs this script on every `dist:*` invocation. Verifying
  // the installed manifest is cheaper than reinstalling, and is the same check the
  // full path runs at the end.
  if (isAlreadyInstalled(kernel)) {
    console.log(`kernel ${kernel.version} already installed; skipping npm install`)
    verify(kernel)
    console.log(`kernel ${kernel.version} installed and verified`)
    return
  }

  console.log(`installing ${spec} into resources/kernel`)

  rmSync(kernelDir, { recursive: true, force: true })
  mkdirSync(kernelDir, { recursive: true })

  // A private, versionless manifest: this directory is a payload, not a package, and
  // npm should never treat it as publishable or try to resolve a name for it.
  writeFileSync(
    join(kernelDir, 'package.json'),
    `${JSON.stringify({ name: 'dsh-kernel-payload', private: true, version: '0.0.0' }, null, 2)}\n`,
    'utf8',
  )

  execFileSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    [
      'install',
      spec,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--omit=dev',
      '--install-strategy=hoisted',
    ],
    { cwd: kernelDir, stdio: 'inherit', shell: process.platform === 'win32' },
  )

  rebuildNativeModules()

  verify(kernel)
  console.log(`kernel ${kernel.version} installed and verified`)
}

/**
 * @param {UpstreamLock['kernel']} kernel
 * @returns {boolean}
 */
function isAlreadyInstalled(kernel) {
  const lockPath = join(kernelDir, 'package-lock.json')
  if (!existsSync(lockPath)) return false
  try {
    const installed = /** @type {{packages?: Record<string, {version?: string, integrity?: string}>}} */ (
      JSON.parse(readFileSync(lockPath, 'utf8'))
    )
    const entry = installed.packages?.[`node_modules/${kernel.name}`]
    if (entry === undefined) return false
    return entry.version === kernel.version && entry.integrity === kernel.integrity
  } catch {
    return false
  }
}

/**
 * Re-runs the build step for native modules that need a compiled binary to load.
 *
 * `--ignore-scripts` is used by default because the kernel pulls in several hundred
 * transitive packages, none of which have been audited here: an install script runs
 * arbitrary code as whoever is building, which is not a thing to accept by default for
 * a dependency that only needs to sit in a directory.
 *
 * Linux additionally needs `node-pty` to be a version that still ships its native
 * source under `src/unix/`. The pinned `1.1.0` release on npm intentionally omits the
 * Linux source and ships only prebuilds for a few platforms; on Linux it would load
 * as JavaScript but abort with `Cannot find module './prebuilds/linux-x64/pty.node'`
 * the moment the kernel tries to spawn a pseudo-terminal. `1.1.0-beta7` is the last
 * release that still ships `src/unix/pty.cc` and compiles cleanly out of the box.
 *
 * On Windows and macOS `node-pty` ships with a working prebuilt binary in the npm
 * tarball (or the install script fetches one), so the swap is skipped on those
 * platforms — the published tarball is what is wanted there, not a manual build.
 *
 * The list of native modules is a property of this file: it expands only by edit,
 * not by what a future release decides to add.
 */
function rebuildNativeModules() {
  if (process.platform === 'linux') installLinuxPty()

  const nativePackages = ['node-pty']
  for (const name of nativePackages) {
    const pkgDir = join(kernelDir, 'node_modules', name)
    if (!existsSync(pkgDir)) continue

    console.log(`rebuilding native module ${name}`)
    execFileSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['rebuild', name],
      {
        cwd: kernelDir,
        stdio: 'inherit',
        shell: process.platform === 'win32',
      },
    )
  }
}

/**
 * Swaps `node-pty` to a release that still ships `src/unix/pty.cc` and rebuilds the
 * native addon from source.
 *
 * Background: `node-pty@1.1.0` (the version `@deepseek-ai/dsh` resolves to via `^1.1.0`
 * through `dsh-subprocess-local`) ships `prebuilds/` for Windows and macOS but not Linux,
 * and its `binding.gyp` requires the now-missing `src/unix/pty.cc`. `1.1.0-beta7`
 * predates that prune and compiles cleanly on Linux x86_64 against the bundled Node; that
 * is the only thing the override is for.
 *
 * `^1.1.0` does not by default include pre-releases, so we install the specific pinned
 * version with `--no-save`. The kernel manifest never mentions `node-pty` directly, so
 * `--no-save` is enough to keep the swap local to `resources/kernel`.
 */
function installLinuxPty() {
  console.log('swapping node-pty to 1.1.0-beta7 to recover Linux native source')
  execFileSync(
    'npm',
    ['install', '--no-save', '--ignore-scripts', '--no-audit', '--no-fund', 'node-pty@1.1.0-beta7'],
    { cwd: kernelDir, stdio: 'inherit' },
  )
}

/**
 * Reads back what was installed and compares it against the lock.
 *
 * @param {UpstreamLock['kernel']} kernel
 * @returns {void}
 */
function verify(kernel) {
  const lockPath = join(kernelDir, 'package-lock.json')
  if (!existsSync(lockPath)) {
    throw new Error('npm produced no package-lock.json, so nothing can be verified')
  }

  const installed = /** @type {{packages?: Record<string, {version?: string, integrity?: string}>}} */ (
    JSON.parse(readFileSync(lockPath, 'utf8'))
  )

  const entry = installed.packages?.[`node_modules/${kernel.name}`]
  if (entry === undefined) {
    throw new Error(`${kernel.name} is absent from the installed tree`)
  }

  if (entry.version !== kernel.version) {
    throw new Error(
      `installed ${kernel.name}@${entry.version}, but upstream.lock.json pins ${kernel.version}`,
    )
  }

  if (entry.integrity !== kernel.integrity) {
    throw new Error(
      [
        `integrity mismatch for ${kernel.name}@${kernel.version}`,
        `  expected: ${kernel.integrity}`,
        `  actual:   ${String(entry.integrity)}`,
        'The registry served a different artefact than the one this repository pinned.',
      ].join('\n'),
    )
  }

  const binPath = join(kernelDir, kernel.bin)
  if (!existsSync(binPath)) {
    throw new Error(`the kernel entry point is missing at ${kernel.bin}`)
  }
}

try {
  main()
} catch (error) {
  console.error(`\ninstall-kernel failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
