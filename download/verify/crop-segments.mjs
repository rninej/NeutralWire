import sharp from 'sharp';
import fs from 'fs';

// Split a tall full-page screenshot into vertical segments with small overlap
const [input, outPrefix, segCount] = process.argv.slice(2);
const meta = await sharp(input).metadata();
const H = meta.height, W = meta.width;
const n = parseInt(segCount, 10);
const segH = Math.ceil(H / n);

for (let i = 0; i < n; i++) {
  const top = Math.max(0, i * segH - (i > 0 ? 40 : 0)); // 40px overlap
  const height = Math.min(segH + (i > 0 ? 40 : 0), H - top);
  const out = `${outPrefix}-seg${i + 1}.png`;
  await sharp(input).extract({ left: 0, top, width: W, height }).png().toFile(out);
  console.log(out, `${W}x${height}`);
}
fs.writeFileSync(`${outPrefix}-meta.json`, JSON.stringify({ W, H, n, segH }));
