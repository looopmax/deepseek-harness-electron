// Prepare the deepseek-harness tree for Windows packaging as a symlink-free
// hoisted pnpm install.
//
// The normal packaged harness keeps pnpm's .pnpm virtual store plus the
// symlink/junction graph that pnpm creates. 7-Zip and NSIS File /r both fail
// on that graph on Windows, and dereferencing the graph (tar -L) duplicates
// the whole closure and produced a 1.6 GB zip. A hoisted pnpm install is flat,
// has no symlinks (only .bin shims on POSIX, .cmd/.ps1 on Windows) and keeps
// the package closure to a normal size.
//
// This script is idempotent enough for CI: it removes harness node_modules,
// re-installs only the runtime workspace closure, then materializes a real
// node_modules/@deepseek-ai/<name> directory for each workspace package so
// Node's standard bare-specifier resolution still works for dynamically
// loaded bundles/plugins.
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..', '..', '..')
const HARNESS = path.join(ROOT, 'packages', 'deepseek-harness')

function computeClosureForRoot() {
  // Avoids a static import so this file stays runnable with plain Node CJS.
  return import('./runtime-closure.mjs').then((m) => m.computeClosure(ROOT))
}

function scanWorkspace(root) {
  const map = new Map()
  const scan = (dir, depth) => {
    if (depth > 5) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (['node_modules', '.git', 'dist', 'lib', '.turbo'].includes(entry.name) || entry.name.startsWith('.')) continue
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        scan(p, depth + 1)
      } else if (entry.name === 'package.json') {
        try {
          const pkg = JSON.parse(readFileSync(p, 'utf8'))
          if (pkg.name) map.set(pkg.name, path.relative(HARNESS, path.dirname(p)))
        } catch { /* ignore unreadable manifest */ }
      }
    }
  }
  for (const base of ['vendor', 'packages', 'native', 'apps']) scan(path.join(root, base), 0)
  return map
}

function removeAllNodeModulesDirs(root) {
  const readdir = (dir) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.name === 'node_modules') {
        rmSync(path.join(dir, entry.name), { recursive: true, force: true })
      } else if (entry.isDirectory()) {
        readdir(path.join(dir, entry.name))
      }
    }
  }
  readdir(root)
}

function removeAllSymlinks(root) {
  let count = 0
  const walk = (dir) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const p = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        try { unlinkSync(p); count++ } catch { /* already gone */ }
      } else if (entry.isDirectory()) {
        walk(p)
      }
    }
  }
  walk(root)
  return count
}

function dirSize(root) {
  let total = 0
  const walk = (dir) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.isFile()) {
        try { total += statSync(p).size } catch { /* ignore */ }
      }
    }
  }
  walk(root)
  return total
}

async function main() {
  const closure = await computeClosureForRoot()
  const workspaceNames = closure.workspaceNames
  const workspaceMap = scanWorkspace(HARNESS)
  console.log(`[hoist] runtime closure: ${workspaceNames.length} workspace packages`)

  console.log('[hoist] removing harness node_modules symlink trees')
  removeAllNodeModulesDirs(HARNESS)

  const filterArgs = []
  for (const name of workspaceNames) filterArgs.push('--filter', name)

  console.log('[hoist] running pnpm install --node-linker=hoisted --hoist-pattern=* --prod ' +
    `(--filter x ${workspaceNames.length})`)
  const install = spawnSync('pnpm', [
    'install',
    '--node-linker=hoisted',
    '--hoist-pattern=*',
    '--prod',
    ...filterArgs,
  ], {
    cwd: HARNESS,
    stdio: 'inherit',
    env: process.env,
  })

  if (install.status !== 0) {
    // The root package's postinstall installs lefthook, which is intentionally
    // not installed under --prod. All runtime package scripts (esbuild,
    // node-pty, koffi, subprocess-local) have already run by this point. Accept
    // the failure only when the runtime loader chain is present.
    const required = ['node_modules/tsx', 'node_modules/esbuild', 'node_modules/koffi', 'node_modules/node-pty']
    const missing = required.filter((rel) => existsSync(path.join(HARNESS, rel)))
    if (missing.length !== required.length) {
      console.error(`[hoist] pnpm install failed and required packages are missing: ${required.filter((r) => !missing.includes(r)).join(', ')}`)
      process.exit(1)
    }
    console.warn('[hoist] pnpm install exited non-zero, but required runtime packages are present; continuing')
  }

  console.log('[hoist] materializing real node_modules/@deepseek-ai workspace package directories')
  let copied = 0
  for (const name of workspaceNames) {
    const short = name.startsWith('@') ? name.split('/')[1] : name
    const rel = workspaceMap.get(name)
    if (!rel) {
      console.warn(`[hoist] no source dir for ${name}`)
      continue
    }
    const src = path.join(HARNESS, rel)
    const dest = path.join(HARNESS, 'node_modules', '@deepseek-ai', short)
    if (existsSync(dest)) continue
    mkdirSync(dest, { recursive: true })
    cpSync(src, dest, {
      recursive: true,
      filter: (s) => {
        const r = path.relative(src, s)
        return r === '' || (!r.startsWith('node_modules') && !r.startsWith('.git'))
      },
    })
    copied++
  }
  console.log(`[hoist] copied ${copied} workspace package dirs into node_modules/@deepseek-ai`)

  const removed = removeAllSymlinks(HARNESS)
  console.log(`[hoist] removed ${removed} symlinks`)

  const size = dirSize(path.join(HARNESS, 'node_modules'))
  console.log(`[hoist] hoisted harness node_modules size: ${(size / (1024 * 1024 * 1024)).toFixed(2)} GiB`)
  console.log('[hoist] done')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
