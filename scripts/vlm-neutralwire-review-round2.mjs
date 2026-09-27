// VLM review round 2: 6 mobile/desktop UI screenshots of the NeutralWire news app.
// Follows skills/VLM/SKILL.md: read local image -> base64 data URL -> z-ai-web-dev-sdk
// chat.completions.createVision (backend only, thinking disabled), prints analysis per image.
import ZAI from 'z-ai-web-dev-sdk';
import fs from 'node:fs';
import path from 'node:path';

const IMG_DIR = '/home/z/my-project/download/verify';

const CORE_CHECKLIST = `
You are a meticulous UI reviewer inspecting one screenshot of a news web app ("NeutralWire").
Inspect the image carefully and answer each item concretely:
1. LAYOUT INTEGRITY: Is the layout clean and unbroken? Look specifically for anything
   clipped at the screen edge, elements overlapping each other, or text overflowing /
   getting cut off by its container.
2. READABILITY: Is all text readable (sufficient size, contrast, not truncated mid-word)?
3. SPACING: Are margins, gaps, and alignment consistent and sensible (no cramped or
   orphaned elements, no uneven distribution)?
4. DEFECTS: List any visual defects you can see: misalignment, stray scrollbars,
   rendering artifacts, elements overflowing cards, buttons/icons cropped or squashed.
Be specific and concise. Finish with exactly one line:
"VERDICT: PASS" if you found no issues, otherwise "VERDICT: ISSUES - " plus a
one-sentence description of the issues found.`;

const TARGETS = [
  {
    file: 'mobile-account-banner.png',
    context:
      'Context: mobile Account page (390px viewport), Profile tab, with an amber ' +
      '"You\'re browsing as a guest — Create account / Sign in" banner card at the top. ' +
      'Check the banner card specifically: its icon, text, and both action links/buttons ' +
      'must be fully visible, evenly laid out, and not overlapping or wrapping awkwardly.',
  },
  {
    file: 'mobile-stylepicker-locked.png',
    context:
      'Context: mobile Account page (390px viewport), Feed tab, "Feature Flags" card with ' +
      'a Premium lock banner and a greyed-out (disabled) header-style picker grid below it. ' +
      'Check that the lock banner text and lock icon are fully visible and readable, the ' +
      'greyed-out style options in the grid are evenly laid out with no clipped labels or ' +
      'previews, and the disabled state still looks intentional (not broken).',
  },
  {
    file: 'mobile-live-style-switch.png',
    context:
      'Context: mobile homepage (390px viewport) after switching to the "Big chips" header ' +
      'style — big rounded icon chips in a horizontally scrollable row plus a small golden ' +
      '"+" button (diamond / rotated square) at the end of the row. Check that the chips ' +
      'are uniform in size, their icons and labels are not clipped, the row scrolls without ' +
      'vertical overflow, and the golden "+" button is fully on-screen and proportionally sized.',
  },
  {
    file: 'desktop-maxipills-wide.png',
    context:
      'Context: desktop homepage (1440px wide) with a single row of "maxi pill" topic tabs ' +
      'plus an "Add" chip at the end of the row, and a "Premium" diamond button in the ' +
      'top-right of the header. Check that the single pill row fits the wide layout cleanly ' +
      '(aligned, evenly spaced, no ragged wrap), the "Add" chip is styled consistently with ' +
      'the pills, and the top-right Premium diamond button is not clipped by the viewport ' +
      'edge and does not collide with other header elements.',
  },
  {
    file: 'mobile-picker-final.png',
    context:
      'Context: mobile (390px viewport) full-screen bottom-sheet "Add subtopics" picker with ' +
      'a search input, pinned topic chips, and a grid of topic chips. Check the search input ' +
      'and header are fully visible at the top, chips are evenly laid out with no clipped ' +
      'labels, and the sheet is not cut off at the bottom or side edges.',
  },
  {
    file: 'mobile-feedtab-premium.png',
    context:
      'Context: mobile Account page (390px viewport), Feed tab, with the header-style picker ' +
      'now UNLOCKED (user is Premium — no lock banner). Check that the style option cards / ' +
      'grid are fully visible, each option label and preview is readable and unclipped, the ' +
      'selected state (if any) is clearly indicated, and spacing is consistent with no ' +
      'overlap or missing placeholder where the lock banner used to be.',
  },
];

function toDataUrl(filePath) {
  const buf = fs.readFileSync(filePath);
  const mime = filePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

async function main() {
  const zai = await ZAI.create(); // single instance reused for all images

  for (const t of TARGETS) {
    const filePath = path.join(IMG_DIR, t.file);
    if (!fs.existsSync(filePath)) {
      console.error(`!! Missing file: ${filePath}`);
      continue;
    }
    const prompt = `${t.context}\n${CORE_CHECKLIST}`;

    console.log('\n' + '='.repeat(78));
    console.log(`IMAGE: ${t.file}`);
    console.log('='.repeat(78));

    try {
      const response = await zai.chat.completions.createVision({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: toDataUrl(filePath) } },
            ],
          },
        ],
        thinking: { type: 'disabled' },
      });
      const reply = response.choices?.[0]?.message?.content;
      console.log(reply ?? JSON.stringify(response, null, 2));
    } catch (err) {
      console.error(`Vision chat failed for ${t.file}:`, err?.message || err);
    }
  }
}

main().catch((err) => {
  console.error('Fatal:', err?.message || err);
  process.exit(1);
});
