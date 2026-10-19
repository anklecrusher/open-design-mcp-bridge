#!/usr/bin/env node
// Stable MCP stdio entrypoint for OpenDesign on Windows.
//
// Why this wrapper exists instead of pointing dsh-mcp-lazy at "Open Design.exe":
//   1. The packaged app runs as Electron-as-Node. Without ELECTRON_RUN_AS_NODE=1
//      a second GUI window opens instead of serving MCP over stdio.
//   2. The CLI entry (daemon-cli.mjs) lives inside the install tree, whose path
//      moves between releases. This resolves it and fails with a usable message.
//   3. OD_RESOURCE_ROOT must be pinned or `list_skills` returns [] — the daemon
//      otherwise falls back to a project-relative skills dir that ships empty.
//   4. OD_DATA_DIR must match the GUI's so projects/runs are shared, not split.
//
// Overrides: OD_INSTALL_ROOT (default D:\OpenDesign), OD_DAEMON_URL
// (default http://127.0.0.1:7456).
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const INSTALL_ROOT = process.env.OD_INSTALL_ROOT ?? 'D:\\OpenDesign'
const EXE = join(INSTALL_ROOT, 'Open Design.exe')
const DAEMON_CLI = join(INSTALL_ROOT, 'resources', 'app', 'prebundled', 'daemon', 'daemon-cli.mjs')
const RESOURCE_ROOT = join(INSTALL_ROOT, 'resources', 'open-design')
const CONFIG_PATH = join(INSTALL_ROOT, 'resources', 'open-design-config.json')

function fail(message) {
  process.stderr.write(`[open-design-mcp] ${message}\n`)
  process.exit(1)
}

if (!existsSync(EXE)) fail(`Open Design executable not found at ${EXE}. Set OD_INSTALL_ROOT if installed elsewhere.`)
if (!existsSync(DAEMON_CLI)) fail(`daemon CLI entry not found at ${DAEMON_CLI}.`)

let namespace = 'release-stable-win'
try {
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  if (typeof cfg.namespace === 'string' && cfg.namespace !== '') namespace = cfg.namespace
} catch (error) {
  fail(`could not read ${CONFIG_PATH}: ${error.message}`)
}

const appData = process.env.APPDATA
if (!appData) fail('APPDATA is not set; cannot locate the Open Design data root.')
const dataDir = join(appData, 'Open Design', 'namespaces', namespace, 'data')

// The desktop app starts its daemon on an EPHEMERAL port (verified: 52974 and
// 52999 across two launches), so a hardcoded 7456 only works for a daemon this
// bridge started itself. When the GUI is running we must find its port.
//
// Discovery order:
//   1. OD_DAEMON_URL, when set explicitly — always wins.
//   2. The port the running desktop app last talked to, read from its own log
//      (`net.fetch failed ... http://127.0.0.1:<port>/...`). The app logs one of
//      these per asset it fails to prefetch, so the port is always present.
//   3. 7456, the fixed port start-daemon.mjs uses.
const OD_PORT_RE = /http:\/\/127\.0\.0\.1:(\d{2,5})\//g

function portFromDesktopLog() {
  const logPath = join(appData, 'Open Design', 'namespaces', namespace, 'logs', 'desktop', 'latest.log')
  let text
  try { text = readFileSync(logPath, 'utf8') } catch { return null }
  // Scan backwards: the newest launch's port is the last one mentioned.
  const ports = [...text.matchAll(OD_PORT_RE)].map((m) => Number(m[1]))
  for (let i = ports.length - 1; i >= 0; i -= 1) {
    const port = ports[i]
    // The desktop's own UI port also appears here; the daemon answers /api/version.
    if (Number.isFinite(port) && port > 0) return port
  }
  return null
}

async function respondsAsDaemon(port) {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1200)
    const res = await fetch(`http://127.0.0.1:${port}/api/version`, { signal: controller.signal })
    clearTimeout(timer)
    if (!res.ok) return false
    const body = await res.json()
    return body?.version?.version != null
  } catch { return false }
}

async function discoverDaemonUrl() {
  const explicit = process.env.OD_DAEMON_URL
  if (explicit) return explicit

  const fromLog = portFromDesktopLog()
  if (fromLog != null && await respondsAsDaemon(fromLog)) {
    return `http://127.0.0.1:${fromLog}`
  }
  return 'http://127.0.0.1:7456'
}

const daemonUrl = await discoverDaemonUrl()

// The daemon is a separate long-lived process. If it is not up, start it here
// so a DSH restart does not leave every tool call failing with ECONNREFUSED.
// Spawned detached and NOT awaited beyond readiness: the MCP process must not
// own the daemon's lifetime, or closing a session would kill it.
async function ensureDaemon(url, port) {
  if (process.env.OD_SKIP_DAEMON_AUTOSTART === '1') return
  const health = `${url.replace(/\/$/, '')}/api/health`
  const probe = async () => {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 1500)
      const res = await fetch(health, { signal: controller.signal })
      clearTimeout(timer)
      return res.ok
    } catch { return false }
  }
  if (await probe()) return
  const here = dirname(fileURLToPath(import.meta.url))
  const script = join(here, 'start-daemon.mjs')
  try {
    const starterChild = spawn(process.execPath, [script, '--port', String(port), '--wait', '60'], {
      env: process.env,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    starterChild.unref()
  } catch (error) {
    process.stderr.write(`[open-design-mcp] daemon autostart failed: ${error.message}\n`)
    return
  }
  const deadline = Date.now() + 65_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000))
    if (await probe()) return
  }
  process.stderr.write('[open-design-mcp] daemon did not become ready in 65s\n')
}

let daemonPort = 7456
try { daemonPort = Number(new URL(daemonUrl).port) || 7456 } catch {}
// Autostart only makes sense for the fixed port. When discovery found a live
// desktop daemon there is nothing to start, and spawning a second one on 7456
// would leave two daemons fighting over the same data directory.
await ensureDaemon(daemonUrl, daemonPort)

const child = spawn(EXE, [DAEMON_CLI, 'mcp', '--daemon-url', daemonUrl], {
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    OD_DATA_DIR: dataDir,
    OD_RESOURCE_ROOT: RESOURCE_ROOT,
    OD_INSTALLATION_DIR: RESOURCE_ROOT,
    OD_PACKAGED_NAMESPACE: namespace,
    OD_PACKAGED_CONFIG_PATH: CONFIG_PATH,
  },
  // Same reason as start-daemon.mjs: an MCP server process is long-lived, and
  // its cwd would otherwise be whatever directory DSH happened to spawn from.
  cwd: INSTALL_ROOT,
  stdio: 'inherit',
  windowsHide: true,
})

child.on('error', (error) => fail(`failed to spawn Open Design: ${error.message}`))
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  process.exit(code ?? 0)
})
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { try { child.kill(signal) } catch {} })
}
