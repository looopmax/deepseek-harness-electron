/**
 * Runtime dependency closure for the packaged dsh harness.
 *
 * The packaged app boots the CLI from source via tsx ("node --import tsx/esm
 * apps/cli/src/bin.ts web"). tsx applies the repo's tsconfig.base.json "paths"
 * map, so every workspace import resolves to the src/ directories of the
 * workspace packages (never the built lib/ directories). The
 * set of modules that can be loaded at runtime is therefore the transitive
 * closure of:
 *   - the plugin rows in the shipped bundle patches (base / web-app / headless),
 *   - the plugin rows in the shipped agent presets (apps/cli/config/agent-presets),
 *   - the apps/cli package.json dependencies,
 * followed through each workspace package's workspace:^ dependency specs, plus
 * every package reachable through the node_modules symlinks of the packages in
 * that closure.
 *
 * The .pnpm virtual store entries that actually matter are exactly the symlink
 * targets reachable from those packages (transitively). Everything else — test
 * tooling, the browser-only UI dependency tree, build bundlers, docs-site
 * libraries, optional agents that ship their own SDKs (Codex / Claude Code) —
 * is pruned from the packaged copy.
 *
 * This module only computes sets; build/afterPack.js consumes them in its copy
 * filter. It never touches the deepseek-harness tree.
 */

import { readdirSync, readlinkSync, existsSync, readFileSync, realpathSync } from 'node:fs'
import { join, dirname, normalize, relative, sep } from 'node:path'

const WORKSPACE_ROOTS = ['packages', 'vendor', 'native', 'apps']

/** Scanned workspace members: package name -> package directory (relative to root). */
function scanWorkspace(root) {
  const map = new Map()
  const scan = (dir, depth) => {
    if (depth > 4) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (['node_modules', '.git', 'dist', 'lib', '.turbo'].includes(entry.name) || entry.name.startsWith('.')) continue
      const p = join(dir, entry.name)
      if (entry.isDirectory()) {
        scan(p, depth + 1)
      } else if (entry.name === 'package.json') {
        try {
          const pkg = JSON.parse(readFileSync(p, 'utf8'))
          if (pkg.name) map.set(pkg.name, relative(root, dir))
        } catch { /* unreadable manifest: ignore */ }
      }
    }
  }
  for (const base of WORKSPACE_ROOTS) scan(join(root, base), 0)
  return map
}

/** Plugin names referenced by a cordis patch / preset yml (lines: name: '@deepseek-ai/...'). */
function pluginNamesFromYml(file) {
  const names = new Set()
  let text
  try { text = readFileSync(file, 'utf8') } catch { return names }
  for (const match of text.matchAll(/name:\s*'([^']+)'/g)) {
    let name = match[1]
    if (name.startsWith('@deepseek-ai/')) {
      name = name.split('/').slice(0, 2).join('/') // strip subpath like /list-agents
    }
    names.add(name)
  }
  return names
}

/**
 * Patterns for .pnpm entries that are linked into the runtime closure only
 * through browser-only UI packages, build tooling, test runners, or type
 * declarations. Each entry is verified (a) to never be imported by server-side
 * runtime source (only src/client/*, tsdown/vite configs, or test-support
 * import them), and (b) to be absent from the boot path of the packaged app.
 */
const CURATED_DROP = [
  /^typescript@/, // dev type-checker
  /^vite@/, /^@vitejs\+/, // frontend dev server
  /^vitest@/, /^@vitest\+/, // test runner
  /^@testing-library\+/, // DOM test utils
  /^jsdom@/, /^happy-dom@/, // DOM test environments
  /^playwright@/, /^playwright-core@/, // e2e browser automation
  /^rolldown@/, /^@rolldown\+/, /^tsdown@/, // bundler toolchain
  /^oxlint@/, /^@oxlint\+/, /^oxlint-tsgolint/, // linter
  /^jscpd@/, /^jscpd-/, // duplicate detector
  /^eslint@/, /^@eslint\+/, /^eslint-plugin-/, /^@stylistic\+/, // linter
  /^knip@/, /^publint@/, // repo tooling
  /^lefthook@/, /^lefthook-/, // git hooks
  /^lightningcss@/, /^lightningcss-/, // vite CSS transform
  /^browserslist@/, /^caniuse-lite@/, /^update-browserslist-db@/, // build data
  /^esbuild@(?!0\.28\.1)/, /^@esbuild\+(?![^@]+@0\.28\.1)/, // keep tsx's esbuild 0.28.1
  /^shiki@/, /^@shikijs\+/, // browser syntax highlighting
  /^katex@/, /^micromark-extension-math@/, /^mdast-util-math@/, // browser markdown math
  /^micromark@/, /^micromark-/, /^mdast-util-/, /^mdast-/, /^unist-util-/, /^hast-util-/, /^hast-/, /^remark-/, /^rehype-/, // browser markdown AST
  /^react@/, /^react-dom@/, /^@tanstack\+react-virtual@/, /^zustand@/, /^immer@/, // browser UI libs
  /^@babel\+(?!runtime|code-frame|helper-validator-identifier)/, // dev transforms; the @babel/code-frame chain (vendor/hmr) + @babel/runtime (json-schema-to-ts) are runtime deps
  /^css-tree@/, /^@asamuzakjp\+/, // css parsing used by the jsdom chain
  /^@types\+/, // type declarations only
  /^postcss@/, /^autoprefixer@/, /^sass@/, /^less@/, /^stylus@/, // build CSS
  /^prettier@/, /^@prettier\+/, // formatter
  /^vue@/, /^@vue\+/, /^@iconify\+/, /^mark\.js@/, /^dompurify@/, /^fast-check@/, // browser / property-test libs
  /^es-toolkit@/,
]

function isCuratedDrop(entry) {
  return CURATED_DROP.some((pattern) => pattern.test(entry))
}

/**
 * Compute the runtime closure.
 * @param {string} root - absolute path of the deepseek-harness working tree.
 * @returns {{ pnpmKeep: Set<string>, workspaceNames: string[] }}
 */
export function computeClosure(root) {
  const workspaceMap = scanWorkspace(root)
  const seeds = new Set()

  const addPatch = (rel) => {
    for (const name of pluginNamesFromYml(join(root, rel))) {
      if (workspaceMap.has(name)) seeds.add(name)
    }
  }
  addPatch('packages/bundle/base/cordis.patch.yml')
  addPatch('packages/bundle/web-app/cordis.patch.yml')
  addPatch('packages/bundle/headless/cordis.patch.yml')

  const presetDir = join(root, 'apps/cli/config/agent-presets')
  if (existsSync(presetDir)) {
    for (const preset of readdirSync(presetDir)) {
      addPatch(join('apps/cli/config/agent-presets', preset, 'agent.cordis.yml'))
    }
  }

  try {
    const cliPkg = JSON.parse(readFileSync(join(root, 'apps/cli/package.json'), 'utf8'))
    for (const name of Object.keys(cliPkg.dependencies || {})) {
      if (workspaceMap.has(name)) seeds.add(name)
    }
  } catch { /* no cli manifest */ }

  // --- workspace closure (BFS over workspace:^ specs) ---
  const wsClosure = new Set(seeds)
  const queue = [...seeds]
  while (queue.length) {
    const name = queue.pop()
    const dir = workspaceMap.get(name)
    if (!dir) continue
    let pkg
    try { pkg = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')) } catch { continue }
    for (const field of [pkg.dependencies, pkg.peerDependencies, pkg.optionalDependencies].filter(Boolean)) {
      for (const [dep, spec] of Object.entries(field)) {
        if (String(spec).startsWith('workspace:') && workspaceMap.has(dep) && !wsClosure.has(dep)) {
          wsClosure.add(dep)
          queue.push(dep)
        }
      }
    }
  }

  const pnpmDir = join(root, 'node_modules', '.pnpm')
  const pnpmKeep = new Set()
  const pnpmQueue = []

  const resolveLink = (linkPath) => {
    let target
    try { target = readlinkSync(linkPath) } catch { return null }
    return normalize(join(dirname(linkPath), target))
  }

  const addPnpm = (entry) => {
    if (!pnpmKeep.has(entry)) {
      pnpmKeep.add(entry)
      pnpmQueue.push(entry)
    }
  }

  // Seed: symlinks in the node_modules of every workspace package in the closure.
  const collectFromDir = (dir, addWorkspaceTargets) => {
    if (!existsSync(dir)) return
    const walk = (d) => {
      let entries
      try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        if (entry.name === '.bin' || entry.name === '.pnpm') continue
        const p = join(d, entry.name)
        if (entry.isSymbolicLink()) {
          const target = resolveLink(p)
          if (!target) continue
          // Accept both separators: path.join yields "/" on POSIX and "\"
          // on Windows, and a "/"-only class silently matched nothing on
          // Windows (0 .pnpm entries kept → all external deps pruned).
          const match = target.match(/[\\\/]\.pnpm[\\\/]([^\\\/]+)[\\\/]/)
          if (match) {
            addPnpm(match[1])
          } else if (addWorkspaceTargets) {
            try {
              const real = realpathSync(p)
              for (const [wname, wdir] of workspaceMap) {
                const abs = join(root, wdir)
                if (real === abs || real.startsWith(abs + sep)) {
                  if (!wsClosure.has(wname)) {
                    wsClosure.add(wname) // extra workspace reachable via links
                  }
                  break
                }
              }
            } catch { /* dangling or loop: handled later */ }
          }
        } else if (entry.isDirectory()) {
          walk(p)
        }
      }
    }
    walk(dir)
  }

  for (const name of wsClosure) {
    collectFromDir(join(root, workspaceMap.get(name), 'node_modules'), true)
  }

  // Transitive: walk the node_modules of every kept .pnpm entry.
  let guard = 0
  while (pnpmQueue.length && guard++ < 10000) {
    const entry = pnpmQueue.shift()
    collectFromDir(join(pnpmDir, entry, 'node_modules'), false)
  }

  // Curated drops: browser/build/test-only entries linked via the superset walk.
  const finalKeep = new Set()
  for (const entry of pnpmKeep) {
    if (!isCuratedDrop(entry)) finalKeep.add(entry)
  }

  return {
    pnpmKeep: finalKeep,
    workspaceNames: [...wsClosure].sort(),
  }
}
