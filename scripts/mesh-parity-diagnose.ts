/**
 * mesh-parity-diagnose.ts — find why relay manifest verification mismatches.
 *
 * Reads the LIVE Firebase nodes + manifests, recomputes hashes with the
 * exact same code the client relay uses, and pinpoints the divergence.
 */
import {
  MESH_PATHS,
  canonical,
  hashMeshNode,
  slimNodeForMesh,
  validateMeshNode,
} from '@/lib/mesh/mesh-protocol'

const RTDB = 'https://neutralwire-aaedf-default-rtdb.europe-west1.firebasedatabase.app'

async function rawGet(path: string): Promise<string | null> {
  const res = await fetch(`${RTDB}/${path}.json`, { cache: 'no-store' })
  if (!res.ok) return null
  return res.text()
}

async function getJson<T>(path: string): Promise<T | null> {
  const text = await rawGet(path)
  if (!text || text === 'null') return null
  return JSON.parse(text) as T
}

// Mirror of the server manifest writer (news-cache.ts writeMeshManifest):
// hash the node object that was PUT to Firebase.
async function main() {
  const rooms = ['relevant__GB', 'relevant__UK', 'relevant__HK', 'technology', 'business', 'sports']
  for (const room of rooms) {
    const manifest = await getJson<{ hash?: string; updatedAt?: number; v?: number; sig?: string }>(
      MESH_PATHS.manifest(room),
    )
    const nodeText = await rawGet(MESH_PATHS.node(room))
    console.log(`\n════ ${room} ════`)
    if (!manifest) {
      console.log('  manifest: MISSING')
    } else {
      console.log(`  manifest.hash:    ${manifest.hash}`)
      console.log(`  manifest.updated: ${new Date(manifest.updatedAt ?? 0).toISOString()}`)
    }
    if (!nodeText || nodeText === 'null') {
      console.log('  node: MISSING')
      continue
    }
    console.log(`  node bytes: ${nodeText.length}`)
    const rawNode = JSON.parse(nodeText)
    // Does topics come back as an ARRAY or an OBJECT (RTDB array quirk)?
    console.log(`  topics is Array: ${Array.isArray(rawNode.topics)} (len=${rawNode.topics?.length ?? Object.keys(rawNode.topics ?? {}).length})`)

    const node = validateMeshNode(rawNode)
    if (!node) {
      console.log('  validateMeshNode: FAILED (invalid shape)')
      continue
    }
    const hash = await hashMeshNode(node)
    console.log(`  recomputed hash:  ${hash}`)
    if (manifest?.hash) {
      console.log(`  MATCH: ${hash === manifest.hash}`)
    }

    // Divergence hunt: which top-level slim field differs vs raw?
    const slim = slimNodeForMesh(rawNode)
    console.log(`  slim: updatedAt=${slim.updatedAt} sourceCount=${slim.sourceCount} articleCount=${slim.articleCount} topics=${slim.topics.length}`)
    // Show the raw node's non-topic fields for eyeballing
    const { topics, ...rest } = rawNode
    console.log(`  raw non-topic fields: ${JSON.stringify(rest)}`)
    // Compare manifest.updatedAt vs node.updatedAt
    if (manifest?.updatedAt && typeof rawNode.updatedAt === 'number') {
      console.log(`  updatedAt delta (node - manifest): ${rawNode.updatedAt - manifest.updatedAt}`)
    }
  }
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
