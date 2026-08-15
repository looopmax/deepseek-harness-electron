import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { pipeline } from 'node:stream/promises'

const VERSION = process.env.NODE_VERSION || 'v24.14.0'
const BASE = 'https://nodejs.org/dist'
const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..')
const TARGET_DIR = join(ROOT, 'runtime')

const OS_NAMES = { darwin: 'darwin', linux: 'linux', win32: 'win' }
const ARCH_NAMES = { x64: 'x64', arm64: 'arm64' }

async function download(url, dest) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`download failed: ${url} -> ${response.status} ${response.statusText}`)
  await pipeline(response.body, createWriteStream(dest))
}

function extract(archive, destDir, stripComponents) {
  execFileSync('tar', ['-xzf', archive, '--strip-components', String(stripComponents), '-C', destDir], { stdio: 'inherit' })
}

async function main() {
  const platform = OS_NAMES[process.platform]
  if (!platform) throw new Error(`unsupported platform ${process.platform}`)
  const archs = process.platform === 'darwin' ? ['x64', 'arm64'] : [ARCH_NAMES[process.arch]]

  for (const arch of archs) {
    const distName = `node-${VERSION}-${platform}-${arch}`
    const ext = process.platform === 'win32' ? 'zip' : 'tar.gz'
    const url = `${BASE}/${VERSION}/${distName}.${ext}`
    const outDir = join(TARGET_DIR, `${process.platform}-${arch}`)
    const archivePath = join(TARGET_DIR, `${distName}.${ext}`)

    await mkdir(outDir, { recursive: true })
    await download(url, archivePath)
    await extract(archivePath, outDir, 1)
    await rm(archivePath, { force: true })

    const nodePath = process.platform === 'win32'
      ? join(outDir, 'node.exe')
      : join(outDir, 'bin', 'node')
    console.log(`Node runtime ready: ${nodePath}`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
