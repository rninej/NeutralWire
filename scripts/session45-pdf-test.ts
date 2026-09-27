/**
 * session45-pdf-test.ts — unit-test the dependency-free PDF writer.
 * Generates a realistic story export (long summary, many sources with
 * unicode punctuation) and validates the output structure.
 * Run: npx tsx scripts/session45-pdf-test.ts
 */
import { buildPdf } from '../src/lib/pdf'
import { writeFileSync } from 'fs'

const doc = {
  title:
    "Chess Olympiad: Gukesh's brilliance helps India pip Germany — a very long headline that must wrap across multiple lines to prove the word-wrap works",
  metaLine: 'Coverage: 11 sources — 4 left / 4 centre / 3 right',
  summaryParagraphs: [
    'India edged past Germany in a tight sixth-round match at the Chess Olympiad, with D Gukesh producing the decisive victory on the top board. The 18-year-old grandmaster converted a grinding endgame advantage after nearly five hours of play, keeping India\u2019s gold-medal hopes alive \u2014 the team now sits alone at the top of the open section table.',
    'The women\u2019s team crushed Uzbekistan 3\u20113/4\u20130 in a dominant display. \u201cWe prepared specifically for their openings,\u201d said the captain, \u201cand the preparation paid off.\u201d Notable performances included a trademark pawn sacrifice on move 17\u2026 and a rook endgame technique the commentators called \u201cvintage\u201d.',
    'Section three verifies multiple paragraphs, page breaks and footer placement. '.repeat(40) +
      'Also unicode: caf\u00e9 na\u00efve r\u00e9sum\u00e9, emoji dropped \u2728, bullet \u2022, ellipsis \u2026, en dash \u2013, em dash \u2014, trademark \u2122, copyright \u00a9, euro \u20ac55, degree 30\u00b0.',
  ],
  sources: Array.from({ length: 14 }, (_, i) => ({
    title: `Source article number ${i + 1}: a reasonably long source headline about the Olympiad round ${i} that will wrap nicely`,
    detail: `Outlet ${i + 1} (news.example${i}.com) \u2014 ${i % 3 === 0 ? 'left' : i % 3 === 1 ? 'centre' : 'right'}-leaning`,
    url: `https://news.example${i}.com/article/olympiad-round-6-${i}`,
  })),
  closingNote: 'Compare the coverage live: https://neutralwire.org/?topic=chess-olympiad-test',
}

const buf = buildPdf(doc)
writeFileSync('/home/z/my-project/download/verify/s45-export-test.pdf', buf)

const s = buf.toString('latin1')
const checks: [string, boolean][] = [
  ['starts with %PDF-1.4', s.startsWith('%PDF-1.4')],
  ['ends with %%EOF', s.trimEnd().endsWith('%%EOF')],
  ['has xref', s.includes('\nxref\n')],
  ['has trailer', s.includes('trailer')],
  ['catalog present', s.includes('/Type /Catalog')],
  ['pages tree', s.includes('/Type /Pages')],
  ['page objects', (s.match(/\/Type \/Page[^s]/g) || []).length >= 1],
  ['WinAnsi encoding declared', s.includes('/WinAnsiEncoding')],
  ['bold font declared', s.includes('/Helvetica-Bold')],
  ['no raw unicode em-dash in streams', !/stream\n[^\n]*[\u2014]/.test(s)],
  ['page count matches /Count', (() => {
    const m = s.match(/\/Count (\d+)/)
    const pages = (s.match(/\/Type \/Page[^s]/g) || []).length
    return m ? Number(m[1]) === pages : false
  })()],
  ['xref offsets valid', (() => {
    const xrefIdx = s.indexOf('xref\n0 ')
    const total = Number(s.slice(xrefIdx + 6, s.indexOf('\n', xrefIdx + 6)))
    // entries[0] = free entry (object 0); entries[i] = object i
    const entries = s.slice(s.indexOf('\n', xrefIdx + 6) + 1).split('\n').slice(0, total)
    let ok = entries.length === total && /^0{10} 65535 f /.test(entries[0])
    for (let i = 1; i < total; i++) {
      const off = Number(entries[i].slice(0, 10))
      if (!(off >= 9 && off < buf.length)) { ok = false; break }
      const at = buf.toString('latin1', off, off + 24)
      if (!at.startsWith(`${i} 0 obj`)) { ok = false; break }
    }
    return ok
  })()],
  ['multi-page (wrap + 14 sources)', (s.match(/\/Type \/Page[^s]/g) || []).length >= 2],
]

let pass = 0
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (ok) pass++
}
console.log(`\n${pass}/${checks.length} checks passed — ${buf.length} bytes, ${(s.match(/\/Type \/Page[^s]/g) || []).length} pages`)
console.log('saved: download/verify/s45-export-test.pdf')
if (pass !== checks.length) process.exit(1)
