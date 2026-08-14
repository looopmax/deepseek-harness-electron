#!/usr/bin/env node
// Cross-platform wrapper for electron-builder that raises the Node heap limit.
//
// Why: @electron/osx-sign walks the whole app bundle in Node. With the harness
// copy baked in by build/afterPack.js (1.2 GB node_modules, ~100k files/symlinks),
// the default ~2-4 GB heap overflows and electron-builder dies with
// "FATAL ERROR: Ineffective mark-compacts near heap limit ... JavaScript heap
// out of memory". CI (release.yml) already sets NODE_OPTIONS=--max-old-space-size=8192
// for its builder step; this wrapper applies the same policy to local builds
// (`npm run pack` / `npm run dist`) without shell-specific env syntax that would
// break on Windows cmd.
//
// Behavior: if NODE_OPTIONS already contains an explicit --max-old-space-size,
// that value is respected (user/CI wins); otherwise the recommended limit is
// injected, preserving any other NODE_OPTIONS flags.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'

const HEAP_FLAG = '--max-old-space-size=8192'
const require = createRequire(import.meta.url)

const pkgPath = require.resolve('electron-builder/package.json')
const pkg = require(pkgPath)
const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin['electron-builder']
if (!binRel) {
  console.error('run-builder: cannot locate electron-builder bin entry')
  process.exit(1)
}
const entry = path.join(path.dirname(pkgPath), binRel)

const env = { ...process.env }
if (!env.NODE_OPTIONS) {
  env.NODE_OPTIONS = HEAP_FLAG
} else if (!env.NODE_OPTIONS.includes('--max-old-space-size')) {
  env.NODE_OPTIONS = `${env.NODE_OPTIONS} ${HEAP_FLAG}`
}

const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
})
child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`electron-builder terminated by signal ${signal}`)
    process.exit(1)
  }
  process.exit(code ?? 1)
})
child.on('error', (error) => {
  console.error('run-builder: failed to spawn electron-builder:', error)
  process.exit(1)
})
