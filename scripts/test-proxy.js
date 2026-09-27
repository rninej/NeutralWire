// Test proxy :3100 → :3000 with an injected script that fakes
// standalone (PWA) mode so the celebration / onboarding / app-open
// metrics code paths can be exercised in a normal browser.
// DEV TESTING ONLY — never used in production. Run: bun scripts/test-proxy.js
import http from 'http'

const INJECT = `<script>
(function () {
  try {
    Object.defineProperty(window.navigator, 'standalone', {
      get: function () { return true },
      configurable: true,
    })
  } catch (e) {}
  try {
    var orig = window.matchMedia
    window.matchMedia = function (q) {
      var m = orig.call(window, q)
      if (typeof q === 'string' && q.indexOf('display-mode') !== -1) {
        return {
          matches: true,
          media: q,
          onchange: null,
          addListener: function (cb) { m.addEventListener ? m.addEventListener('change', cb) : m.addListener(cb) },
          removeListener: function (cb) { m.removeEventListener ? m.removeEventListener('change', cb) : m.removeListener(cb) },
          addEventListener: function (t, cb) { m.addEventListener(t, cb) },
          removeEventListener: function (t, cb) { m.removeEventListener(t, cb) },
          dispatchEvent: function (e) { return m.dispatchEvent(e) },
        }
      }
      return m
    }
  } catch (e) {}
})()
</script>`

const server = http.createServer((req, res) => {
  // Force plain (uncompressed) responses and one-shot connections —
  // makes body rewriting reliable.
  const fwdHeaders = { ...req.headers, host: 'localhost:3000' }
  delete fwdHeaders['accept-encoding']
  delete fwdHeaders['connection']
  fwdHeaders['connection'] = 'close'

  const options = {
    hostname: 'localhost',
    port: 3000,
    path: req.url,
    method: req.method,
    headers: fwdHeaders,
    agent: false,
  }

  const proxy = http.request(options, (upstream) => {
    const headers = { ...upstream.headers }
    // Strip hop-by-hop + framing headers — we manage framing ourselves.
    for (const h of ['connection', 'keep-alive', 'transfer-encoding', 'content-length']) {
      delete headers[h]
    }
    const ct = String(headers['content-type'] || '')
    if (ct.includes('text/html')) {
      let body = ''
      upstream.setEncoding('utf8')
      upstream.on('data', (c) => (body += c))
      upstream.on('end', () => {
        body = body.replace(/<head([^>]*)>/i, (m) => m + INJECT)
        headers['content-length'] = Buffer.byteLength(body)
        res.writeHead(upstream.statusCode, headers)
        res.end(body)
      })
    } else {
      res.writeHead(upstream.statusCode, headers)
      upstream.pipe(res)
    }
  })

  proxy.on('error', (err) => {
    res.writeHead(502, { 'content-type': 'text/plain' })
    res.end('proxy error: ' + String(err))
  })

  // streaming bodies (POST etc.)
  req.pipe(proxy)
})

server.listen(3100, () => console.log('test proxy on http://localhost:3100'))
