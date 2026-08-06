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

// Solid block-style digit paths using only rectangles and simple shapes.
// NO bezier curves — they render poorly in sharp's SVG renderer (librsvg)
// and cause "halo" / "glitchy" artifacts. These use only straight lines
// and right angles, which always render cleanly.
export const CHAR_PATHS: Record<string, string> = {
  '0': 'M20 10 L80 10 L80 130 L20 130 Z M35 25 L65 25 L65 115 L35 115 Z',
  '1': 'M35 10 L65 10 L65 130 L45 130 L45 30 L35 35 Z',
  '2': 'M20 10 L80 10 L80 35 L45 75 L45 95 L80 95 L80 130 L20 130 L20 105 L55 65 L55 35 L20 35 Z',
  '3': 'M20 10 L80 10 L80 35 L45 35 L45 55 L80 55 L80 80 L45 80 L45 105 L80 105 L80 130 L20 130 Z M45 35 L45 55 L80 55 L80 35 Z M45 80 L45 105 L80 105 L80 80 Z',
  '4': 'M15 85 L50 10 L70 10 L70 85 L85 85 L85 105 L70 105 L70 130 L50 130 L50 105 L15 105 Z M50 35 L50 85 L60 85 L60 35 Z',
  '5': 'M20 10 L80 10 L80 35 L45 35 L45 55 L65 55 L65 80 L45 80 L45 105 L80 105 L80 130 L20 130 Z',
  '6': 'M20 10 L65 10 L65 35 L45 35 L45 55 L65 55 L65 80 L45 80 L45 105 L65 105 L65 130 L20 130 Z',
  '7': 'M20 10 L80 10 L80 35 L55 130 L35 130 L55 35 L20 35 Z',
  '8': 'M20 10 L80 10 L80 35 L45 35 L45 55 L80 55 L80 80 L45 80 L45 105 L80 105 L80 130 L20 130 Z M45 35 L45 55 L80 55 L80 35 Z M45 80 L45 105 L80 105 L80 80 Z',
  '9': 'M20 10 L65 10 L65 35 L45 35 L45 55 L65 55 L65 80 L45 80 L45 105 L20 105 L20 80 L35 80 L35 55 L20 55 Z M65 35 L65 130 L45 130 L45 35 Z',

  // ── Uppercase block letters ──
  // Each is a clean, bold sans-serif style letter on a 100x140 grid.
  'N': 'M15 10 L35 10 L65 95 L65 10 L85 10 L85 130 L65 130 L35 45 L35 130 L15 130 Z',
  'E': 'M15 10 L85 10 L85 30 L35 30 L35 60 L75 60 L75 80 L35 80 L35 110 L85 110 L85 130 L15 130 Z',
  'U': 'M15 10 L35 10 L35 85 C35 100 40 110 50 110 C60 110 65 100 65 85 L65 10 L85 10 L85 85 C85 115 70 130 50 130 C30 130 15 115 15 85 Z',
  'T': 'M10 10 L90 10 L90 30 L60 30 L60 130 L40 130 L40 30 L10 30 Z',
  'R': 'M15 10 L55 10 C75 10 85 25 85 45 C85 60 75 70 60 72 L85 130 L62 130 L40 75 L35 75 L35 130 L15 130 Z M35 30 L35 55 L50 55 C60 55 65 50 65 42 C65 34 60 30 50 30 Z',
  'A': 'M10 130 L30 10 L55 10 L85 130 L62 130 L55 105 L30 105 L22 130 Z M35 85 L50 85 L42 50 Z',
  'L': 'M15 10 L35 10 L35 110 L75 110 L75 130 L15 130 Z',
  'W': 'M5 10 L25 10 L38 85 L48 40 L58 85 L70 10 L90 10 L75 130 L60 130 L50 85 L40 130 L25 130 Z',
  'I': 'M15 10 L85 10 L85 30 L60 30 L60 110 L85 110 L85 130 L15 130 L15 110 L40 110 L40 30 L15 30 Z',
  '%': 'M15 10 L85 130 L70 130 L10 10 Z M25 10 C15 10 10 25 10 40 C10 55 15 70 25 70 C35 70 40 55 40 40 C40 25 35 10 25 10 Z M75 70 C65 70 60 85 60 100 C60 115 65 130 75 130 C85 130 90 115 90 100 C90 85 85 70 75 70 Z',
}

/**
 * Generate SVG path elements for a string of characters.
 * Each character is placed centered at the given position with the given height.
 *
 * @param text The text to render (e.g. "NW", "3", "NEUTRALWIRE")
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
  const scale = height / 140
  const charWidth = 100 * scale * 0.6 // 60% of grid width
  const totalWidth = text.length * charWidth
  const startX = centerX - totalWidth / 2

  let svg = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const path = CHAR_PATHS[ch.toUpperCase()] // Auto-uppercase
    if (!path) continue
    const charX = startX + i * charWidth
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
