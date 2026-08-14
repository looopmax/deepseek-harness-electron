const { app, BrowserWindow, dialog } = require('electron')
const { spawn } = require('node:child_process')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const HARNESS_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'harness')
  : path.join(__dirname, 'deepseek-harness')
const HARNESS_NODE_MODULES = path.join(HARNESS_DIR, 'node_modules')
const HARNESS_DIST_INDEX = path.join(HARNESS_DIR, 'apps', 'web', 'dist', 'index.html')
const HARNESS_CMD = process.env.DSH_BIN || 'pnpm'
const NODE_BIN = process.env.DSH_NODE
  || (app.isPackaged
    ? path.join(process.resourcesPath, 'runtime', process.platform === 'win32' ? 'node.exe' : path.join('bin', 'node'))
    : 'node')
const STARTUP_URL_RE = /dsh web: (http:\/\/[^\s]+)/
const ICON_PATH = path.join(__dirname, 'assets', 'icon.png')
const ICON_BASE64 = (() => {
  try {
    return fs.readFileSync(ICON_PATH).toString('base64')
  } catch {
    /* icon is decorative; fall back to the text-only loading screen */
    return ''
  }
})()

const LOADING_HTML = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    body { margin: 0; display: flex; align-items: center; justify-content: center; height: 100vh;
           background: #0d1117; color: #e6edf3; font-family: -apple-system, sans-serif; }
    div { text-align: center; }
    p { color: #8b949e; font-size: 13px; }
  </style>
</head>
<body>
  <div>
    ${ICON_BASE64 ? `<img src="data:image/png;base64,${ICON_BASE64}" width="112" height="112" alt="" style="border-radius:26px; margin-bottom:18px; box-shadow:0 8px 32px rgba(77,107,254,0.35)" />` : ''}
    <h2>DeepSeek Harness</h2>
    <p id="status">starting…</p>
  </div>
</body>
</html>`)}`

let harnessProc = null
let mainWindow = null
let quitting = false

function log(message) {
  console.log(`[dsh-desktop] ${message}`)
}

function killHarness() {
  if (!harnessProc || harnessProc.pid === undefined) return
  const pid = harnessProc.pid
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    /* already gone */
  }
  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }, 3000)
}

function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'], env: process.env })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} ${args.join(' ')} failed with ${code ?? signal}`))
    })
  })
}

async function ensureHarnessBuilt() {
  if (app.isPackaged) return
  if (!fs.existsSync(HARNESS_NODE_MODULES)) {
    log('installing harness dependencies…')
    await runCommand(HARNESS_CMD, ['install'], HARNESS_DIR)
  }
  if (!fs.existsSync(HARNESS_DIST_INDEX)) {
    log('building harness web app…')
    await runCommand(HARNESS_CMD, ['run', 'build'], HARNESS_DIR)
  }
}

function waitForServer(url, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const probe = () => {
      const req = http.get(url, (res) => {
        res.resume()
        resolve()
      })
      req.setTimeout(2000, () => req.destroy())
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error(`harness did not become ready at ${url}`))
        else setTimeout(probe, 500)
      })
    }
    probe()
  })
}

function startHarness() {
  const command = app.isPackaged ? NODE_BIN : HARNESS_CMD
  const args = app.isPackaged
    ? ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web', '--port', '0']
    : ['dsh', 'web', '--port', '0']
  const env = { ...process.env }
  if (app.isPackaged) {
    env.DSH_HOME = path.join(app.getPath('userData'), 'dsh')
  }
  return new Promise((resolve, reject) => {
    log(`spawning ${command} ${args.join(' ')} (cwd: ${HARNESS_DIR}, packaged: ${app.isPackaged})`)
    const child = spawn(command, args, {
      cwd: HARNESS_DIR,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    })
    harnessProc = child
    child.on('error', (error) => {
      log(`harness spawn error: ${error.message}`)
      reject(error)
    })

    let url = null
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString()
      log(text.trim())
      const match = STARTUP_URL_RE.exec(text)
      if (match) url = match[1]
    })
    child.stderr.on('data', (chunk) => log(chunk.toString().trim()))
    child.on('exit', (code, signal) => {
      log(`harness exited (code=${code}, signal=${signal})`)
      if (!quitting) {
        dialog.showErrorBox(
          'DeepSeek Harness exited',
          `The harness process terminated unexpectedly (code=${code ?? 'unknown'}). The app will quit.`,
        )
        app.quit()
      }
    })

    const deadline = Date.now() + 60000
    const poll = async () => {
      if (url) {
        try {
          await waitForServer(url)
          resolve(url)
        } catch (error) {
          reject(error)
        }
        return
      }
      if (Date.now() > deadline) {
        reject(new Error('harness did not report a listening URL in time'))
        return
      }
      setTimeout(poll, 250)
    }
    poll()
  })
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    title: 'DeepSeek Harness',
    icon: ICON_PATH,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    return { action: 'deny' }
  })
  mainWindow.loadURL(url)
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    if (process.platform === 'darwin' && app.dock && fs.existsSync(ICON_PATH)) {
      app.dock.setIcon(ICON_PATH)
    }
    let loadingWindow = new BrowserWindow({
      width: 1280,
      height: 840,
      show: false,
      webPreferences: { sandbox: true },
    })
    loadingWindow.loadURL(LOADING_HTML)
    loadingWindow.once('ready-to-show', () => loadingWindow.show())

    try {
      await ensureHarnessBuilt()
      const url = await startHarness()
      log(`harness ready at ${url}`)
      createWindow(url)
      loadingWindow.destroy()
      loadingWindow = null
    } catch (error) {
      log(`failed to start harness: ${error.message}`)
      dialog.showErrorBox('DeepSeek Harness failed to start', error.message)
      app.quit()
    }
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('before-quit', (event) => {
    if (harnessProc && !quitting) {
      quitting = true
      event.preventDefault()
      killHarness()
      setTimeout(() => app.exit(0), 3500)
    }
  })
}
