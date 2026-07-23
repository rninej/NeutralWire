/**
 * Country detection for the "My Country" / "Relevant" tabs.
 *
 * Strategy:
 *  1. Server-side (preferred): read the client IP from request headers
 *     (x-forwarded-for / x-real-ip / cf-connecting-ip), then call a
 *     free IP-geolocation API from the server. This avoids CORS issues
 *     and works on the very first render.
 *  2. Client-side fallback: if the server couldn't detect (e.g. localhost),
 *     the browser can call a CORS-friendly geolocation API directly.
 *
 * Both paths cache the result in localStorage so we don't re-detect on
 * every page load.
 */

export interface CountryInfo {
  code: string // ISO 3166-1 alpha-2 (e.g. "US", "GB", "HK")
  name: string
  flag: string // emoji flag
}

// ---------- ISO code → flag emoji ----------
export function isoToFlag(iso: string): string {
  if (!iso || iso.length !== 2) return '🌍'
  const cc = iso.toUpperCase()
  const codePoints = [...cc].map((c) => 0x1f1e6 + (c.charCodeAt(0) - 65))
  return String.fromCodePoint(...codePoints)
}

// ---------- Country → display name ----------
const COUNTRY_NAMES: Record<string, string> = {
  US: 'United States',
  GB: 'United Kingdom',
  UK: 'United Kingdom',
  CA: 'Canada',
  AU: 'Australia',
  IE: 'Ireland',
  NZ: 'New Zealand',
  IN: 'India',
  HK: 'Hong Kong',
  SG: 'Singapore',
  JP: 'Japan',
  KR: 'South Korea',
  CN: 'China',
  TW: 'Taiwan',
  DE: 'Germany',
  FR: 'France',
  ES: 'Spain',
  IT: 'Italy',
  NL: 'Netherlands',
  BE: 'Belgium',
  CH: 'Switzerland',
  AT: 'Austria',
  SE: 'Sweden',
  NO: 'Norway',
  DK: 'Denmark',
  FI: 'Finland',
  PL: 'Poland',
  PT: 'Portugal',
  GR: 'Greece',
  CZ: 'Czechia',
  RO: 'Romania',
  HU: 'Hungary',
  IL: 'Israel',
  AE: 'United Arab Emirates',
  SA: 'Saudi Arabia',
  QA: 'Qatar',
  TR: 'Turkey',
  IR: 'Iran',
  IQ: 'Iraq',
  EG: 'Egypt',
  ZA: 'South Africa',
  NG: 'Nigeria',
  KE: 'Kenya',
  MA: 'Morocco',
  BR: 'Brazil',
  AR: 'Argentina',
  MX: 'Mexico',
  CL: 'Chile',
  CO: 'Colombia',
  PE: 'Peru',
  VE: 'Venezuela',
  RU: 'Russia',
  UA: 'Ukraine',
}

export function countryName(code: string): string {
  return COUNTRY_NAMES[code.toUpperCase()] || code.toUpperCase()
}

// ---------- Server-side detection ----------
/**
 * Extract the client's IP from request headers, accounting for the
 * Caddy gateway in front of the dev server.
 */
function clientIpFromHeaders(headers: Headers): string | null {
  // Standard headers — check in order of preference.
  const cf = headers.get('cf-connecting-ip')
  if (cf) return cf.trim()

  const xReal = headers.get('x-real-ip')
  if (xReal) return xReal.trim()

  const xff = headers.get('x-forwarded-for')
  if (xff) {
    // x-forwarded-for can be a comma-separated list; first entry is the client.
    const first = xff.split(',')[0]?.trim()
    if (first && first !== 'unknown') return first
  }

  return null
}

/**
 * Server-side country detection.
 * Calls ip-api.com (free, no key, no CORS restrictions server-side).
 * Returns null if detection fails (e.g. localhost, network error).
 *
 * Result is cached in-process for 1 hour per IP to avoid hitting the
 * geolocation API on every request.
 */
const SERVER_CACHE = new Map<string, { ts: number; info: CountryInfo | null }>()
const SERVER_CACHE_TTL_MS = 60 * 60 * 1000

export async function detectCountryServer(
  headers: Headers,
): Promise<CountryInfo | null> {
  const ip = clientIpFromHeaders(headers)
  if (!ip) return null

  // Don't bother detecting for obvious local / private IPs.
  if (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    ip.startsWith('172.16.') ||
    ip === 'localhost'
  ) {
    return null
  }

  const cached = SERVER_CACHE.get(ip)
  if (cached && Date.now() - cached.ts < SERVER_CACHE_TTL_MS) {
    return cached.info
  }

  try {
    const url = `http://ip-api.com/json/${encodeURIComponent(
      ip,
    )}?fields=country,countryCode`
    const res = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      cache: 'no-store',
    })
    if (!res.ok) {
      SERVER_CACHE.set(ip, { ts: Date.now(), info: null })
      return null
    }
    const data = (await res.json()) as {
      country?: string
      countryCode?: string
    }
    if (!data.countryCode) {
      SERVER_CACHE.set(ip, { ts: Date.now(), info: null })
      return null
    }
    const info: CountryInfo = {
      code: data.countryCode.toUpperCase(),
      name: data.country || countryName(data.countryCode),
      flag: isoToFlag(data.countryCode),
    }
    SERVER_CACHE.set(ip, { ts: Date.now(), info })
    return info
  } catch {
    SERVER_CACHE.set(ip, { ts: Date.now(), info: null })
    return null
  }
}

// ---------- Client-side detection (primary) ----------
/**
 * Browser-side country detection via multiple CORS-friendly APIs.
 *
 * This is the PRIMARY detection method (not the fallback) because:
 *  - The server runs behind a gateway that may not forward the real
 *    client IP, so server-side detection can return the wrong country.
 *  - The browser directly sees the user's real public IP.
 *  - CORS-friendly APIs (ipwho.is) work from the browser.
 *
 * Tries ipwho.is first, then reallyfreegeoip.org as a backup.
 * Result is cached in localStorage for 24 hours.
 */
const CLIENT_CACHE_KEY = 'neutralwire:country'
const CLIENT_CACHE_TTL_MS = 24 * 60 * 60 * 1000

export async function detectCountryClient(): Promise<CountryInfo | null> {
  if (typeof window === 'undefined') return null

  // Try cache first.
  try {
    const raw = localStorage.getItem(CLIENT_CACHE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as {
        ts: number
        info: CountryInfo | null
      }
      if (Date.now() - parsed.ts < CLIENT_CACHE_TTL_MS) {
        return parsed.info
      }
    }
  } catch {
    // ignore
  }

  const info = await detectCountryClientFresh()
  // Cache the result (even if null, to avoid retrying every page load).
  try {
    localStorage.setItem(
      CLIENT_CACHE_KEY,
      JSON.stringify({ ts: Date.now(), info }),
    )
  } catch {
    // ignore
  }
  return info
}

/**
 * Force a fresh client-side detection (bypasses cache).
 * Tries multiple CORS-friendly geolocation APIs in order.
 */
async function detectCountryClientFresh(): Promise<CountryInfo | null> {
  // 1. ipwho.is — CORS-friendly, free, no key
  try {
    const res = await fetch('https://ipwho.is/', {
      signal: AbortSignal.timeout(6000),
    })
    if (res.ok) {
      const data = (await res.json()) as {
        success: boolean
        country_code?: string
        country?: string
      }
      if (data.success && data.country_code) {
        return {
          code: data.country_code.toUpperCase(),
          name: data.country || countryName(data.country_code),
          flag: isoToFlag(data.country_code),
        }
      }
    }
  } catch {
    // try next
  }

  // 2. reallyfreegeoip.org — CORS-friendly, free, no key
  try {
    const res = await fetch('https://reallyfreegeoip.org/json/', {
      signal: AbortSignal.timeout(6000),
    })
    if (res.ok) {
      const data = (await res.json()) as {
        country_code?: string
        country_name?: string
      }
      if (data.country_code) {
        return {
          code: data.country_code.toUpperCase(),
          name: data.country_name || countryName(data.country_code),
          flag: isoToFlag(data.country_code),
        }
      }
    }
  } catch {
    // try next
  }

  // 3. Cloudflare trace — returns plaintext with loc=XX line
  try {
    const res = await fetch('https://www.cloudflare.com/cdn-cgi/trace', {
      signal: AbortSignal.timeout(6000),
    })
    if (res.ok) {
      const text = await res.text()
      const match = text.match(/^loc=(\w{2})$/m)
      if (match) {
        const code = match[1].toUpperCase()
        return {
          code,
          name: countryName(code),
          flag: isoToFlag(code),
        }
      }
    }
  } catch {
    // give up
  }

  return null
}

/**
 * Clear the cached client-side country detection result.
 * Called when the user manually picks a different country.
 */
export function clearCountryCache(): void {
  try {
    localStorage.removeItem(CLIENT_CACHE_KEY)
  } catch {
    // ignore
  }
}

// ---------- Country → relevant news sources ----------
/**
 * Returns the source IDs that are most relevant to a given country.
 * Used by the "My Country" and "Relevant" tabs.
 *
 * Falls back to a curated international set if the country has no
 * dedicated sources.
 */
const COUNTRY_SOURCES: Record<string, string[]> = {
  US: ['nytimes', 'cnn', 'foxnews', 'nbcnews', 'cnbc', 'npr', 'breitbart', 'vox', 'huffpost', 'abcnews', 'nationalreview', 'nypost', 'thehill', 'salon', 'rawstory', 'commondreams', 'dailywire', 'theblaze', 'washingtonpost', 'latimes', 'newyorker'],
  GB: ['bbc', 'theguardian', 'ft', 'economist', 'skynews', 'telegraph', 'independent', 'dailymail', 'mirror', 'standard', 'express'],
  UK: ['bbc', 'theguardian', 'ft', 'economist', 'skynews', 'telegraph', 'independent', 'dailymail', 'mirror', 'standard', 'express'],
  CA: ['bbc', 'theguardian', 'nytimes', 'aljazeera'],
  AU: ['bbc', 'theguardian', 'nytimes', 'aljazeera', 'cnbc'],
  IE: ['bbc', 'theguardian', 'ft'],
  NZ: ['bbc', 'theguardian', 'aljazeera'],
  IN: ['bbc', 'aljazeera', 'reuters-algolia', 'nytimes', 'theguardian'],
  HK: ['bbc', 'aljazeera', 'japantimes', 'france24', 'nytimes'],
  SG: ['bbc', 'aljazeera', 'japantimes', 'cnbc', 'ft'],
  JP: ['japantimes', 'bbc', 'aljazeera', 'nytimes', 'cnbc'],
  KR: ['bbc', 'aljazeera', 'nytimes', 'cnbc'],
  CN: ['bbc', 'aljazeera', 'nytimes', 'france24'],
  TW: ['bbc', 'aljazeera', 'japantimes', 'nytimes'],
  DE: ['dw', 'bbc', 'nytimes', 'ft', 'aljazeera'],
  FR: ['france24', 'lemonde', 'bbc', 'nytimes', 'aljazeera'],
  ES: ['bbc', 'aljazeera', 'nytimes', 'france24'],
  IT: ['bbc', 'aljazeera', 'nytimes', 'ft'],
  NL: ['bbc', 'nytimes', 'ft', 'dw'],
  BE: ['bbc', 'nytimes', 'ft', 'dw'],
  CH: ['bbc', 'nytimes', 'ft', 'dw'],
  AT: ['bbc', 'nytimes', 'dw', 'ft'],
  SE: ['bbc', 'nytimes', 'dw', 'ft'],
  NO: ['bbc', 'nytimes', 'dw', 'ft'],
  DK: ['bbc', 'nytimes', 'dw', 'ft'],
  FI: ['bbc', 'nytimes', 'dw', 'ft'],
  PL: ['bbc', 'nytimes', 'dw', 'ft'],
  PT: ['bbc', 'nytimes', 'france24'],
  GR: ['bbc', 'nytimes', 'france24', 'aljazeera'],
  CZ: ['bbc', 'nytimes', 'dw'],
  RO: ['bbc', 'nytimes', 'dw'],
  HU: ['bbc', 'nytimes', 'dw'],
  IL: ['aljazeera', 'bbc', 'nytimes', 'france24'],
  AE: ['aljazeera', 'bbc', 'cnbc', 'ft'],
  SA: ['aljazeera', 'bbc', 'cnbc', 'ft'],
  QA: ['aljazeera', 'bbc', 'cnbc', 'ft'],
  TR: ['aljazeera', 'bbc', 'nytimes', 'france24'],
  IR: ['aljazeera', 'bbc', 'nytimes', 'france24'],
  IQ: ['aljazeera', 'bbc', 'nytimes', 'france24'],
  EG: ['aljazeera', 'bbc', 'nytimes', 'france24'],
  ZA: ['bbc', 'aljazeera', 'nytimes', 'theguardian'],
  NG: ['bbc', 'aljazeera', 'nytimes', 'france24'],
  KE: ['bbc', 'aljazeera', 'nytimes', 'france24'],
  MA: ['bbc', 'aljazeera', 'france24', 'nytimes'],
  BR: ['bbc', 'aljazeera', 'nytimes', 'france24', 'cnbc'],
  AR: ['bbc', 'aljazeera', 'nytimes', 'france24'],
  MX: ['bbc', 'aljazeera', 'nytimes', 'cnbc'],
  CL: ['bbc', 'aljazeera', 'nytimes', 'france24'],
  CO: ['bbc', 'aljazeera', 'nytimes', 'france24'],
  PE: ['bbc', 'aljazeera', 'nytimes', 'france24'],
  VE: ['bbc', 'aljazeera', 'nytimes', 'france24'],
  RU: ['rt', 'bbc', 'aljazeera', 'nytimes', 'france24'],
  UA: ['bbc', 'aljazeera', 'nytimes', 'france24'],
}

/**
 * Returns the source IDs relevant to a country. Falls back to the
 * international set if no mapping exists.
 */
export function sourcesForCountry(code: string): string[] {
  return COUNTRY_SOURCES[code.toUpperCase()] || [
    'bbc',
    'nytimes',
    'aljazeera',
    'theguardian',
    'france24',
    'reuters-algolia',
  ]
}

/**
 * Default country used when detection fails entirely.
 * Picks a neutral international mix.
 */
export const DEFAULT_COUNTRY: CountryInfo = {
  code: 'INT',
  name: 'International',
  flag: '🌍',
}

/**
 * Countries the user can manually pick from in the country selector.
 * Sorted alphabetically by name. Only includes countries that have
 * a dedicated source mapping in COUNTRY_SOURCES.
 */
export const SELECTABLE_COUNTRIES: CountryInfo[] = Object.keys(COUNTRY_SOURCES)
  .filter((code) => code !== 'INT')
  .map((code) => ({
    code,
    name: countryName(code),
    flag: isoToFlag(code),
  }))
  .sort((a, b) => a.name.localeCompare(b.name))
