/**
 * pdf.ts — a dependency-free PDF writer for the Ultra story export.
 *
 * WHY HAND-ROLLED: the only alternatives are pdfkit/jspdf, both of which
 * bundle font files / CJS quirks that break in Next.js standalone output
 * on Vercel (pdfkit reads .afm files from disk at runtime — not present
 * after tree-shaking). The export payload is pure text with known shapes
 * (title, coverage line, neutral summary, source list), which a classic
 * "content-stream writer" over the standard-14 Helvetica family renders
 * perfectly — no font embedding, no PDF/A compliance ceremony, zero deps.
 *
 * CAPABILITIES
 *   • US Letter (612×792pt) pages with 56pt side margins
 *   • Helvetica / Helvetica-Bold / Helvetica-Oblique (base-14, WinAnsi)
 *   • Real AFM width tables → accurate word-wrap at any size
 *   • Unicode → WinAnsi sanitisation (smart quotes, dashes, ellipsis,
 *     bullets, ©/®/™/€; diacritics folded to ASCII; the rest dropped)
 *   • Colored text + rules (the amber NeutralWire accent), page numbers,
 *     automatic page breaks, link-style URL lines.
 *
 * The output is a complete, valid PDF 1.4 byte string (Buffer).
 */

// ── Helvetica AFM glyph widths (per-mille, chars 32..126 + key WinAnsi) ──
const HELV_W: Record<number, number> = {
  32: 278, 33: 278, 34: 355, 35: 556, 36: 556, 37: 889, 38: 667, 39: 191,
  40: 333, 41: 333, 42: 389, 43: 584, 44: 278, 45: 333, 46: 278, 47: 278,
  48: 556, 49: 556, 50: 556, 51: 556, 52: 556, 53: 556, 54: 556, 55: 556,
  56: 556, 57: 556, 58: 278, 59: 278, 60: 584, 61: 584, 62: 584, 63: 556,
  64: 1015, 65: 667, 66: 667, 67: 722, 68: 722, 69: 667, 70: 611, 71: 778,
  72: 722, 73: 278, 74: 500, 75: 667, 76: 556, 77: 833, 78: 722, 79: 778,
  80: 667, 81: 778, 82: 722, 83: 667, 84: 611, 85: 722, 86: 667, 87: 944,
  88: 667, 89: 667, 90: 611, 91: 278, 92: 278, 93: 278, 94: 469, 95: 556,
  96: 333, 97: 556, 98: 556, 99: 500, 100: 556, 101: 556, 102: 278,
  103: 556, 104: 556, 105: 222, 106: 222, 107: 500, 108: 222, 109: 833,
  110: 556, 111: 556, 112: 556, 113: 556, 114: 333, 115: 500, 116: 278,
  117: 556, 118: 500, 119: 722, 120: 500, 121: 500, 122: 500, 123: 334,
  124: 260, 125: 334, 126: 584,
  // WinAnsi high characters
  0x80: 556, 0x85: 1000, 0x91: 222, 0x92: 278, 0x93: 333, 0x94: 333,
  0x95: 350, 0x96: 556, 0x97: 1000, 0x99: 737, 0xa9: 737, 0xae: 737,
}

const HELV_BOLD_W: Record<number, number> = {
  32: 278, 33: 333, 34: 474, 35: 556, 36: 556, 37: 889, 38: 722, 39: 238,
  40: 333, 41: 333, 42: 389, 43: 584, 44: 278, 45: 333, 46: 278, 47: 278,
  48: 556, 49: 556, 50: 556, 51: 556, 52: 556, 53: 556, 54: 556, 55: 556,
  56: 556, 57: 556, 58: 333, 59: 333, 60: 584, 61: 584, 62: 584, 63: 611,
  64: 975, 65: 722, 66: 722, 67: 722, 68: 722, 69: 667, 70: 611, 71: 778,
  72: 722, 73: 278, 74: 556, 75: 722, 76: 611, 77: 833, 78: 722, 79: 778,
  80: 667, 81: 778, 82: 722, 83: 667, 84: 611, 85: 722, 86: 667, 87: 944,
  88: 667, 89: 667, 90: 611, 91: 333, 92: 278, 93: 333, 94: 584, 95: 556,
  96: 333, 97: 556, 98: 611, 99: 556, 100: 611, 101: 556, 102: 333,
  103: 611, 104: 611, 105: 278, 106: 278, 107: 556, 108: 278, 109: 889,
  110: 611, 111: 611, 112: 611, 113: 611, 114: 389, 115: 556, 116: 333,
  117: 611, 118: 556, 119: 778, 120: 556, 121: 556, 122: 500, 123: 389,
  124: 280, 125: 389, 126: 584,
  // WinAnsi high characters
  0x80: 556, 0x85: 1000, 0x91: 238, 0x92: 333, 0x93: 500, 0x94: 500,
  0x95: 350, 0x96: 556, 0x97: 1000, 0x99: 1000, 0xa9: 737, 0xae: 737,
}

const HELV_OBLIQUE_W: Record<number, number> = HELV_W // same metrics as regular

// ── Unicode → WinAnsi sanitisation ───────────────────────────────────────

const UNICODE_MAP: Record<string, number> = {
  '\u2018': 0x91, '\u2019': 0x92, '\u201A': 0x82, '\u201B': 0x91,
  '\u201C': 0x93, '\u201D': 0x94, '\u201E': 0x84,
  '\u2013': 0x96, '\u2014': 0x97, '\u2026': 0x85, '\u2022': 0x95,
  '\u00A9': 0xa9, '\u00AE': 0xae, '\u2122': 0x99, '\u20AC': 0x80,
  '\u00A0': 0x20, '\u202F': 0x20, '\u2009': 0x20, '\u200B': 0x20,
  '\u02DA': 0xb0, '\u00B0': 0xb0,
}

/** Map a JS string to WinAnsi byte values (array of codes 0..255). */
function toWinAnsi(input: string): number[] {
  const out: number[] = []
  // Fold diacritics first (é → e) so anything latin-supplement survives.
  const folded = input.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  for (const ch of folded) {
    const code = ch.codePointAt(0) || 0x20
    if (code < 0x20) {
      if (code === 0x0a || code === 0x0d) out.push(0x20)
      continue
    }
    if (code < 0x7f) {
      out.push(code)
      continue
    }
    const mapped = UNICODE_MAP[ch]
    if (mapped !== undefined) {
      out.push(mapped)
      continue
    }
    if (code <= 0xff && code !== 0xad) {
      out.push(code) // latin-1 remainder passes through (WinAnsi covers most)
      continue
    }
    // characters Helvetica/WinAnsi cannot show: drop rather than tofu
  }
  return out
}

// ── Width measurement ────────────────────────────────────────────────────

type FontKey = 'regular' | 'bold' | 'oblique'

function widthsFor(font: FontKey): Record<number, number> {
  if (font === 'bold') return HELV_BOLD_W
  if (font === 'oblique') return HELV_OBLIQUE_W
  return HELV_W
}

/** Width of a sanitized string in points at the given size. */
function measure(codes: number[], font: FontKey, size: number): number {
  const table = widthsFor(font)
  let w = 0
  for (const c of codes) w += (table[c] ?? 500) / 1000
  return w * size
}

/** Greedy word-wrap of sanitized codes to a max width in points. */
function wrapCodes(codes: number[], font: FontKey, size: number, maxWidth: number): number[][] {
  const lines: number[][] = []
  let line: number[] = []
  let lineW = 0
  const spaceW = measure([0x20], font, size)
  let i = 0
  while (i < codes.length) {
    // take one word (up to space or end)
    let j = i
    while (j < codes.length && codes[j] !== 0x20) j++
    const word = codes.slice(i, j)
    const wordW = measure(word, font, size)
    const addW = line.length > 0 ? spaceW + wordW : wordW
    if (lineW + addW <= maxWidth || line.length === 0) {
      if (line.length > 0) {
        line.push(0x20)
        lineW += spaceW
      }
      line.push(...word)
      lineW += wordW
    } else {
      lines.push(line)
      line = [...word]
      lineW = wordW
    }
    if (j >= codes.length) break
    i = j + 1
  }
  if (line.length > 0) lines.push(line)
  return lines.length > 0 ? lines : [[]]
}

// ── PDF escaping ─────────────────────────────────────────────────────────

function pdfEscape(codes: number[]): string {
  let s = ''
  for (const c of codes) {
    if (c === 0x28 || c === 0x29 || c === 0x5c) s += '\\' + String.fromCharCode(c)
    else if (c >= 0x20 && c <= 0x7e) s += String.fromCharCode(c)
    else s += '\\' + c.toString(8).padStart(3, '0') // octal for >= 0x7f
  }
  return s
}

// ── Document model ───────────────────────────────────────────────────────

export interface PdfSource {
  title: string
  detail?: string // "BBC News · left-leaning"
  url?: string
}

export interface PdfDoc {
  title: string
  metaLine?: string // "8 sources — 3 left / 3 centre / 2 right"
  summaryParagraphs?: string[]
  sources?: PdfSource[]
  closingNote?: string
  footerLeft?: string
}

const PAGE_W = 612
const PAGE_H = 792
const MARGIN_X = 56
const MARGIN_TOP = 60
const MARGIN_BOTTOM = 70
const CONTENT_W = PAGE_W - 2 * MARGIN_X

// NeutralWire accent colors (0..1 floats)
const AMBER: [number, number, number] = [0.93, 0.62, 0.08]
const INK: [number, number, number] = [0.12, 0.12, 0.13]
const BODY: [number, number, number] = [0.22, 0.22, 0.24]
const MUTED: [number, number, number] = [0.45, 0.45, 0.48]
const LINK: [number, number, number] = [0.13, 0.35, 0.70]

/** Build the full PDF and return it as a Buffer. */
export function buildPdf(doc: PdfDoc): Buffer {
  // content is accumulated per page as raw content-stream fragments
  const pages: string[] = []
  let ops: string[] = [] // current page's content stream pieces
  let y = PAGE_H - MARGIN_TOP

  const startPage = () => {
    if (ops.length > 0) pages.push(ops.join('\n'))
    ops = []
    y = PAGE_H - MARGIN_TOP
  }

  /** Emit one wrapped paragraph; returns when done. */
  const writeLines = (
    codes: number[][],
    font: FontKey,
    size: number,
    leading: number,
    color: [number, number, number],
    x = MARGIN_X,
    indentAfterFirst = 0,
  ) => {
    for (let li = 0; li < codes.length; li++) {
      if (y - size < MARGIN_BOTTOM) startPage()
      const xOff = li === 0 ? x : x + indentAfterFirst
      ops.push(
        `BT /${font === 'bold' ? 'F2' : font === 'oblique' ? 'F3' : 'F1'} ${size} Tf ${rgb(color)} ${xOff.toFixed(2)} ${(y - size).toFixed(2)} Td (${pdfEscape(codes[li])}) Tj ET`,
      )
      y -= leading
    }
  }

  const para = (
    text: string,
    font: FontKey,
    size: number,
    leading: number,
    color: [number, number, number],
    x = MARGIN_X,
    gapAfter = 0,
  ) => {
    const codes = toWinAnsi(text)
    const wrapped = wrapCodes(codes, font, size, CONTENT_W - (x - MARGIN_X))
    writeLines(wrapped, font, size, leading, color, x)
    y -= gapAfter
  }

  const rule = (color: [number, number, number], height = 2.2, gapAfter = 12) => {
    if (y - height < MARGIN_BOTTOM) startPage()
    ops.push(
      `${rgb(color)} ${MARGIN_X.toFixed(2)} ${(y - height).toFixed(2)} ${CONTENT_W.toFixed(2)} ${height.toFixed(2)} re f`,
    )
    y -= height + gapAfter
  }

  const spacer = (h: number) => {
    y -= h
  }

  const rgb = (c: [number, number, number]) =>
    `${c[0].toFixed(3)} ${c[1].toFixed(3)} ${c[2].toFixed(3)} rg`

  // ── Layout ──
  // Title
  para(doc.title, 'bold', 19, 24, INK, MARGIN_X, 8)
  if (doc.metaLine) {
    para(doc.metaLine, 'regular', 10, 14, MUTED, MARGIN_X, 10)
  }
  rule(AMBER, 2.4, 14)

  // Neutral summary
  if (doc.summaryParagraphs && doc.summaryParagraphs.length > 0) {
    para('Neutral summary', 'bold', 13, 17, INK, MARGIN_X, 8)
    for (const p of doc.summaryParagraphs) {
      para(p, 'regular', 10.5, 15.5, BODY, MARGIN_X, 7)
    }
    spacer(6)
  }

  // Sources
  if (doc.sources && doc.sources.length > 0) {
    if (y - 60 < MARGIN_BOTTOM) startPage()
    para('Sources across the spectrum', 'bold', 13, 17, INK, MARGIN_X, 10)
    for (const s of doc.sources) {
      if (y - 44 < MARGIN_BOTTOM) startPage()
      // bullet + source title
      const bulletX = MARGIN_X + 2
      const textX = MARGIN_X + 16
      const titleCodes = toWinAnsi(s.title)
      const titleLines = wrapCodes(titleCodes, 'regular', 10.5, CONTENT_W - 16)
      // bullet dot at the first line's height
      ops.push(
        `${rgb(AMBER)} BT /F1 12 Tf ${bulletX.toFixed(2)} ${(y - 10.5).toFixed(2)} Td (${pdfEscape([0x95])}) Tj ET`,
      )
      writeLines(titleLines, 'regular', 10.5, 14, BODY, textX)
      if (s.detail) {
        para(s.detail, 'oblique', 9, 12, MUTED, textX, 2)
      }
      if (s.url) {
        para(s.url, 'regular', 8.5, 11.5, LINK, textX, 4)
      }
      spacer(4)
    }
  }

  // Closing note
  if (doc.closingNote) {
    spacer(4)
    if (y - 30 < MARGIN_BOTTOM) startPage()
    rule(AMBER, 1.4, 10)
    para(doc.closingNote, 'regular', 9.5, 13.5, MUTED, MARGIN_X, 0)
  }

  if (ops.length > 0) pages.push(ops.join('\n'))

  // ── Footers (added after pagination is known) ──
  const withFooters = pages.map((body, i) => {
    const footer = [
      `0.62 0.62 0.64 rg BT /F1 8 Tf ${MARGIN_X.toFixed(2)} 36 Td (${pdfEscape(toWinAnsi(doc.footerLeft || 'Exported from NeutralWire — neutralwire.org'))}) Tj ET`,
      `BT /F1 8 Tf ${(PAGE_W - MARGIN_X - 40).toFixed(2)} 36 Td (${pdfEscape(toWinAnsi(`Page ${i + 1} of ${pages.length}`))}) Tj ET`,
    ].join('\n')
    return `${body}\n${footer}`
  })

  // ── Assemble the PDF objects ──
  // Object numbering:
  //  1 catalog, 2 pages tree, 3 F1 Helvetica, 4 F2 Helvetica-Bold,
  //  5 F3 Helvetica-Oblique, then per page: page obj + content stream obj
  const objects: string[] = []
  const pageCount = withFooters.length
  const pageObjIds: number[] = []
  for (let p = 0; p < pageCount; p++) {
    pageObjIds.push(6 + p * 2)
  }
  const kids = pageObjIds.map((id) => `${id} 0 R`).join(' ')

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`
  objects[3] =
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
  objects[4] =
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'
  objects[5] =
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>'

  withFooters.forEach((content, i) => {
    const pageId = pageObjIds[i]
    const contentId = pageId + 1
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${contentId} 0 R >>`
    const streamLen = Buffer.byteLength(content, 'latin1')
    objects[contentId] =
      `<< /Length ${streamLen} >>\nstream\n${content}\nendstream`
  })

  // ── Serialise with a correct xref table ──
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'
  const offsets: number[] = []
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = Buffer.byteLength(out, 'latin1')
    out += `${i} 0 obj\n${objects[i]}\nendobj\n`
  }
  const xrefStart = Buffer.byteLength(out, 'latin1')
  const total = objects.length // objects[0] is a hole; count = length
  out += `xref\n0 ${total}\n`
  out += '0000000000 65535 f \n'
  for (let i = 1; i < total; i++) {
    out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  out += `trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`

  return Buffer.from(out, 'latin1')
}
