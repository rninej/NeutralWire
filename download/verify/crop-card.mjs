import sharp from 'sharp';

// Crop first-row card region from mobile screenshot and upscale for detail inspection
const input = 'download/verify/m46-seg1.png';
// header+intro approx first 200px; first row of cards follows
await sharp(input).extract({ left: 0, top: 190, width: 412, height: 420 }).png()
  .toFile('download/verify/m46-cardrow1.png');
// upscale 2.5x for readability
await sharp('download/verify/m46-cardrow1.png').resize({ width: 412 * 2.5 }).png()
  .toFile('download/verify/m46-cardrow1-zoom.png');
console.log('done');
