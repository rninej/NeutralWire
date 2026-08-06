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

// Solid block-style digit paths (filled shapes)
export const CHAR_PATHS: Record<string, string> = {
  '0': 'M50 10 C25 10 15 35 15 70 C15 105 25 130 50 130 C75 130 85 105 85 70 C85 35 75 10 50 10 Z M50 30 C65 30 70 50 70 70 C70 90 65 110 50 110 C35 110 30 90 30 70 C30 50 35 30 50 30 Z',
  '1': 'M25 25 L55 10 L70 10 L70 130 L50 130 L50 35 L40 40 L25 35 Z',
  '2': 'M15 30 C15 15 35 10 50 10 C65 10 85 15 85 35 C85 55 65 65 50 80 L35 95 L35 110 L85 110 L85 130 L15 130 L15 105 C15 90 35 80 50 65 C60 55 65 45 65 35 C65 25 58 30 50 30 C42 30 35 35 35 45 L15 45 Z',
  '3': 'M15 20 C25 12 40 10 50 10 C65 10 85 15 85 35 C85 50 75 58 65 60 C78 62 85 72 85 88 C85 115 65 130 50 130 C35 130 22 125 15 115 L25 100 C30 108 40 110 50 110 C58 110 65 102 65 88 C65 75 58 70 50 70 L40 70 L40 50 L50 50 C58 50 65 45 65 35 C65 28 58 30 50 30 C42 30 35 32 30 38 Z',
  '4': 'M10 90 L45 10 L65 10 L65 90 L80 90 L80 110 L65 110 L65 130 L45 130 L45 110 L10 110 Z M45 50 L45 90 L55 90 Z M45 50 L55 50 L55 90 L45 90 Z',
  '5': 'M20 10 L80 10 L80 30 L40 30 L40 55 L60 53 C75 53 85 65 85 85 C85 115 65 130 50 130 C35 130 22 122 15 110 L28 95 C33 103 40 110 50 110 C60 110 65 100 65 85 C65 72 58 70 50 70 L40 72 L40 10 Z',
  '6': 'M80 20 C70 12 55 10 45 10 C25 10 15 30 15 70 C15 110 25 130 50 130 C70 130 85 115 85 90 C85 70 70 60 55 65 L45 70 C40 72 35 75 35 85 C35 95 40 110 50 110 C60 110 65 100 65 90 C65 80 58 75 50 78 L40 82 C35 50 35 30 45 30 C50 30 55 32 58 38 Z',
  '7': 'M15 10 L85 10 L85 30 L55 130 L35 130 L60 30 L15 30 Z',
  '8': 'M50 10 C35 10 20 20 20 35 C20 48 30 55 40 60 C25 65 15 75 15 90 C15 115 30 130 50 130 C70 130 85 115 85 90 C85 75 75 65 60 60 C70 55 80 48 80 35 C80 20 65 10 50 10 Z M50 30 C57 30 62 35 62 42 C62 49 57 54 50 54 C43 54 38 49 38 42 C38 35 43 30 50 30 Z M50 72 C60 72 67 80 67 92 C67 104 60 112 50 112 C40 112 33 104 33 92 C33 80 40 72 50 72 Z',
  '9': 'M20 120 C30 128 45 130 55 130 C75 130 85 110 85 70 C85 30 75 10 50 10 C30 10 15 25 15 50 C15 70 30 80 45 75 L55 70 C60 68 65 65 65 55 C65 45 60 30 50 30 C40 30 35 40 35 50 C35 60 42 65 50 62 L60 58 C65 90 65 110 55 110 C50 110 45 108 42 102 Z',

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
