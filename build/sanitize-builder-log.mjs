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
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const MARKER = '[dsh-sanitize-log-patch]'

let file
try {
  file = require.resolve('builder-util/out/log.js')
} catch {
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
