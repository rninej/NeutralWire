/**
 * SVG path data for rendering text WITHOUT any font dependency.
 *
 * All characters are drawn as filled SVG vector paths — no <text>
 * elements, no fonts. Guaranteed to render in sharp's SVG renderer.
 *
 * Characters use SOLID block-style shapes (not 7-segment) so digits
 * look like normal printed numbers, not broken-line digital clock style.
 *
 * Each character is drawn on a 100x140 grid, then scaled.
 */

// Solid block-style digit paths (filled shapes, not segmented)
// Drawn on a 100x140 grid. These look like normal bold printed numbers.
export const CHAR_PATHS: Record<string, string> = {
  '0': 'M50 10 C25 10 15 35 15 70 C15 105 25 130 50 130 C75 130 85 105 85 70 C85 35 75 10 50 10 Z M50 30 C65 30 70 50 70 70 C70 90 65 110 50 110 C35 110 30 90 30 70 C30 50 35 30 50 30 Z',
  '1': 'M25 25 L55 10 L70 10 L70 130 L50 130 L50 35 L40 40 L25 35 Z',
  '2': 'M15 30 C15 15 35 10 50 10 C65 10 85 15 85 35 C85 55 65 65 50 80 L35 95 L35 110 L85 110 L85 130 L15 130 L15 105 C15 90 35 80 50 65 C60 55 65 45 65 35 C65 25 58 30 50 30 C42 30 35 35 35 45 L15 45 Z',
  '3': 'M15 20 C25 12 40 10 50 10 C65 10 85 15 85 35 C85 50 75 58 65 60 C78 62 85 72 85 88 C85 115 65 130 50 130 C35 130 22 125 15 115 L25 100 C30 108 40 110 50 110 C58 110 65 102 65 88 C65 75 58 70 50 70 L40 70 L40 50 L50 50 C58 50 65 45 65 35 C65 28 58 30 50 30 C42 30 35 32 30 38 Z',
  '4': 'M10 90 L45 10 L65 10 L65 90 L80 90 L80 110 L65 110 L65 130 L45 130 L45 110 L10 110 Z M45 90 L55 45 L45 90 Z M45 50 L45 90 L55 90 Z',
  '5': 'M20 10 L80 10 L80 30 L40 30 L40 55 L60 53 C75 53 85 65 85 85 C85 115 65 130 50 130 C35 130 22 122 15 110 L28 95 C33 103 40 110 50 110 C60 110 65 100 65 85 C65 72 58 70 50 70 L40 72 L40 10 Z',
  '6': 'M80 20 C70 12 55 10 45 10 C25 10 15 30 15 70 C15 110 25 130 50 130 C70 130 85 115 85 90 C85 70 70 60 55 65 L45 70 C40 72 35 75 35 85 C35 95 40 110 50 110 C60 110 65 100 65 90 C65 80 58 75 50 78 L40 82 C35 50 35 30 45 30 C50 30 55 32 58 38 Z',
  '7': 'M15 10 L85 10 L85 30 L55 130 L35 130 L60 30 L15 30 Z',
  '8': 'M50 10 C35 10 20 20 20 35 C20 48 30 55 40 60 C25 65 15 75 15 90 C15 115 30 130 50 130 C70 130 85 115 85 90 C85 75 75 65 60 60 C70 55 80 48 80 35 C80 20 65 10 50 10 Z M50 30 C57 30 62 35 62 42 C62 49 57 54 50 54 C43 54 38 49 38 42 C38 35 43 30 50 30 Z M50 72 C60 72 67 80 67 92 C67 104 60 112 50 112 C40 112 33 104 33 92 C33 80 40 72 50 72 Z',
  '9': 'M20 120 C30 128 45 130 55 130 C75 130 85 110 85 70 C85 30 75 10 50 10 C30 10 15 25 15 50 C15 70 30 80 45 75 L55 70 C60 68 65 65 65 55 C65 45 60 30 50 30 C40 30 35 40 35 50 C35 60 42 65 50 62 L60 58 C65 90 65 110 55 110 C50 110 45 108 42 102 Z',

  // Block-style uppercase letters for "NeutralWire"
  'N': 'M15 10 L35 10 L65 95 L65 10 L85 10 L85 130 L65 130 L35 45 L35 130 L15 130 Z',
  'e': 'M50 40 C35 40 25 50 25 65 L25 75 C25 90 35 100 50 100 C60 100 68 95 72 88 L85 98 C78 115 65 120 50 120 C25 120 10 105 10 80 L10 65 C10 45 25 30 50 30 C70 30 85 45 85 65 L85 75 L50 75 L25 65 C25 55 35 50 50 50 Z',
  'u': 'M15 30 L35 30 L35 85 C35 95 40 100 50 100 C60 100 65 95 65 85 L65 30 L85 30 L85 100 L65 100 L65 92 C60 98 55 100 50 100 C30 100 15 90 15 70 Z',
  't': 'M20 20 L60 20 L60 40 L45 40 L45 100 L60 100 L60 120 L20 120 L20 100 L35 100 L35 40 L20 40 Z',
  'r': 'M15 30 L35 30 L35 42 C40 33 48 30 55 30 L65 30 L65 52 L55 52 C45 52 35 58 35 70 L35 100 L15 100 Z',
  'a': 'M10 75 C10 45 25 30 50 30 C70 30 85 45 85 70 L85 100 L65 100 L65 75 C65 60 60 50 50 50 C40 50 35 60 30 75 L30 100 L10 100 Z',
  'l': 'M35 10 L55 10 L55 100 L35 100 Z',
  'W': 'M5 10 L25 10 L38 85 L48 40 L58 85 L70 10 L90 10 L75 130 L60 130 L50 85 L40 130 L25 130 Z',
  'i': 'M35 30 L55 30 L55 100 L35 100 Z M35 10 L55 10 L55 22 L35 22 Z',
}

/**
 * Generate SVG path elements for a string of characters.
 * Each character is placed centered at the given position with the given height.
 *
 * @param text The text to render (e.g. "NW", "3", "NeutralWire")
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
  // Vary character width: letters and digits are slightly different widths
  // but we use a fixed average for simplicity
  const charWidth = 100 * scale * 0.55
  const totalWidth = text.length * charWidth
  const startX = centerX - totalWidth / 2

  let svg = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const path = CHAR_PATHS[ch]
    if (!path) continue // Skip unknown characters (spaces, etc.)
    const charX = startX + i * charWidth
    svg += `<g transform="translate(${charX},${topY}) scale(${scale})"><path d="${path}" fill="${fill}"/></g>`
  }
  return svg
}
