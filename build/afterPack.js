const { cp } = require('node:fs/promises')
const { existsSync } = require('node:fs')
const path = require('node:path')

const HARNESS_SRC = path.join(__dirname, '..', 'deepseek-harness')
// (^|[\\/]) anchors the pattern to a path-segment boundary so top-level
// entries like 'docs' or '.git' are excluded, not just nested ones.
const EXCLUDE_PATTERNS = [
  /(^|[\\/])\.git([\\/]|$)/,
  /(^|[\\/])tests([\\/]|$)/,
  /(^|[\\/])test([\\/]|$)/,
  /(^|[\\/])__tests__([\\/]|$)/,
  /(^|[\\/])docs([\\/]|$)/,
  /(^|[\\/])website([\\/]|$)/,
  /(^|[\\/])\.agents([\\/]|$)/,
  /(^|[\\/])\.github([\\/]|$)/,
  /\.map$/,
  /(^|[\\/])node_modules[\\/]\.cache([\\/]|$)/,
  /(^|[\\/])\.dsh-lefthook-owned$/,
  // python/sdk-runtime is a deploy-only manifest whose isolated dependency tree
  // contains cyclic peer links (cordis <-> cordis-plugin-loader) that hang
  // symlink-following packagers (ELOOP on Linux, OOM/giant-string on mac/win).
  /(^|[\\/])python[\\/]sdk-runtime([\\/]|$)/,
  // Dev/build tooling never needed by the packaged runtime (the CLI runs from
  // source via tsx and serves the prebuilt web dist). Dropping them cuts the
  // installer by ~100MB and shortens installer compression time.
  /node_modules[\\/]\.pnpm[\\/](typescript|vite|vitest|@vitest|tsdown|oxlint|jscpd|playwright|@playwright|eslint|@eslint|eslint-plugin|@typescript-eslint|prettier|jsdom|happy-dom|@types|@testing-library|knip|publint|lefthook)(@|\+)/,
]

function excluded(relative) {
  return EXCLUDE_PATTERNS.some((pattern) => pattern.test(relative))
}

// Copy with the native fs.cp implementation (recursive, C++ backed) instead of a
// per-file JS loop. Symlinks are recreated as links: dereferencing would loop
// forever on pnpm's cyclic peer links (ELOOP/ENAMETOOLONG), and the default
// verbatimSymlinks:false would re-point targets at the source path, breaking
// them in the packaged app. pnpm's relative link targets resolve inside the
// copied tree, so keeping them verbatim works. Node preserves file modes by
// default; returning false from the filter skips a directory and its subtree.
async function copyTree(source, target) {
  await cp(source, target, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (src) => !excluded(path.relative(source, src)),
  })
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
  console.log(`[afterPack] copying harness to ${target}`)
  await copyTree(HARNESS_SRC, target)

  const archName = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }[arch] || 'x64'
  const platformName = electronPlatformName === 'darwin' ? 'darwin' : electronPlatformName === 'win32' ? 'win32' : 'linux'
  const runtimeSource = path.join(__dirname, '..', 'runtime', `${platformName}-${archName}`)
  if (existsSync(runtimeSource)) {
    const runtimeTarget = path.join(resourcesDir, 'runtime')
    console.log(`[afterPack] copying node runtime to ${runtimeTarget}`)
    await copyTree(runtimeSource, runtimeTarget)
  } else {
    console.warn(`[afterPack] node runtime not found at ${runtimeSource}, skipping`)
  }
  console.log('[afterPack] done')
}