// Patch electron-builder's NsisTarget to use NSIS's built-in compressor
// (File /r) instead of packaging the app dir into a .7z with 7za.
//
// Why: the packaged harness contains pnpm symlinks/junctions, and 7za on
// Windows cannot archive those ("Access is denied"). NSIS's File /r does not
// shell out to 7za; it compiles the files directly into the installer.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MARKER = '[dsh-patch-nsis-builtin]'

function findNsisTarget() {
  const rootModules = path.join(HERE, '..', '..', '..', 'node_modules')
  for (const storeName of ['.pnpm', '.bun']) {
    const store = path.join(rootModules, storeName)
    let entries
    try { entries = readdirSync(store) } catch { continue }
    const hit = entries.filter((e) => e.startsWith('app-builder-lib@')).sort().pop()
    if (hit === undefined) continue
    const candidate = path.join(store, hit, 'node_modules', 'app-builder-lib', 'out', 'targets', 'nsis', 'NsisTarget.js')
    try {
      readFileSync(candidate)
      return candidate
    } catch { /* keep looking */ }
  }
  return null
}

const file = findNsisTarget()
if (file === null) {
  console.error('patch-nsis-builtin-compressor: app-builder-lib NsisTarget.js not found')
  process.exit(1)
}

let source = readFileSync(file, 'utf8')
if (source.includes(MARKER)) {
  console.log('patch-nsis-builtin-compressor: already patched')
  process.exit(0)
}

const oldLine = 'const USE_NSIS_BUILT_IN_COMPRESSOR = false;'
if (source.includes(oldLine) === false) {
  console.error('patch-nsis-builtin-compressor: target line not found in ' + file)
  process.exit(1)
}

source = source.replace(oldLine, 'const USE_NSIS_BUILT_IN_COMPRESSOR = true; // ' + MARKER)
writeFileSync(file, source)
console.log('patch-nsis-builtin-compressor: enabled NSIS built-in compressor in ' + path.relative(process.cwd(), file))
