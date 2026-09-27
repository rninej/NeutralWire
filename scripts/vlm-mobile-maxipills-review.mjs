// VLM review of 4 mobile-UI screenshots (NeutralWire, 390px iPhone viewport).
// Follows skills/VLM/SKILL.md: read local image -> base64 data URL -> z-ai-web-dev-sdk
// chat.completions.createVision (backend only), prints analysis per image.
import ZAI from 'z-ai-web-dev-sdk';
import fs from 'node:fs';
import path from 'node:path';

const IMG_DIR = '/home/z/my-project/download/verify';

const CORE_CHECKLIST = `
You are a meticulous mobile UI reviewer inspecting a screenshot of a news web app
("NeutralWire") rendered at a 390px iPhone viewport width. Inspect the image carefully
and answer each item concretely:
1. LAYOUT INTEGRITY: Is the layout clean and unbroken? Look specifically for anything
   clipped at the screen edge, elements overlapping each other, or text overflowing /
   getting cut off by its container.
2. PILL ROWS: Are the rows of small topic "pills" readable, evenly distributed
   edge-to-edge, and consistent in height/size? (If this screenshot has no pill rows,
   answer N/A.)
3. GOLDEN "+" BUTTON: Is the small golden "+" (diamond / rotated-square) button visible,
   fully on-screen (not cropped), and proportionally sized relative to the pills (not
   oversized, undersized, or squashed)? (If this screenshot has no such button, answer N/A.)
4. DEFECTS: List any visual defects or awkward spacing you can see: misalignment,
   inconsistent gaps, cramped or orphaned elements, stray scrollbars, rendering artifacts.
Be specific and concise. Finish with exactly one line:
"VERDICT: PASS" if you found no issues, otherwise "VERDICT: ISSUES - " plus a
one-sentence description of the issues found.`;

const TARGETS = [
  {
    file: 'mobile-maxipills-customtopics.png',
    context:
      'Context: homepage header with "maxi pills" subtopic tabs — two rows of small text ' +
      'pills, plus a third scrollable strip of custom topics ("Mars Missions / Chess / ' +
      'AI Art"), and a small golden "+" button at the end of row 2.',
  },
  {
    file: 'mobile-3tier-dialog.png',
    context:
      'Context: an upgrade dialog overlaid on the page, with three tier cards ' +
      '(Free / Premium / Ultra) stacked vertically. Check that each card is fully ' +
      'visible, not clipped by the dialog edges or the notch/safe area, with readable ' +
      'text and no overlapping badges/buttons.',
  },
  {
    file: 'mobile-picker-fixed.png',
    context:
      'Context: a full-screen bottom-sheet "Add subtopics" picker with a search input, ' +
      'pinned topic chips, and a grid of topic chips. Check the search input is fully ' +
      'visible, chips are evenly laid out with no clipped labels, and the sheet is not ' +
      'cut off at the bottom or edges.',
  },
  {
    file: 'mobile-maxipills-after.png',
    context:
      'Context: homepage header with "maxi pills" subtopic tabs — two rows of small text ' +
      'pills — the state BEFORE custom topics were pinned. A small golden "+" button ' +
      'should sit at/near the end of row 2.',
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
