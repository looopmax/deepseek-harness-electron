// Patch electron-builder's logger so oversized error strings stay printable.
//
// Why: builder-util's exec() embeds the ENTIRE stdout/stderr of a failed child
// process into the error message (maxBuffer is 1 GB). When a child floods
// output (e.g. a compressor walking into a symlink loop), error.message and
// error.stack exceed V8's maximum string length and the logger itself dies
// with "RangeError: Invalid string length" - masking the real failure, which
// is exactly what the Windows CI runs showed. Truncating absurdly large
// strings before formatting turns that into a readable (head of the) error.
//
// Idempotent: exits 0 without touching anything when the patch marker is
// already present or the target file has an unexpected layout.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const MARKER = '[dsh-sanitize-log-patch]'

// Only direct deps get symlinked into the consuming workspace package
// (apps/client); builder-util is a transitive dep, so fall back to scanning the
// package manager's virtual store (pnpm's node_modules/.pnpm or bun's .bun).
function findBuilderUtilLog() {
  try {
    return require.resolve('builder-util/out/log.js', {
      paths: [path.join(HERE, '..'), HERE],
    })
  } catch { /* not a direct dep - fall through to the store scan */ }
  const rootModules = path.join(HERE, '..', '..', '..', 'node_modules')
  for (const storeName of ['.pnpm', '.bun']) {
    const store = path.join(rootModules, storeName)
    let entries
    try { entries = readdirSync(store) } catch { continue }
    const hit = entries.filter((e) => e.startsWith('builder-util@')).sort().pop()
    if (!hit) continue
    const candidate = path.join(store, hit, 'node_modules', 'builder-util', 'out', 'log.js')
    if (existsSync(candidate)) return candidate
  }
  return null
}

const file = findBuilderUtilLog()
if (!file) {
  console.log('sanitize-builder-log: builder-util not installed, nothing to do')
  process.exit(0)
}

const source = readFileSync(file, 'utf8')
if (source.includes(MARKER)) {
  console.log('sanitize-builder-log: already patched')
  process.exit(0)
}

// 1. Truncate the top-level message (error.stack / error.message).
const messageAnchor = [
  '        else {',
  '            message = message.toString();',
  '        }',
].join('\n')
const messagePatch = messageAnchor + [
  '',
  '        // ' + MARKER + ' keep giant messages printable',
  '        if (typeof message === "string" && message.length > 200000) {',
  '            message = message.slice(0, 100000) + "\\n…[TRUNCATED " + message.length + " chars]";',
  '        }',
].join('\n')

// 2. Truncate field values (e.g. stackTrace=...) before String.replace, whose
//    padded result is what actually exceeded the string limit.
const fieldAnchor = '            // Remove unnecessary line breaks'
const fieldPatch = [
  '            // ' + MARKER + ' keep giant field values printable',
  '            if (fieldValue != null && typeof fieldValue === "string" && fieldValue.length > 200000) {',
  '                fieldValue = fieldValue.slice(0, 100000) + "\\n…[TRUNCATED " + fieldValue.length + " chars]";',
  '            }',
  fieldAnchor,
].join('\n')

let patched = source
let applied = 0
if (source.includes(messageAnchor)) {
  patched = patched.replace(messageAnchor, messagePatch)
  applied++
}
if (source.includes(fieldAnchor)) {
  patched = patched.replace(fieldAnchor, fieldPatch)
  applied++
}

if (applied === 0) {
  console.log('sanitize-builder-log: no known anchors found in ' + path.relative(process.cwd(), file) + '; skipping')
  process.exit(0)
}

writeFileSync(file, patched)
console.log('sanitize-builder-log: applied ' + applied + '/2 truncation guard(s) to ' + path.relative(process.cwd(), file))
