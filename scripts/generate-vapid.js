// Generate VAPID keys for web push notifications.
// Run: node scripts/generate-vapid.js
import webpush from 'web-push'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const vapidKeys = webpush.generateVAPIDKeys()

console.log('=== VAPID Keys Generated ===')
console.log('Public Key:  ', vapidKeys.publicKey)
console.log('Private Key: ', vapidKeys.privateKey)
console.log()

// Write to a .vapid-keys file for easy reference (gitignored).
const keysPath = path.join(__dirname, '..', '.vapid-keys')
fs.writeFileSync(
  keysPath,
  `VAPID_PUBLIC_KEY=${vapidKeys.publicKey}\nVAPID_PRIVATE_KEY=${vapidKeys.privateKey}\n`,
)
console.log('Saved to .vapid-keys (gitignored)')
