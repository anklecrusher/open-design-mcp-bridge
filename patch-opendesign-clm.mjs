#!/usr/bin/env node
// Fix OpenDesign's Windows launcher on machines where powershell.exe -Command
// runs in ConstrainedLanguage.
//
// THE BUG
//   @open-design/platform walks the process tree with a PowerShell script that
//   constructs [System.Collections.Generic.List[object]]::new(). Windows rejects
//   generic collection construction under ConstrainedLanguage:
//
//     Cannot invoke method. Method invocation is supported only on core types
//     in a constrained language mode.
//
//   That script runs inside retireExistingSidecar(), the first step of
//   spawnSidecarChild(). It throws, the packaged runtime reports
//   "packaged runtime failed", and the app exits ~1s after launch with no
//   window. Nothing catches it and no dialog appears.
//
// WHY CONSTRAINEDLANGUAGE HERE
//   Verified in three contexts (DSH's sandboxed shell, an explorer-forwarded
//   normal user token, Task Scheduler as the same user): `-Command` is always
//   ConstrainedLanguage, `-File` is always FullLanguage. Not a caller artifact.
//
// THE FIX
//   Replace the four generic-collection constructions with plain arrays, which
//   are core types and legal under CLM. Same algorithm, same JSON output.
//
// WHERE THE FILES LIVE — this is the part that matters
//   OpenDesign 0.26+ installs itself through a launcher and auto-updates into a
//   per-version directory:
//
//     %APPDATA%\Open Design\launcher\channels\stable\namespaces\<ns>\versions\<v>\payload
//
//   Double-clicking D:\OpenDesign\Open Design.exe does NOT necessarily run that
//   copy: the launcher hands off to the newest staged payload. So the patch has
//   to be applied to EVERY payload on the machine, not just the installer target.
//   A patch on an older copy looks applied while the app keeps crashing, which
//   is exactly how this bug came back after an auto-update.
//
//   The script therefore scans both roots by default:
//     - %APPDATA%\Open Design\launcher\...\versions\*\payload
//     - the install root (default D:\OpenDesign)
//
// RUN AFTER EVERY OPENDESIGN UPDATE (or after any auto-update)
//   node patch-opendesign-clm.mjs            # patch every payload found
//   node patch-opendesign-clm.mjs --dry-run  # report only
//   node patch-opendesign-clm.mjs --install-root D:\OpenDesign --no-launcher
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const argOf = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

const installRoot = argOf('--install-root', process.env.OD_INSTALL_ROOT ?? 'D:\\OpenDesign')
const dryRun = flag('--dry-run')
const includeLauncher = !flag('--no-launcher')
const includeInstallRoot = !flag('--no-install-root')

const MODULE_REL = join('resources', 'app', 'node_modules', '@open-design', 'platform', 'dist', 'index.mjs')

const replacements = [
  ['"$all = [System.Collections.Generic.List[object]]::new()",', '"$all = @()",'],
  ['"$frontier = [System.Collections.Generic.List[int]]::new()",', '"$frontier = @()",'],
  ['"  $frontier = [System.Collections.Generic.List[int]]::new()",', '"  $frontier = @()",'],
  [
    'if (-not $seen.ContainsKey($pidValue)) { $seen[$pidValue] = $true; $all.Add($process); $frontier.Add($pidValue) }',
    'if (-not $seen.ContainsKey($pidValue)) { $seen[$pidValue] = $true; $all += $process; $frontier += $pidValue }',
  ],
]

function launcherPayloads() {
  const appData = process.env.APPDATA
  if (!appData) return []
  const channelsRoot = join(appData, 'Open Design', 'launcher', 'channels')
  if (!existsSync(channelsRoot)) return []
  const found = []
  for (const channel of safeDirs(channelsRoot)) {
    const nsRoot = join(channelsRoot, channel, 'namespaces')
    for (const ns of safeDirs(nsRoot)) {
      const versionsRoot = join(nsRoot, ns, 'versions')
      for (const version of safeDirs(versionsRoot)) {
        const payload = join(versionsRoot, version, 'payload')
        if (existsSync(join(payload, 'Open Design.exe'))) found.push({ label: `launcher ${channel}/${version}`, root: payload })
      }
    }
  }
  return found
}

function safeDirs(dir) {
  try { return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) }
  catch { return [] }
}

function patchOne({ label, root }) {
  const target = join(root, MODULE_REL)
  if (!existsSync(target)) {
    console.log(`[skip] ${label}: module not found`)
    return { label, status: 'missing' }
  }
  const original = readFileSync(target, 'utf8')
  if (!original.includes('System.Collections.Generic.List')) {
    console.log(`[ok]   ${label}: already patched`)
    return { label, status: 'already' }
  }
  let patched = original
  let total = 0
  for (const [from, to] of replacements) {
    const count = patched.split(from).length - 1
    if (count === 0) {
      console.error(`[fail] ${label}: pattern missing — OpenDesign changed this code`)
      console.error(`       expected: ${from.slice(0, 80)}`)
      return { label, status: 'pattern-missing' }
    }
    patched = patched.split(from).join(to)
    total += count
  }
  if (dryRun) {
    console.log(`[dry]  ${label}: would apply ${total} replacements`)
    return { label, status: 'dry' }
  }
  const backup = `${target}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
  copyFileSync(target, backup)
  writeFileSync(target, patched, 'utf8')
  console.log(`[fix]  ${label}: ${total} replacements (backup ${backup.split('\\').pop()})`)
  return { label, status: 'patched' }
}

const targets = []
if (includeLauncher) targets.push(...launcherPayloads())
if (includeInstallRoot && existsSync(join(installRoot, 'Open Design.exe'))) {
  targets.push({ label: `install ${installRoot}`, root: installRoot })
}

if (targets.length === 0) {
  console.error('[patch] no OpenDesign payload found')
  console.error('[patch] looked in the launcher versions dir and', installRoot)
  process.exit(2)
}

console.log(`[patch] ${targets.length} payload(s) found`)
const results = targets.map(patchOne)

const bad = results.filter((r) => r.status === 'pattern-missing')
const patched = results.filter((r) => r.status === 'patched').length
if (bad.length > 0) {
  console.error(`\n[patch] ${bad.length} payload(s) need manual attention`)
  process.exit(3)
}
if (patched > 0 && !dryRun) console.log('\n[patch] restart OpenDesign for the fix to take effect')
else if (patched === 0) console.log('\n[patch] nothing to do')
