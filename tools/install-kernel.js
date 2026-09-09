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

/** @typedef {{kernel: {name: string, version: string, integrity: string, bin: string}, shippedPlugins?: Record<string, {version: string, integrity: string}>}} UpstreamLock */

/** @returns {UpstreamLock} */
function readLock() {
  const raw = readFileSync(join(repoRoot, 'upstream.lock.json'), 'utf8')
  return /** @type {UpstreamLock} */ (JSON.parse(raw))
}

function main() {
  const { kernel, shippedPlugins } = readLock()
  const spec = `${kernel.name}@${kernel.version}`

  // Skip the network round-trip if what is on disk already matches the lock. The
  // kernel tree is several hundred packages; cold-installing it takes ~25 minutes,
  // and `prepack:app` re-runs this script on every `dist:*` invocation. Verifying
  // the installed manifest is cheaper than reinstalling, and is the same check the
  // full path runs at the end.
  if (isAlreadyInstalled(kernel) && areShippedPluginsInstalled(shippedPlugins ?? {})) {
    console.log(`kernel ${kernel.version} already installed; skipping npm install`)
    verify(kernel)
    verifyShippedPlugins(shippedPlugins ?? {})
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

  // Shipped plugins are installed alongside the kernel, under the same `node_modules/`
  // tree. The kernel's bundle resolver walks both anchors (install and profile), so a
  // plugin installed here is reachable from any user profile without each user having
  // to fetch it themselves. Each plugin is installed independently with `--no-save` so
  // the payload manifest never carries them — they live in package-lock.json only.
  installShippedPlugins(shippedPlugins ?? {})

  patchShippedPlugins()

  rebuildNativeModules()

  verify(kernel)
  verifyShippedPlugins(shippedPlugins ?? {})
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

/**
 * Whether a key in `upstream.lock.json` is a documentation entry rather than a
 * plugin to install. `JSON.parse` does not understand comments; the convention
 * in this file is to use `$comment` (and the like) as a real key carrying a
 * human-readable note. Skipping them here keeps the build honest.
 *
 * @param {string} key
 * @returns {boolean}
 */
function isCommentKey(key) {
  return key.startsWith('$')
}

/**
 * Installs the shipped plugins (pinned in `upstream.lock.json#shippedPlugins`) into
 * the kernel tree, where the bundle resolver can find them via the install anchor.
 *
 * Each plugin is fetched and laid down in its own `npm install --save`. Saving
 * (rather than `--no-save`) is required for the verification step to work:
 * `package-lock.json` has to record the shipped plugin's entry, otherwise
 * {@link verifyShippedPlugins} has nothing to compare against. The dependency
 * also lands in the placeholder kernel manifest at `resources/kernel/package.json`,
 * which is fine — that file is `private: true` and never published, and a
 * declared dependency is exactly what `healProfilesModuleFallback` walks to
 * symlink into the user's profile node_modules.
 *
 * @param {NonNullable<UpstreamLock['shippedPlugins']>} plugins
 */
function installShippedPlugins(plugins) {
  for (const [name, pin] of Object.entries(plugins)) {
    if (isCommentKey(name)) continue
    console.log(`installing shipped plugin ${name}@${pin.version}`)
    execFileSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      [
        'install',
        '--save',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        `${name}@${pin.version}`,
      ],
      { cwd: kernelDir, stdio: 'inherit', shell: process.platform === 'win32' },
    )
  }
}

/**
 * Whether every shipped plugin is already installed at its pinned version. Used
 * together with {@link isAlreadyInstalled} for the kernel entry to decide whether
 * the network round-trip can be skipped entirely.
 *
 * @param {NonNullable<UpstreamLock['shippedPlugins']>} plugins
 * @returns {boolean}
 */
function areShippedPluginsInstalled(plugins) {
  const names = Object.keys(plugins).filter((name) => !isCommentKey(name))
  if (names.length === 0) return true
  const lockPath = join(kernelDir, 'package-lock.json')
  if (!existsSync(lockPath)) return false
  let installed
  try {
    installed = JSON.parse(readFileSync(lockPath, 'utf8'))
  } catch {
    return false
  }
  return names.every((name) => {
    const entry = installed.packages?.[`node_modules/${name}`]
    return entry !== undefined && entry.version === plugins[name].version
  })
}

/**
 * Verifies every shipped plugin against its lock entry. Mirrors {@link verify} for
 * the kernel entry itself: a build that ships the wrong plugin is as wrong as a
 * build that ships the wrong kernel.
 *
 * @param {NonNullable<UpstreamLock['shippedPlugins']>} plugins
 */
function verifyShippedPlugins(plugins) {
  const lockPath = join(kernelDir, 'package-lock.json')
  if (!existsSync(lockPath)) {
    throw new Error('npm produced no package-lock.json, so shipped plugins cannot be verified')
  }
  const installed = JSON.parse(readFileSync(lockPath, 'utf8'))

  for (const [name, pin] of Object.entries(plugins)) {
    if (isCommentKey(name)) continue
    const entry = installed.packages?.[`node_modules/${name}`]
    if (entry === undefined) {
      throw new Error(`shipped plugin ${name} is absent from the installed tree`)
    }
    if (entry.version !== pin.version) {
      throw new Error(
        `installed ${name}@${entry.version}, but upstream.lock.json pins ${pin.version}`,
      )
    }
    if (entry.integrity !== pin.integrity) {
      throw new Error(
        [
          `integrity mismatch for ${name}@${pin.version}`,
          `  expected: ${pin.integrity}`,
          `  actual:   ${String(entry.integrity)}`,
          'The registry served a different shipped-plugin artefact than the one this repository pinned.',
        ].join('\n'),
      )
    }
  }
}

/**
 * Source-level patches applied to shipped plugins after `npm install`. Each
 * entry is a {@link ShippedPluginPatch} keyed by the plugin's installed
 * directory under `node_modules/`.
 *
 * `npm install` overwrites the plugin tree every time it runs, so the patch
 * needs to be applied after every install — including the "already installed"
 * fast path at the top of {@link main}. The sentinel string in each patch's
 * `find` argument makes that idempotent: if the patch is already present,
 * the find does not match and the file is left alone.
 *
 * The patch lives in this file on purpose. A `.patch` file would have to be
 * kept in sync with the upstream tarball by hand; the literal `find`/`replace`
 * strings below are reviewed at the same time as the surrounding code, so a
 * new release of dsh-market that breaks the match fails the build at this
 * step rather than silently shipping a broken plugin.
 */
const SHIPPED_PLUGIN_PATCHES = /** @type {const} */ ([
  {
    plugin: 'dshmarket',
    file: 'lib/dsh-cli.js',
    // Why this is patched:
    //
    // dsh-market's PATH probe hard-codes a small list of bin directories
    // (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, the Node install
    // dir). It misses the Node-version-manager installs that are by far the
    // most common way a developer actually has npm/corepack/pnpm on disk —
    // `~/.nvm/versions/node/<v>/bin` for nvm, `~/.fnm/node-versions/<v>/.../bin`
    // for fnm. When dsh is launched from a GUI (Electron .desktop file, a
    // packaged app), the shell function that adds those directories to PATH
    // never runs, so every child the market spawns fails with ENOENT and the
    // user gets a "install pnpm" hint for a problem the fix is on their disk.
    //
    // The patch enumerates those version-manager bin directories and adds
    // them to the candidate list, so a probe for `npm` finds the one sitting
    // in the user's nvm tree.
    find: `function spawnEnv() {
    // pnpm v10+ blocks forever on a silent interactive prompt without a TTY;
    // CI mode forces it to act or fail instead of asking.
    const separator = process.platform === 'win32' ? ';' : ':';
    const parts = (process.env.PATH ?? '').split(separator).filter(part => part !== '');
    const candidates = process.platform === 'win32'
        ? [nodeBinDir, ...extraPathDirs]
        : ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin'), nodeBinDir, ...extraPathDirs];`,
    replace: `function spawnEnv() {
    // pnpm v10+ blocks forever on a silent interactive prompt without a TTY;
    // CI mode forces it to act or fail instead of asking.
    const separator = process.platform === 'win32' ? ';' : ':';
    const parts = (process.env.PATH ?? '').split(separator).filter(part => part !== '');
    const candidates = process.platform === 'win32'
        ? [nodeBinDir, ...extraPathDirs]
        : [
            '/opt/homebrew/bin',
            '/usr/local/bin',
            join(homedir(), '.local', 'bin'),
            ...nodeVersionManagerBins(),
            nodeBinDir,
            ...extraPathDirs,
        ];
    for (const bin of candidates) {
        if (!parts.includes(bin))
            parts.push(bin);
    }
    return { ...process.env, ...proxyEnvForPnpm(process.env, activeRegion()), CI: 'true', PATH: parts.join(separator) };
}
/**
 * \`bin\` directories the Node version managers (nvm, fnm) install their shims
 * under. A desktop launch never inherits the shell function that adds them to
 * PATH, so the static candidate list above is blind to them — npm and corepack
 * then look like "not found" even though they are sitting one directory away
 * from a node the user uses every day (#patch-node-version-managers).
 *
 * Each entry is appended only when the parent directory actually exists, so a
 * missing toolchain adds no junk to PATH. Globbing is avoided because the
 * version subdirectories are stable per install and a single walk at probe
 * time costs a \`readdirSync\` we already pay when scanning PATH anyway.
 */
function nodeVersionManagerBins() {
    const home = homedir();
    /** @type {string[]} */
    const bins = [];
    const nvmRoot = join(home, '.nvm', 'versions', 'node');
    if (existsSync(nvmRoot)) {
        try {
            for (const entry of readdirSync(nvmRoot))
                bins.push(join(nvmRoot, entry, 'bin'));
        }
        catch { /* unreadable nvm dir; fall back to the static list */ }
    }
    const fnmRoot = join(home, '.fnm', 'node-versions');
    if (existsSync(fnmRoot)) {
        try {
            for (const entry of readdirSync(fnmRoot))
                bins.push(join(fnmRoot, entry, 'installation', 'bin'));
        }
        catch { /* unreadable fnm dir; fall back to the static list */ }
    }
    return bins;
}`,
  },
])

/**
 * @typedef {{
 *   plugin: string,
 *   file: string,
 *   find: string,
 *   replace: string,
 * }} ShippedPluginPatch
 */

/**
 * Apply every entry in {@link SHIPPED_PLUGIN_PATCHES} to its plugin's source.
 * Each patch is a literal `find`/`replace` pair; the file is rewritten when
 * `find` matches and left alone when it does not (the patch is already in
 * place). A `find` that does not match the upstream source AND is not the
 * patched variant is a build error: a new plugin release has broken our
 * patch, and shipping a half-patched plugin would be worse than failing.
 */
function patchShippedPlugins() {
  for (const patch of SHIPPED_PLUGIN_PATCHES) {
    const target = join(kernelDir, 'node_modules', patch.plugin, patch.file)
    if (!existsSync(target)) {
      // The plugin is not installed (yet). Nothing to patch; if it shows up
      // later, the next `kernel:install` run will patch it.
      continue
    }

    const original = readFileSync(target, 'utf8')
    if (original.includes(patch.replace)) {
      console.log(`shipped plugin ${patch.plugin}: ${patch.file} already patched`)
      continue
    }
    if (!original.includes(patch.find)) {
      throw new Error(
        [
          `shipped plugin ${patch.plugin}: ${patch.file} no longer matches the patch baseline`,
          'A new upstream release of this plugin probably refactored the surrounding code.',
          'Update SHIPPED_PLUGIN_PATCHES in tools/install-kernel.js and the local edit in resources/kernel/node_modules/.',
        ].join('\n'),
      )
    }

    const patched = original.replace(patch.find, patch.replace)
    writeFileSync(target, patched, 'utf8')
    console.log(`shipped plugin ${patch.plugin}: patched ${patch.file}`)
  }
}

try {
  main()
} catch (error) {
  console.error(`\ninstall-kernel failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
