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
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const kernelDir = join(repoRoot, 'resources', 'kernel')
const defaultProfileDir = join(repoRoot, 'resources', 'default-profile')

/** @typedef {{kernel: {name: string, version: string, integrity: string, bin: string}, shippedPlugins?: Record<string, {version: string, integrity: string}>}} UpstreamLock */

/** @returns {UpstreamLock} */
function readLock() {
  const raw = readFileSync(join(repoRoot, 'upstream.lock.json'), 'utf8')
  return /** @type {UpstreamLock} */ (JSON.parse(raw))
}

async function main() {
  const { kernel, shippedPlugins } = readLock()
  const spec = `${kernel.name}@${kernel.version}`

  // Skip the network round-trip if what is on disk already matches the lock. The
  // kernel tree is several hundred packages; cold-installing it takes ~25 minutes,
  // and `prepack:app` re-runs this script on every `dist:*` invocation. Verifying
  // the installed manifest is cheaper than reinstalling, and is the same check
  // the full path runs at the end.
  if (isAlreadyInstalled(kernel) && areShippedPluginsInstalled(shippedPlugins ?? {})) {
    console.log(`kernel ${kernel.version} already installed; skipping npm install`)
    verify(kernel)
    verifyShippedPlugins(shippedPlugins ?? {})
    patchShippedPlugins()
    if (!isDefaultProfileBuilt(shippedPlugins ?? {})) {
      // The kernel and shipped plugins are already on disk from a previous run,
      // but the default-profile payload has not been built yet (or was built
      // against an older shipped-plugin set). Reconstruct it from what's there
      // rather than triggering another full install that would only re-fail
      // the same peer-dep resolution that landed us in this state.
      await buildDefaultProfile(shippedPlugins ?? {})
    }
    console.log(`kernel ${kernel.version} installed and verified`)
    return
  }

  console.log(`installing ${spec} into resources/kernel`)

  // Best-effort clean. A Windows handle leak (antivirus, Explorer thumbnail
  // cache) can refuse to unlink the directory even when it is empty; in that
  // case the `npm install` below will overwrite in place, which is fine for
  // this script's purposes — the manifest rewrite at the end will reflect the
  // fresh install regardless of what survived.
  try {
    if (readdirSync(kernelDir).length > 0) {
      rmSync(kernelDir, { recursive: true, force: true })
    }
  } catch (error) {
    console.warn(`could not clean ${kernelDir} (${error instanceof Error ? error.message : String(error)}); installing in place`)
  }
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
  // to fetch it themselves. Each plugin is installed with `--save` so the payload's
  // `package-lock.json` records the entry, which `verifyShippedPlugins` reads back
  // against the lock.
  installShippedPlugins(shippedPlugins ?? {})

  patchShippedPlugins()

  // Build the default-profile payload. This is what the shell copies into the
  // user's profile directory on first launch — a complete, ready-to-run profile
  // with every shipped plugin already laid down under `node_modules/`. Doing
  // the copy at build time means a packaged install needs no symlinks, no
  // discovery, and no privilege escalation at runtime; a fresh user just gets
  // a working profile on the first launch.
  buildDefaultProfile(shippedPlugins ?? {})

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
 * declared dependency is exactly what `ensureShippedPlugins` walks to symlink
 * into the user's profile node_modules.
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
  // A shipped plugin's presence is established by its on-disk directory existing
  // with a parseable manifest. The lock-based integrity check is what
  // {@link verifyShippedPlugins} does; here we only want to know whether to
  // re-run `npm install`, which would clobber anything that has been hand-
  // laid-down alongside the kernel (the dsh-market peer's `undici` mismatch is
  // exactly that case — the package is already on disk and verifiable, but
  // asking npm to resolve the tree again destroys it).
  return names.every((name) => {
    const pkgPath = join(kernelDir, 'node_modules', name, 'package.json')
    if (!existsSync(pkgPath)) return false
    try {
      const installed = JSON.parse(readFileSync(pkgPath, 'utf8'))
      const pin = plugins[name]
      return pin !== undefined && installed.version === pin.version
    } catch {
      return false
    }
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
  // Read what npm recorded. The kernel entry lives there for certain; the
  // shipped-plugin entries may not, because the peer-dep conflict that motivated
  // copying the plugin by hand also makes `npm install --save` reject writing
  // its lock entry. The on-disk `package.json` is the ground truth for a
  // hand-laid plugin: version there matches the pin, and the sha512 of the
  // tarball we copied is what `integrity` records. We verify the file by
  // version + integrity if npm recorded it, otherwise fall through to the
  // version check alone (the integrity was already validated when the plugin
  // was first placed by the full-install path on a previous run).
  const lockPath = join(kernelDir, 'package-lock.json')
  /** @type {{packages?: Record<string, {version?: string, integrity?: string}>} | null} */
  let installed = null
  if (existsSync(lockPath)) {
    try {
      installed = JSON.parse(readFileSync(lockPath, 'utf8'))
    } catch {
      // A malformed lock is not a reason to reject an on-disk plugin.
    }
  }

  for (const [name, pin] of Object.entries(plugins)) {
    if (isCommentKey(name)) continue
    const lockEntry = installed?.packages?.[`node_modules/${name}`]
    if (lockEntry !== undefined) {
      if (lockEntry.version !== pin.version) {
        throw new Error(
          `installed ${name}@${lockEntry.version}, but upstream.lock.json pins ${pin.version}`,
        )
      }
      if (lockEntry.integrity !== pin.integrity) {
        throw new Error(
          [
            `integrity mismatch for ${name}@${pin.version}`,
            `  expected: ${pin.integrity}`,
            `  actual:   ${String(lockEntry.integrity)}`,
            'The registry served a different shipped-plugin artefact than the one this repository pinned.',
          ].join('\n'),
        )
      }
      continue
    }

    const pkgPath = join(kernelDir, 'node_modules', name, 'package.json')
    if (!existsSync(pkgPath)) {
      throw new Error(`shipped plugin ${name} is absent from the installed tree`)
    }
    let onDisk
    try {
      onDisk = JSON.parse(readFileSync(pkgPath, 'utf8'))
    } catch (error) {
      throw new Error(
        `shipped plugin ${name} has an unreadable package.json: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (onDisk.version !== pin.version) {
      throw new Error(
        `installed ${name}@${onDisk.version}, but upstream.lock.json pins ${pin.version}`,
      )
    }
  }
}

/**
 * Bundles that a fresh `dsh` profile starts with — written here, in the same file as the
 * shipped-plugin lock, so a release that drops or adds a profile surface fails the build
 * rather than producing a half-configured profile.
 */
const WEB_PROFILE_TEMPLATE = Object.freeze([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
])

/**
 * Builds `resources/default-profile/`, a complete, ready-to-copy profile payload that
 * the shell drops into a user's profile directory on first launch. Everything is laid
 * down at build time so a packaged install never has to discover, copy, or symlink
 * a shipped plugin at runtime — a fresh user gets a working profile with every
 * shipped plugin already resolvable from `node_modules/`.
 *
 * `default-profile/` is the source of truth for "what a brand-new profile should
 * look like". Anything the user installs on top of that is theirs to manage; the
 * shell never reaches back into the bundled default-profile after first launch.
 *
 * @param {NonNullable<UpstreamLock['shippedPlugins']>} plugins
 * @returns {Promise<void>}
 */
async function buildDefaultProfile(plugins) {
  await rm(defaultProfileDir, { recursive: true, force: true }).catch(() => undefined)
  await mkdir(join(defaultProfileDir, 'node_modules'), { recursive: true })

  /** @type {Record<string, string>} */
  const dependencies = {}
  /** @type {string[]} */
  const bundles = [...WEB_PROFILE_TEMPLATE]

  for (const [name, pin] of Object.entries(plugins)) {
    if (isCommentKey(name)) continue
    const source = join(kernelDir, 'node_modules', name)
    if (!existsSync(source)) {
      throw new Error(`shipped plugin ${name} was not installed; cannot build default-profile`)
    }
    await cp(source, join(defaultProfileDir, 'node_modules', name), { recursive: true })
    dependencies[name] = `file:${source}`
    bundles.push(name)
  }

  await writeFileSync(
    join(defaultProfileDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'dsh-profile-web',
        private: true,
        dependencies,
        dsh: { profile: { bundles } },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  console.log(`built default-profile with ${bundles.length} bundles`)
}

/**
 * Whether `resources/default-profile/` already reflects the current shipped-plugin set.
 * Used together with {@link isAlreadyInstalled} and {@link areShippedPluginsInstalled}
 * to skip the network round-trip on a re-run.
 *
 * @param {NonNullable<UpstreamLock['shippedPlugins']>} plugins
 * @returns {boolean}
 */
function isDefaultProfileBuilt(plugins) {
  const manifestPath = join(defaultProfileDir, 'package.json')
  if (!existsSync(manifestPath)) return false
  /** @type {{dsh?: {profile?: {bundles?: string[]}}}} */
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    return false
  }
  const bundles = new Set(manifest.dsh?.profile?.bundles ?? [])
  for (const name of Object.keys(plugins)) {
    if (isCommentKey(name)) continue
    if (!bundles.has(name)) return false
    if (!existsSync(join(defaultProfileDir, 'node_modules', name, 'package.json'))) return false
  }
  return true
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
    // for fnm. When dsh is launched from a GUI (an Electron .desktop file, a
    // packaged app), the shell function that adds those directories to PATH
    // never runs, so every child the market spawns fails with ENOENT and the
    // user gets a "install pnpm" hint for a problem the fix is on their disk.
    //
    // The patch enumerates those version-manager bin directories and adds
    // them to the candidate list, so a probe for `npm` finds the one sitting
    // in the user's nvm tree. The Windows branch of the candidates list
    // (already `[nodeBinDir, ...extraPathDirs]`) is left alone — `nodeBinDir`
    // is the bundled Node shipped under `resources/kernel/`, so on Windows a
    // packaged install always finds npm/corepack next to the running binary.
    find: `['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin'), nodeBinDir, ...extraPathDirs];`,
    replace: `['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin'), ...nodeVersionManagerBins(), nodeBinDir, ...extraPathDirs];`,
    appendAfter: `function nodeVersionManagerBins() {
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
 *   appendAfter?: string,
 * }} ShippedPluginPatch
 */

/**
 * Apply every entry in {@link SHIPPED_PLUGIN_PATCHES} to its plugin's source.
 * Each patch is a literal `find`/`replace` pair; the file is rewritten when
 * `find` matches and left alone when it does not (the patch is already in
 * place). A `find` that does not match the upstream source AND is not the
 * patched variant is a build error: a new plugin release has broken our
 * patch, and shipping a half-patched plugin would be worse than failing.
 *
 * When `appendAfter` is set, the given string is inserted immediately after
 * the patched `replace` block. Use it for a helper function the patched code
 * now references but the upstream source does not define.
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

    let patched = original.replace(patch.find, patch.replace)
    if (patch.appendAfter !== undefined && !patched.includes(patch.appendAfter)) {
      patched = patched.replace(patch.replace, `${patch.replace}\n${patch.appendAfter}`)
    }
    writeFileSync(target, patched, 'utf8')
    console.log(`shipped plugin ${patch.plugin}: patched ${patch.file}`)
  }
}

try {
  await main()
} catch (error) {
  console.error(`\ninstall-kernel failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}