const { cp, lstat, mkdir, readdir, readlink, symlink, chmod } = require('node:fs/promises')
const { existsSync } = require('node:fs')
const path = require('node:path')

const HARNESS_SRC = path.join(__dirname, '..', 'deepseek-harness')
const EXCLUDE_PATTERNS = [
  /[\\/]\.git([\\/]|$)/,
  /[\\/]tests[\\/]/,
  /[\\/]test[\\/]/,
  /[\\/]__tests__[\\/]/,
  /[\\/]docs[\\/]/,
  /[\\/]website[\\/]/,
  /[\\/]\.agents([\\/]|$)/,
  /[\\/]\.github([\\/]|$)/,
  /\.map$/,
  /[\\/]node_modules[\\/]\.cache([\\/]|$)/,
  /[\\/]\.dsh-lefthook-owned$/,
]

function excluded(relative) {
  return EXCLUDE_PATTERNS.some((pattern) => pattern.test(relative))
}

async function copyDir(source, target) {
  await mkdir(target, { recursive: true })
  const entries = await readdir(source, { withFileTypes: true })
  for (const entry of entries) {
    const src = path.join(source, entry.name)
    const rel = path.relative(HARNESS_SRC, src)
    const dest = path.join(target, entry.name)
    if (excluded(rel)) continue
    const stat = await lstat(src)
    if (stat.isSymbolicLink()) {
      await symlink(await readlink(src), dest)
    } else if (stat.isDirectory()) {
      await copyDir(src, dest)
    } else if (stat.isFile()) {
      await cp(src, dest)
      await chmod(dest, stat.mode)
    }
  }
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
  await copyDir(HARNESS_SRC, target)

  const archName = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }[arch] || 'x64'
  const platformName = electronPlatformName === 'darwin' ? 'darwin' : electronPlatformName === 'win32' ? 'win32' : 'linux'
  const runtimeSource = path.join(__dirname, '..', 'runtime', `${platformName}-${archName}`)
  if (existsSync(runtimeSource)) {
    const runtimeTarget = path.join(resourcesDir, 'runtime')
    console.log(`[afterPack] copying node runtime to ${runtimeTarget}`)
    await copyDir(runtimeSource, runtimeTarget)
  } else {
    console.warn(`[afterPack] node runtime not found at ${runtimeSource}, skipping`)
  }
  console.log('[afterPack] done')
}
