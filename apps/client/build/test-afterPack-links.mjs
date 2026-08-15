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

  // --- absorbed-workspace store scenario: the harness links carry REPO-ROOT
  // relative text (they resolve into the repo's .pnpm store), which points
  // nowhere when read from the deeper packaged tree. afterPack must rewrite
  // them into a packaged .pnpm store it materializes from the keep-set.
  {
    const fsp = await import('node:fs/promises')
    const base2 = path.join(base, 'absorbed')
    const storeSrc = path.join(base2, 'store')
    const pkgSrc = path.join(base2, 'harness')
    const pkgDst = path.join(base2, 'out')
    mkdirSync(path.join(storeSrc, 'tsx@4.0.0', 'node_modules', 'tsx'), { recursive: true })
    writeFileSync(path.join(storeSrc, 'tsx@4.0.0', 'node_modules', 'tsx', 'index.js'), 'export {}')
    mkdirSync(path.join(storeSrc, 'pruned@1.0.0', 'node_modules', 'pruned'), { recursive: true })
    writeFileSync(path.join(storeSrc, 'pruned@1.0.0', 'node_modules', 'pruned', 'index.js'), '')
    mkdirSync(path.join(pkgSrc, 'apps', 'cli', 'node_modules'), { recursive: true })
    await fsp.symlink('../../../../store/tsx@4.0.0/node_modules/tsx', path.join(pkgSrc, 'apps', 'cli', 'node_modules', 'tsx'), 'dir')
    await fsp.symlink('../../../../store/pruned@1.0.0/node_modules/pruned', path.join(pkgSrc, 'apps', 'cli', 'node_modules', 'pruned'), 'dir')

    await copyTree(pkgSrc, pkgDst)
    await rewriteEscapingLinks(pkgDst, pkgSrc, {
      pnpmKeep: new Set(['tsx@4.0.0']),
      pnpmStoreDir: storeSrc,
      pnpmTargetDir: path.join(pkgDst, 'node_modules', '.pnpm'),
    })
    await cleanupBrokenLinks(pkgDst)

    const afterTsx = readlinkSync(path.join(pkgDst, 'apps', 'cli', 'node_modules', 'tsx'))
    const resolvedTsx = path.resolve(path.join(pkgDst, 'apps', 'cli', 'node_modules'), afterTsx)
    check('store link rewritten into packaged .pnpm entry',
      resolvedTsx === path.join(pkgDst, 'node_modules', '.pnpm', 'tsx@4.0.0', 'node_modules', 'tsx') &&
      existsSync(resolvedTsx))
    check('non-kept store link removed', !existsSync(path.join(pkgDst, 'apps', 'cli', 'node_modules', 'pruned')))
  }

  console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILURE(S)`)
  process.exitCode = failures.length === 0 ? 0 : 1
} finally {
  rmSync(base, { recursive: true, force: true })
}
