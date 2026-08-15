// Test: afterPack link normalization behaves correctly for pnpm-on-Windows
// style absolute links (junctions have absolute targets) and for pruned targets.
//
// Run: node build/test-afterPack-links.mjs
import { mkdtempSync, mkdirSync, writeFileSync, readlinkSync, rmSync, existsSync, lstatSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { rewriteEscapingLinks, cleanupBrokenLinks, copyTree } = require('./afterPack.js')

const base = mkdtempSync(path.join(tmpdir(), 'dsh-afterpack-test-'))
const src = path.join(base, 'src')
const dst = path.join(base, 'dst')

// --- source tree: workspace package + .pnpm entry + a pruned tree ---
mkdirSync(path.join(src, 'packages', 'entry'), { recursive: true })
writeFileSync(path.join(src, 'packages', 'entry', 'index.js'), 'export {}')
mkdirSync(path.join(src, 'node_modules', '.pnpm', 'foo@1.0.0', 'node_modules', 'foo'), { recursive: true })
writeFileSync(path.join(src, 'node_modules', '.pnpm', 'foo@1.0.0', 'node_modules', 'foo', 'package.json'), '{}')
mkdirSync(path.join(src, 'tests'), { recursive: true })
writeFileSync(path.join(src, 'tests', 'a.test.js'), '')
mkdirSync(path.join(src, 'apps', 'cli', 'node_modules', '@deepseek-ai'), { recursive: true })

// pnpm-on-Windows style: ABSOLUTE links (junction targets are absolute).
const linkDir = path.join(src, 'apps', 'cli', 'node_modules')
await import('node:fs/promises').then((fsp) => fsp.symlink(
  path.join(src, 'packages', 'entry'),
  path.join(linkDir, '@deepseek-ai', 'entry'),
  'dir',
))
await import('node:fs/promises').then((fsp) => fsp.symlink(
  path.join(src, 'node_modules', '.pnpm', 'foo@1.0.0', 'node_modules', 'foo'),
  path.join(linkDir, 'foo'),
  'dir',
))
// link into the pruned tree (tests/) - must end up removed in the packaged copy
await import('node:fs/promises').then((fsp) => fsp.symlink(
  path.join(src, 'tests'),
  path.join(linkDir, 'pruned'),
  'dir',
))

const failures = []
const check = (name, cond) => {
  console.log(cond ? `PASS  ${name}` : `FAIL  ${name}`)
  if (!cond) failures.push(name)
}

try {
  // copy with a filter that prunes tests/ (same semantics as the real build)
  await copyTree(src, dst, (rel) => rel === 'tests' || rel.startsWith('tests/'))

  // Before: links are absolute and escape the packaged root
  const beforeEntry = readlinkSync(path.join(dst, 'apps', 'cli', 'node_modules', '@deepseek-ai', 'entry'))
  check('copied verbatim (absolute, escapes root)', path.isAbsolute(beforeEntry))

  await rewriteEscapingLinks(dst, src)
  await cleanupBrokenLinks(dst)

  const afterEntry = readlinkSync(path.join(dst, 'apps', 'cli', 'node_modules', '@deepseek-ai', 'entry'))
  const resolvedEntry = path.resolve(path.join(dst, 'apps', 'cli', 'node_modules', '@deepseek-ai'), afterEntry)
  check('workspace link rewritten to relative', !path.isAbsolute(afterEntry))
  check('workspace link now resolves INSIDE packaged tree',
    resolvedEntry === path.join(dst, 'packages', 'entry') && existsSync(resolvedEntry))

  const afterFoo = readlinkSync(path.join(dst, 'apps', 'cli', 'node_modules', 'foo'))
  const resolvedFoo = path.resolve(path.join(dst, 'apps', 'cli', 'node_modules'), afterFoo)
  check('.pnpm link rewritten and resolves inside packaged tree',
    !path.isAbsolute(afterFoo) &&
    resolvedFoo === path.join(dst, 'node_modules', '.pnpm', 'foo@1.0.0', 'node_modules', 'foo'))

  check('link to pruned target removed', !existsSync(path.join(dst, 'apps', 'cli', 'node_modules', 'pruned')))

  // no escaping links remain anywhere in the packaged tree
  let escapes = 0
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const p = path.join(dir, entry)
      const st = lstatSync(p)
      if (st.isSymbolicLink()) {
        const target = path.resolve(path.dirname(p), readlinkSync(p))
        const rel = path.relative(dst, target)
        if (rel.startsWith('..') || path.isAbsolute(rel)) escapes++
      } else if (st.isDirectory()) {
        walk(p)
      }
    }
  }
  walk(dst)
  check('zero escaping links remain in packaged tree', escapes === 0)

  console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILURE(S)`)
  process.exitCode = failures.length === 0 ? 0 : 1
} finally {
  rmSync(base, { recursive: true, force: true })
}
