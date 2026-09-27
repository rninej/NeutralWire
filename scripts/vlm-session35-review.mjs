// VLM review for session35: the new golden-diamond premium icon + flagship
// newsletter card + gradient teaser. Uses z-ai-web-dev-sdk vision (per
// skills/VLM/SKILL.md): local image -> base64 data URL -> vision chat.
import ZAI from 'z-ai-web-dev-sdk';
import fs from 'node:fs';
import path from 'node:path';

const IMG_DIR = '/home/z/my-project/download/verify';

const TARGETS = [
  {
    file: 'session35-diamond-header.png',
    context: `Mobile (412px) homepage header of the NeutralWire news app. Focus on the
      top-right "Premium" area and the subtopic pill rows. Questions:
      (a) Does the small golden icon next to "Premium" read as a CUT DIAMOND / GEM
      (flat top edge, widest middle, pointed bottom) rather than a tall kite/rhombus?
      (b) Are the two subtopic rows tidy, with a small + chip with a golden diamond
      badge visible at the end of the second row, nothing clipped at screen edges?`,
  },
  {
    file: 'session35-newsletter-flagship.png',
    context: `Mobile Account page, Alerts tab. The "The AI Email Newsletter" card is a
      flagship premium feature entry. Check: amber gradient card with a bold header,
      a mail icon in a golden rounded square, 4 cadence chips (Weekly/Daily/Twice
      daily/3x daily) each with a small golden diamond, and a full-width golden
      "Unlock the newsletter" button. All text readable, nothing clipped/overlapping.`,
  },
  {
    file: 'session35-free-teaser.png',
    context: `Mobile: the "Add subtopics" picker sheet open over the homepage, with an
      "Upgrade to Premium" dialog on top (free user tapped a premium subtopic).
      Check the dialog shows a tier comparison (Free/Premium/Ultra) readably, and the
      picker behind it looks intact. Nothing clipped, no overlapping text.`,
  },
];

async function main() {
  const zai = await ZAI.create();
  for (const t of TARGETS) {
    const p = path.join(IMG_DIR, t.file);
    if (!fs.existsSync(p)) {
      console.log(`\n=== ${t.file}: MISSING, skipped`);
      continue;
    }
    const b64 = fs.readFileSync(p).toString('base64');
    const res = await zai.chat.completions.createVision({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
            { type: 'text', text: t.context + `\n\nAnswer concretely, then finish with exactly one line: "VERDICT: PASS" or "VERDICT: ISSUES - <one sentence>".` },
          ],
        },
      ],
      thinking: { type: 'disabled' },
    });
    const out = (res.choices?.[0]?.message?.content || '').trim();
    console.log(`\n=== ${t.file} ===\n${out}\n`);
  }
}

main().catch((e) => {
  console.error('VLM review failed:', e.message);
  process.exit(1);
});
