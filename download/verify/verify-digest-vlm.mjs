import ZAI from 'z-ai-web-dev-sdk';
import fs from 'fs';

async function analyze(imagePath, prompt) {
  const zai = await ZAI.create();
  const buf = fs.readFileSync(imagePath);
  const b64 = buf.toString('base64');
  const response = await zai.chat.completions.createVision({
    model: 'glm-4.6v',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }
        ]
      }
    ],
    thinking: { type: 'disabled' }
  });
  return response.choices?.[0]?.message?.content ?? JSON.stringify(response).slice(0, 2000);
}

const [imagePath, promptFile] = process.argv.slice(2);
const prompt = fs.readFileSync(promptFile, 'utf8');

try {
  const out = await analyze(imagePath, prompt);
  console.log('===== VLM RESULT =====');
  console.log(out);
} catch (err) {
  console.error('Vision chat failed:', err?.message || err);
  process.exit(1);
}
