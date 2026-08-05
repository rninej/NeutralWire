/**
 * SVG path data for rendering text WITHOUT any font dependency.
 *
 * Uses a 7-segment display style for digits (like a digital clock) and
 * bold block letters for "NW". Each character is drawn as filled SVG
 * paths — no <text> elements, no fonts needed. Guaranteed to render
 * in sharp's SVG renderer (librsvg) which has no system fonts.
 *
 * Characters are drawn on a 100x140 grid, then scaled.
 */

// 7-segment layout (100x140 grid):
//
//   ##a##       (y=10, h=15)
//  f     b      (y=25, h=42)
//  f     b
//   ##g##       (y=67, h=15)
//  e     c      (y=82, h=42)
//  e     c
//   ##d##       (y=124, h=15)
//
// Segment rectangles:
const SEG = {
  a: 'M20 10 L80 10 L80 25 L20 25 Z',        // top horizontal
  b: 'M65 25 L80 25 L80 67 L65 67 Z',        // top-right vertical
  c: 'M65 82 L80 82 L80 124 L65 124 Z',      // bottom-right vertical
  d: 'M20 124 L80 124 L80 139 L20 139 Z',    // bottom horizontal
  e: 'M20 82 L35 82 L35 124 L20 124 Z',      // bottom-left vertical
  f: 'M20 25 L35 25 L35 67 L20 67 Z',        // top-left vertical
  g: 'M20 67 L80 67 L80 82 L20 82 Z',        // middle horizontal
}

// Which segments are ON for each digit (7-segment display)
const DIGIT_SEGS: Record<string, string[]> = {
  '0': ['a','b','c','d','e','f'],
  '1': ['b','c'],
  '2': ['a','b','g','e','d'],
  '3': ['a','b','g','c','d'],
  '4': ['f','g','b','c'],
  '5': ['a','f','g','c','d'],
  '6': ['a','f','g','e','c','d'],
  '7': ['a','b','c'],
  '8': ['a','b','c','d','e','f','g'],
  '9': ['a','b','c','d','f','g'],
}

// Build the path for a digit by combining its segments
function buildDigitPath(digit: string): string {
  const segs = DIGIT_SEGS[digit]
  if (!segs) return ''
  return segs.map((s) => SEG[s as keyof typeof SEG]).join(' ')
}

// Pre-built digit paths
export const CHAR_PATHS: Record<string, string> = {}
for (const d of Object.keys(DIGIT_SEGS)) {
  CHAR_PATHS[d] = buildDigitPath(d)
}

// Block-style letters for "NW" (not 7-segment — these are solid block letters)
// Drawn on the same 100x140 grid
CHAR_PATHS['N'] = 'M15 10 L35 10 L65 95 L65 10 L85 10 L85 130 L65 130 L35 45 L35 130 L15 130 Z'
CHAR_PATHS['W'] = 'M10 10 L30 10 L42 85 L50 45 L58 85 L70 10 L90 10 L75 130 L60 130 L50 90 L40 130 L25 130 Z'

/**
 * Generate SVG path elements for a string of characters.
 * Each character is placed centered at the given position with the given height.
 *
 * @param text The text to render (e.g. "NW", "3", "14")
 * @param centerX The x position of the center of the text
 * @param topY The y position of the top of the text
 * @param height The height of each character in pixels
 * @param fill The fill color (e.g. "#fff", "#0a0a0a")
 */
export function renderTextAsPaths(
  text: string,
  centerX: number,
  topY: number,
  height: number,
  fill: string,
): string {
  const scale = height / 140 // Scale from 140px grid to desired height
  const charWidth = 100 * scale * 0.6 // Characters take ~60% of the 100px width
  const totalWidth = text.length * charWidth
  const startX = centerX - totalWidth / 2

  let svg = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const path = CHAR_PATHS[ch]
    if (!path) continue
    const charX = startX + i * charWidth
    svg += `<g transform="translate(${charX},${topY}) scale(${scale})"><path d="${path}" fill="${fill}"/></g>`
  }
  return svg
}
