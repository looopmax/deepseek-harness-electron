const { cp, readdir, stat, unlink } = require('node:fs/promises')
const { existsSync } = require('node:fs')
const fs = require('node:fs')
const path = require('node:path')

const HARNESS_SRC = path.join(__dirname, '..', 'deepseek-harness')

// ---------------------------------------------------------------------------
// Harness-side excludes.
//
// The packaged harness boots the CLI from SOURCE via tsx
// (node --import tsx/esm apps/cli/src/bin.ts web). tsx applies
// tsconfig.base.json "paths", so every workspace import resolves to the
// packages/*/src trees; the compiled lib/ output is never loaded. The .pnpm
// keep-set is computed by build/runtime-closure.mjs: the transitive symlink
// closure of the shipped bundle/preset plugins and the CLI's own deps, minus
// curated browser/build/test-only entries (react/shiki/vite/playwright/…).
// ---------------------------------------------------------------------------
const EXCLUDE_PATTERNS = [
  // VCS / CI / agent meta
  /(^|[\/])\.git([\/]|$)/,
  /(^|[\/])\.github([\/]|$)/,
  /(^|[\/])\.agents([\/]|$)/,
  /(^|[\/])\.dsh-lefthook-owned$/,
  /^\.DS_Store$/,
  /^\.gitattributes$/,
  /^\.npmrc$/,
  // tests / docs / non-runtime top-level trees
  /(^|[\/])tests([\/]|$)/,
  /(^|[\/])test([\/]|$)/,
  /(^|[\/])__tests__([\/]|$)/,
  /(^|[\/])docs([\/]|$)/,
  /(^|[\/])examples([\/]|$)/,
  /(^|[\/])scripts([\/]|$)/,
  /(^|[\/])website([\/]|$)/,
  /^assets([\/]|$)/,
  /^patches([\/]|$)/,
  /^python[\/]sdk-runtime([\/]|$)/,
  // build / dev metadata
  /\.map$/,
  /\.tsbuildinfo$/,
  /^pnpm-lock\.yaml$/,
  /^lefthook\.yml$/,
  /^knip\.json$/,
  /^pytest\.ini$/,
  /^vitest.*\.config\.ts$/,
  /^vitest\.shared\.ts$/,
  /tsdown\.config\.ts$/,
  /vite\.config\.ts$/,
  // Compiled workspace output: tsx resolves everything to src via tsconfig
  // paths, so packages/vendor/apps lib/ is dead weight in the packaged copy.
  /^packages[\/][^\/]+[\/][^\/]+[\/]lib([\/]|$)/,
  /^vendor[\/][^\/]+[\/]lib([\/]|$)/,
  /^apps[\/][^\/]+[\/]lib([\/]|$)/,
  // apps/web: only package.json + dist are needed at runtime (the web-app
  // bundle resolves '@deepseek-ai/dsh-web-frontend/dist/index.html').
  /^apps[\/]web[\/](src|public|node_modules|tests|stress-tests|lib)([\/]|$)/,
  /^apps[\/]web[\/]index\.html$/,
  /^apps[\/]web[\/]tsconfig\.json$/,
  // pnpm's own virtual-store metadata is not needed at runtime.
  /^node_modules[\/]\.pnpm[\/]lock\.yaml$/,
]

// ---------------------------------------------------------------------------
// Runtime-side excludes (bundled Node). The harness only needs bin/node; the
// C headers (include/), man pages (share/), the bundled npm/corepack CLI and
// the license docs never participate in the boot path.
// ---------------------------------------------------------------------------
const RUNTIME_EXCLUDE_PATTERNS = [
  /^include([\/]|$)/,
  /^share([\/]|$)/,
  /^lib([\/]|$)/,
  /^bin[\/](npm|npx|corepack)$/,
  /^(CHANGELOG\.md|README\.md|LICENSE)$/,
]

function matchesAny(relative, patterns) {
  return patterns.some((pattern) => pattern.test(relative))
}

// ---------------------------------------------------------------------------
// Copy with the native fs.cp implementation (recursive, C++ backed) instead of
// a per-file JS loop. Symlinks are recreated as links: dereferencing would loop
// forever on pnpm's cyclic peer links (ELOOP/ENAMETOOLONG), and the default
// verbatimSymlinks:false would re-point targets at the source path, breaking
// them in the packaged app. pnpm's relative link targets resolve inside the
// copied tree, so keeping them verbatim works. Node preserves file modes by
// default; returning false from the filter skips a directory and its subtree.
// ---------------------------------------------------------------------------
function copyTree(source, target, filter) {
  return cp(source, target, {
    recursive: true,
    verbatimSymlinks: true,
    filter: filter
      ? (src) => !filter(path.relative(source, src))
      : undefined,
  })
}

// Guard against symlink cycles (pnpm can materialize cyclic peer links) and
// remove symlinks whose target was pruned (e.g. browser-only deps). Node's
// resolution walks up to the hoisted entry, so imports still resolve.
async function cleanupBrokenLinks(root) {
  let removed = 0
  async function walk(dir) {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const p = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        try {
          await stat(p) // follows the link; throws for dangling / looping links
        } catch (error) {
          if (error.code === 'ENOENT' || error.code === 'ELOOP' || error.code === 'ENAMETOOLONG') {
            await unlink(p)
            removed++
          }
        }
      } else if (entry.isDirectory()) {
        await walk(p)
      }
    }
  }
  await walk(root)
  if (removed > 0) console.log(`[afterPack] removed ${removed} broken/cyclic link(s)`)
}

exports.default = async function afterPack(context) {
  const { appOutDir, electronPlatformName, packager, arch } = context
  const appDir = electronPlatformName === 'darwin'
    ? path.join(appOutDir, `${packager.appInfo.productName}.app`)
    : appOutDir
  const resourcesDir = electronPlatformName === 'darwin'
    ? path.join(appDir, 'Contents', 'Resources')
    : path.join(appDir, 'resources')
  const target = path.join(resourcesDir, 'harness')

  // Compute the runtime dependency closure of the harness.
  let pnpmKeep = null
  try {
    const { computeClosure } = await import('./runtime-closure.mjs')
    const closure = computeClosure(HARNESS_SRC)
    pnpmKeep = closure.pnpmKeep
    console.log(`[afterPack] runtime closure: ${closure.workspaceNames.length} workspace packages, ${pnpmKeep.size} .pnpm entries kept`)
  } catch (error) {
    // If the closure cannot be computed, fall back to shipping everything
    // (previous behavior) rather than producing a broken app.
    console.error('[afterPack] closure computation failed, shipping full harness:', error.message)
  }

  const excluded = (relative) => {
    if (matchesAny(relative, EXCLUDE_PATTERNS)) return true
    if (pnpmKeep) {
      const pnpm = relative.match(/^node_modules[\/]\.pnpm[\/]([^\/]+)/)
      // The 'node_modules' entry under .pnpm/ is pnpm's hidden-hoist directory
      // (node_modules/.pnpm/node_modules/<pkg> -> ../../<entry>/node_modules/<pkg>).
      // Deep package resolution (e.g. the node-addon native binding, loader
      // internals) walks up into it, so it must be shipped wholesale; dangling
      // links inside are removed by cleanupBrokenLinks after the copy.
      if (pnpm && pnpm[1] !== 'node_modules' && !pnpmKeep.has(pnpm[1])) return true
    }
    return false
  }

  console.log(`[afterPack] copying harness to ${target}`)
  await copyTree(HARNESS_SRC, target, excluded)
  await cleanupBrokenLinks(target)

  const archName = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }[arch] || 'x64'
  const platformName = electronPlatformName === 'darwin' ? 'darwin' : electronPlatformName === 'win32' ? 'win32' : 'linux'
  const runtimeSource = path.join(__dirname, '..', 'runtime', `${platformName}-${archName}`)
  if (existsSync(runtimeSource)) {
    const runtimeTarget = path.join(resourcesDir, 'runtime')
    console.log(`[afterPack] copying node runtime to ${runtimeTarget}`)
    await copyTree(runtimeSource, runtimeTarget, (relative) => matchesAny(relative, RUNTIME_EXCLUDE_PATTERNS))
    await cleanupBrokenLinks(runtimeTarget)
  } else {
    console.warn(`[afterPack] node runtime not found at ${runtimeSource}, skipping`)
  }
  console.log('[afterPack] done')
}