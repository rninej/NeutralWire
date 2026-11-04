/**
 * s46-render-digest.ts — render the NEW grid digest email to a PNG for
 * visual verification (no send, no Firebase writes).
 *
 * Gathers the real subscriber's stories (same as the live pipeline),
 * runs generateNewsletter (AI unavailable locally → the deterministic
 * content path), writes /tmp digest HTML, then agent-browser screenshots
 * it at desktop + mobile widths.
 */
import { gatherStories, generateNewsletter } from '../src/lib/digest'
import { writeFileSync } from 'fs'

async function main() {
  const stories = await gatherStories('a_49b6b3d4551459fff057')
  console.log('stories:', stories.length)
  const nl = await generateNewsletter('arnavjain1009@gmail.com', stories)
  if (!nl) throw new Error('newsletter null')
  console.log('subject:', nl.subject)
  console.log('html bytes:', nl.html.length)
  writeFileSync('/home/z/my-project/download/verify/s46-digest-grid.html', nl.html)
  // Also a mobile-narrow marker file is pointless — same HTML; screenshot
  // at two widths instead.
  console.log('written: download/verify/s46-digest-grid.html')
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
