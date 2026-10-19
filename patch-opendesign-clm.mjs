#!/usr/bin/env node
// Fix OpenDesign's Windows launcher on machines where powershell.exe -Command
// runs in ConstrainedLanguage.
//
// THE BUG
//   @open-design/platform builds a PowerShell process-tree walk that uses
//   [System.Collections.Generic.List[object]]::new() and List[int]. Windows
//   rejects generic collection construction under ConstrainedLanguage:
//
//     Cannot invoke method. Method invocation is supported only on core types
//     in a constrained language mode.
//
//   That script runs inside retireExistingSidecar(), which is the first step of
//   spawnSidecarChild(). When it throws, spawnSidecarChild throws, the packaged
//   runtime reports "packaged runtime failed", and the app exits ~1s after
//   launch with no window. Nothing catches it; there is no fallback.
//
// WHY CONSTRAINEDLANGUAGE HERE
//   Verified on this machine, in every context tried (DSH sandboxed shell,
//   explorer-forwarded normal user token, Task Scheduler as the same user):
//     powershell.exe -Command ...  -> ConstrainedLanguage
//     powershell.exe -File ...     -> FullLanguage
//   So it is not a token or sandbox artifact of one caller: anything that
//   shells out with -Command gets CLM. OpenDesign uses -Command.
//
// THE FIX
//   Replace the four generic-collection constructions with plain arrays, which
//   are core types and therefore legal under CLM. Same algorithm, same output.
//   Verified: the rewritten script produces the same JSON under -Command.
//
// RUN AFTER EVERY OPENDESIGN UPDATE
//   The installer overwrites resources/app/node_modules/.../index.mjs, so this
//   patch must be re-applied after each upgrade. The script is idempotent and
//   exits 0 when the pattern is already gone.
//
//   node patch-opendesign-clm.mjs [--install-root D:\OpenDesign] [--dry-run]
import { copyFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const installRoot = argOf('--install-root', process.env.OD_INSTALL_ROOT ?? 'D:\\OpenDesign')
const dryRun = argv.includes('--dry-run')

const target = join(
  installRoot, 'resources', 'app', 'node_modules',
  '@open-design', 'platform', 'dist', 'index.mjs',
)

if (!existsSync(target)) {
  console.error(`[patch] not found: ${target}`)
  console.error('[patch] pass --install-root if OpenDesign lives elsewhere')
  process.exit(2)
}

const original = readFileSync(target, 'utf8')

// Each pair is exact text from the bundled module. If OpenDesign restructures
// the script the patterns stop matching — that is deliberate: a silent partial
// patch would be worse than refusing.
const replacements = [
  ['"$all = [System.Collections.Generic.List[object]]::new()",', '"$all = @()",'],
  ['"$frontier = [System.Collections.Generic.List[int]]::new()",', '"$frontier = @()",'],
  ['"  $frontier = [System.Collections.Generic.List[int]]::new()",', '"  $frontier = @()",'],
  [
    'if (-not $seen.ContainsKey($pidValue)) { $seen[$pidValue] = $true; $all.Add($process); $frontier.Add($pidValue) }',
    'if (-not $seen.ContainsKey($pidValue)) { $seen[$pidValue] = $true; $all += $process; $frontier += $pidValue }',
  ],
]

if (!original.includes('System.Collections.Generic.List')) {
  console.log('[patch] already applied — nothing to do')
  process.exit(0)
}

let patched = original
let total = 0
for (const [from, to] of replacements) {
  const count = patched.split(from).length - 1
  if (count === 0) {
    console.error(`[patch] pattern missing, refusing to half-patch:\n  ${from.slice(0, 90)}`)
    console.error('[patch] OpenDesign likely changed this code; re-derive the replacement.')
    process.exit(3)
  }
  patched = patched.split(from).join(to)
  total += count
  console.log(`[patch] replaced x${count}: ${from.slice(0, 62)}`)
}

if (dryRun) {
  console.log(`[patch] dry run — ${total} replacements would be written to ${target}`)
  process.exit(0)
}

const backup = `${target}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
copyFileSync(target, backup)
writeFileSync(target, patched, 'utf8')
console.log(`[patch] wrote ${total} replacements`)
console.log(`[patch] backup: ${backup}`)
console.log('[patch] restart OpenDesign for the fix to take effect')
