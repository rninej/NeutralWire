/** Probe: does Bun's fetch stream SSE incrementally? */
export {}
const url =
  'https://neutralwire-aaedf-default-rtdb.europe-west1.firebasedatabase.app/meshTest__ZZ_probe2.json'

async function main() {
  const ac = new AbortController()
  const res = await fetch(url, {
    headers: { Accept: 'text/event-stream' },
    signal: ac.signal,
  })
  console.log('status:', res.status, 'has body:', !!res.body)
  if (!res.body) return
  const reader = res.body.getReader()
  let chunks = 0
  // Write a value after 1s; if streaming works we should receive the put.
  setTimeout(() => {
    void fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    })
  }, 1000)
  setTimeout(() => {
    console.log('aborting after 4s; chunks received:', chunks)
    ac.abort()
    process.exit(0)
  }, 4000)
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks++
      console.log(`chunk #${chunks}:`, new TextDecoder().decode(value).slice(0, 120))
    }
  } catch (e) {
    console.log('stream ended/aborted:', String(e).slice(0, 80))
  }
}

main()
