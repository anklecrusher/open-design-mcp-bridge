#!/usr/bin/env node
// Smoke test: start the bridge as DSH would, assert the MCP surface works.
// Exit 0 = pass. Usage: node verify.mjs
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const child = spawn(process.execPath, [join(here, 'mcp-bridge.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] })
let buf = ''
let stderr = ''
const pending = new Map()
let nextId = 1
let failed = false

child.stderr.on('data', (d) => { stderr += d })
const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`)
const req = (method, params, ms = 90000) => new Promise((resolve) => {
  const id = nextId++
  pending.set(id, resolve)
  send({ jsonrpc: '2.0', id, method, params })
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ timeout: true }) } }, ms)
})

child.stdout.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    try {
      const msg = JSON.parse(line)
      if (msg.id !== undefined && pending.has(msg.id)) {
        const r = pending.get(msg.id); pending.delete(msg.id); r(msg)
      }
    } catch { /* non-JSON on stdout is a protocol violation, surfaced below */ }
  }
})

function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed = true
}

const init = await req('initialize', {
  protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify', version: '1' },
})
check('initialize returns a result', Boolean(init.result), init.result?.serverInfo?.name)
if (!init.result) { console.error('stderr:', stderr.slice(0, 800)); child.kill(); process.exit(1) }
send({ jsonrpc: '2.0', method: 'notifications/initialized' })

const tools = await req('tools/list', {})
const names = (tools.result?.tools ?? []).map((t) => t.name)
check('tools/list exposes 22 tools', names.length === 22, String(names.length))
check('generation surface present', ['start_run', 'get_run', 'cancel_run'].every((n) => names.includes(n)))

const skills = await req('tools/call', { name: 'list_skills', arguments: {} }, 120000)
let skillCount = -1
try { skillCount = JSON.parse(skills.result?.content?.[0]?.text ?? '{}').skills?.length ?? -1 } catch {}
check('list_skills returns the bundled catalogue', skillCount === 169, String(skillCount))

const projects = await req('tools/call', { name: 'list_projects', arguments: {} })
let projOk = false
try { projOk = Array.isArray(JSON.parse(projects.result?.content?.[0]?.text ?? '{}').projects) } catch {}
check('list_projects returns an array', projOk)

child.kill()
console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS')
process.exit(failed ? 1 : 0)
