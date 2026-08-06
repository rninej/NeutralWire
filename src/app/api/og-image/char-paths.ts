/**
 * SVG path data for rendering text WITHOUT any font dependency.
 *
 * All characters are drawn as filled SVG vector paths — no <text>
 * elements, no fonts. Guaranteed to render in sharp's SVG renderer.
 *
 * Uses UPPERCASE block letters only — they're simpler to draw as clean
 * vector paths and more readable at small sizes than lowercase.
 *
 * Each character is drawn on a 100x140 grid, then scaled.
 */

// 7-segment display style digits (like a digital clock).
// Each digit is drawn as filled segment rectangles — no gaps within
// a digit, only between digits.
export const CHAR_PATHS: Record<string, string> = {
  '0': 'M20 10 L80 10 L80 25 L20 25 Z M65 25 L80 25 L80 115 L65 115 Z M20 115 L80 115 L80 130 L20 130 Z M20 25 L35 25 L35 115 L20 115 Z',
  '1': 'M65 25 L80 25 L80 115 L65 115 Z',
  '2': 'M20 10 L80 10 L80 25 L20 25 Z M65 25 L80 25 L80 67 L65 67 Z M20 67 L80 67 L80 82 L20 82 Z M20 82 L35 82 L35 115 L20 115 Z M20 115 L80 115 L80 130 L20 130 Z',
  '3': 'M20 10 L80 10 L80 25 L20 25 Z M65 25 L80 25 L80 67 L65 67 Z M20 67 L80 67 L80 82 L20 82 Z M65 82 L80 82 L80 115 L65 115 Z M20 115 L80 115 L80 130 L20 130 Z',
  '4': 'M20 25 L35 25 L35 67 L20 67 Z M20 67 L80 67 L80 82 L20 82 Z M65 25 L80 25 L80 115 L65 115 Z',
  '5': 'M20 10 L80 10 L80 25 L20 25 Z M20 25 L35 25 L35 67 L20 67 Z M20 67 L80 67 L80 82 L20 82 Z M65 82 L80 82 L80 115 L65 115 Z M20 115 L80 115 L80 130 L20 130 Z',
  '6': 'M20 10 L80 10 L80 25 L20 25 Z M20 25 L35 25 L35 67 L20 67 Z M20 67 L80 67 L80 82 L20 82 Z M20 82 L35 82 L35 115 L20 115 Z M20 115 L80 115 L80 130 L20 130 Z M65 82 L80 82 L80 115 L65 115 Z',
  '7': 'M20 10 L80 10 L80 25 L20 25 Z M65 25 L80 25 L80 130 L65 130 Z',
  '8': 'M20 10 L80 10 L80 25 L20 25 Z M20 25 L35 25 L35 67 L20 67 Z M65 25 L80 25 L80 67 L65 67 Z M20 67 L80 67 L80 82 L20 82 Z M20 82 L35 82 L35 115 L20 115 Z M65 82 L80 82 L80 115 L65 115 Z M20 115 L80 115 L80 130 L20 130 Z',
  '9': 'M20 10 L80 10 L80 25 L20 25 Z M20 25 L35 25 L35 67 L20 67 Z M65 25 L80 25 L80 67 L65 67 Z M20 67 L80 67 L80 82 L20 82 Z M65 82 L80 82 L80 115 L65 115 Z M20 115 L80 115 L80 130 L20 130 Z',
  '%': 'M15 5 L35 5 L85 135 L65 135 Z M10 10 L50 10 L50 50 L10 50 Z M50 90 L90 90 L90 130 L50 130 Z',

  // ── Uppercase block letters ──
  'N': 'M15 10 L35 10 L65 95 L65 10 L85 10 L85 130 L65 130 L35 45 L35 130 L15 130 Z',
  'E': 'M15 10 L85 10 L85 30 L35 30 L35 60 L75 60 L75 80 L35 80 L35 110 L85 110 L85 130 L15 130 Z',
  'U': 'M15 10 L35 10 L35 85 C35 100 40 110 50 110 C60 110 65 100 65 85 L65 10 L85 10 L85 85 C85 115 70 130 50 130 C30 130 15 115 15 85 Z',
  'T': 'M10 10 L90 10 L90 30 L60 30 L60 130 L40 130 L40 30 L10 30 Z',
  'R': 'M15 10 L55 10 C75 10 85 25 85 45 C85 60 75 70 60 72 L85 130 L62 130 L40 75 L35 75 L35 130 L15 130 Z M35 30 L35 55 L50 55 C60 55 65 50 65 42 C65 34 60 30 50 30 Z',
  'A': 'M10 130 L30 10 L55 10 L85 130 L62 130 L55 105 L30 105 L22 130 Z M35 85 L50 85 L42 50 Z',
  'L': 'M15 10 L35 10 L35 110 L75 110 L75 130 L15 130 Z',
  'W': 'M5 10 L25 10 L38 85 L48 40 L58 85 L70 10 L90 10 L75 130 L60 130 L50 85 L40 130 L25 130 Z',
  'I': 'M15 10 L85 10 L85 30 L60 30 L60 110 L85 110 L85 130 L15 130 L15 110 L40 110 L40 30 L15 30 Z',
}

/**
 * Generate SVG path elements for a string of characters.
 * Each character is placed centered at the given position with the given height.
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
  const scale = height / 140
  // Each character gets a slot of 120*scale pixels. The digit itself
  // only uses 60px of the 100px grid (x=20 to x=80), so with a 120px
  // slot there's a 60px gap between digits — plenty of separation.
  const charSlot = 120 * scale
  const totalWidth = text.length * charSlot
  const startX = centerX - totalWidth / 2

  let svg = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const path = CHAR_PATHS[ch.toUpperCase()]
    if (!path) continue
    const charX = startX + i * charSlot
    svg += `<g transform="translate(${charX},${topY}) scale(${scale})"><path d="${path}" fill="${fill}"/></g>`
  }
  return svg
}

/**
 * Like renderTextAsPaths but with adjustable letter spacing.
 * Each character is separated by `spacing` pixels.
 */
export function renderTextAsPathsSpaced(
  text: string,
  centerX: number,
  topY: number,
  height: number,
  fill: string,
  spacing: number,
): string {
  const scale = height / 140
  const charWidth = 100 * scale * 0.6
  const totalWidth = text.length * charWidth + (text.length - 1) * spacing
  const startX = centerX - totalWidth / 2

  let svg = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const path = CHAR_PATHS[ch.toUpperCase()]
    if (!path) continue
    const charX = startX + i * (charWidth + spacing)
    svg += `<g transform="translate(${charX},${topY}) scale(${scale})"><path d="${path}" fill="${fill}"/></g>`
  }
  return svg
}
