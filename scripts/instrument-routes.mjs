#!/usr/bin/env node
/**
 * instrument-routes.mjs — EMERGENCY usage-metering codemod (Nov 16, 2026).
 *
 * Wraps EVERY src/app/api route.ts file's HTTP-method export with
 * trackRequest('<routeKey>', …) from src/lib/usage-meter.ts:
 *
 *   export async function GET(req) { … }
 *     ──becomes──
 *   async function GET$(req) { … }          // declaration kept, renamed
 *   …
 *   export const GET = trackRequest('api/news', GET$)   // appended at EOF
 *
 * Appending the export at END OF FILE avoids brace matching entirely —
 * the rename is a single-line regex on the export line only.
 *
 * Idempotent: skips files already containing "trackRequest(".
 * Route key = file path minus src/app minus /route.ts (e.g. api/news,
 * api/topic/[id], api/cron/refresh-all).
 */

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOT_DIR = 'src/app/api'
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
const IMPORT_LINE = "import { trackRequest } from '@/lib/usage-meter'\n"

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (entry === 'route.ts') out.push(full)
  }
  return out
}

const files = walk(ROOT_DIR)
let touched = 0
let skipped = 0
const problems = []

for (const file of files) {
  let src = readFileSync(file, 'utf8')

  if (src.includes('trackRequest(')) {
    skipped++
    continue
  }

  // Route key: src/app/api/<rel>/route.ts → api/<rel> (posix separators)
  const rel = relative(ROOT_DIR, file).replace(/[/\\]route\.ts$/, '')
  const routeKey = 'api/' + rel.split(sep).join('/')

  // Find every `export async function GET(` / `export function POST(` line.
  const renamed = []
  for (const m of METHODS) {
    const re = new RegExp(`^export (async )?function ${m}\\s*\\(`, 'm')
    if (re.test(src)) {
      src = src.replace(re, `$1function ${m}$(`)
      renamed.push(m)
    }
  }

  if (renamed.length === 0) {
    problems.push(`${file}: no HTTP-method exports found — SKIPPED`)
    continue
  }

  // Prepend the import (top of file; comments above imports stay intact
  // because the import is inserted at index 0 which is legal TS).
  src = IMPORT_LINE + src

  // Append the wrapped exports at end of file.
  const exportsBlock = renamed
    .map(
      (m) =>
        `export const ${m} = trackRequest(\n  '${routeKey}',\n  ${m}$,\n)`,
    )
    .join('\n')

  if (!src.endsWith('\n')) src += '\n'
  src += `\n// ── usage-meter (Nov 16, 2026 emergency CPU attribution) ──\n${exportsBlock}\n`

  writeFileSync(file, src)
  touched++
  console.log(`instrumented ${routeKey}  [${renamed.join(',')}]`)
}

console.log(`\n${touched} files instrumented, ${skipped} already done, ${problems.length} problems`)
for (const p of problems) console.log('  ! ' + p)
if (problems.length > 0) process.exit(1)
