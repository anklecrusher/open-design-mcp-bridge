#!/usr/bin/env node
// Start the OpenDesign daemon on a fixed port, detached, so the MCP bridge can
// reach it. Idempotent: exits 0 immediately when something already answers.
//
// Usage:  node start-daemon.mjs [--port 7456] [--wait 45]
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const INSTALL_ROOT = process.env.OD_INSTALL_ROOT ?? 'D:\\OpenDesign'
const EXE = join(INSTALL_ROOT, 'Open Design.exe')
const DAEMON_CLI = join(INSTALL_ROOT, 'resources', 'app', 'prebundled', 'daemon', 'daemon-cli.mjs')
const RESOURCE_ROOT = join(INSTALL_ROOT, 'resources', 'open-design')
const CONFIG_PATH = join(INSTALL_ROOT, 'resources', 'open-design-config.json')

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const port = argOf('--port', '7456')
const waitSeconds = Number(argOf('--wait', '45'))

function log(m) { process.stdout.write(`[open-design-daemon] ${m}\n`) }

async function healthy() {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2000)
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: controller.signal })
    clearTimeout(timer)
    return res.ok
  } catch { return false }
}

if (await healthy()) { log(`already running on ${port}`); process.exit(0) }
if (!existsSync(EXE)) { log(`missing ${EXE} — set OD_INSTALL_ROOT`); process.exit(2) }
if (!existsSync(DAEMON_CLI)) { log(`missing ${DAEMON_CLI}`); process.exit(2) }

let namespace = 'release-stable-win'
try {
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  if (typeof cfg.namespace === 'string' && cfg.namespace) namespace = cfg.namespace
} catch (e) { log(`config unreadable: ${e.message}`); process.exit(2) }

const dataDir = join(process.env.APPDATA ?? '', 'Open Design', 'namespaces', namespace, 'data')

const child = spawn(EXE, [DAEMON_CLI, '--port', port, '--no-open'], {
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    OD_DATA_DIR: dataDir,
    OD_RESOURCE_ROOT: RESOURCE_ROOT,
    OD_INSTALLATION_DIR: RESOURCE_ROOT,
    OD_PACKAGED_NAMESPACE: namespace,
    OD_PACKAGED_CONFIG_PATH: CONFIG_PATH,
  },
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
})
child.unref()
log(`spawned daemon pid=${child.pid} on port ${port}`)

const deadline = Date.now() + waitSeconds * 1000
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1000))
  if (await healthy()) { log('ready'); process.exit(0) }
}
log('timed out waiting for /api/health — check the OD logs under %APPDATA%\\Open Design')
process.exit(1)
