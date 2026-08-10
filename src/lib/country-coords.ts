/**
 * Simplified country coordinates for the world map.
 *
 * Each country has an approximate lat/lng centroid + a 2-letter ISO code.
 * Used by the analytics world map to plot user locations as dots on an
 * SVG world map.
 *
 * The map uses an equirectangular projection (lat/lng → x/y) which is
 * simple and good enough for a heatmap-style visualization.
 */

export interface CountryCoord {
  code: string
  name: string
  lat: number
  lng: number
}

export const COUNTRY_COORDS: Record<string, CountryCoord> = {
  US: { code: 'US', name: 'United States', lat: 39, lng: -98 },
  GB: { code: 'GB', name: 'United Kingdom', lat: 54, lng: -2 },
  IN: { code: 'IN', name: 'India', lat: 21, lng: 78 },
  CA: { code: 'CA', name: 'Canada', lat: 56, lng: -106 },
  AU: { code: 'AU', name: 'Australia', lat: -25, lng: 133 },
  DE: { code: 'DE', name: 'Germany', lat: 51, lng: 10 },
  FR: { code: 'FR', name: 'France', lat: 46, lng: 2 },
  JP: { code: 'JP', name: 'Japan', lat: 36, lng: 138 },
  CN: { code: 'CN', name: 'China', lat: 35, lng: 103 },
  BR: { code: 'BR', name: 'Brazil', lat: -10, lng: -55 },
  RU: { code: 'RU', name: 'Russia', lat: 61, lng: 100 },
  IT: { code: 'IT', name: 'Italy', lat: 42, lng: 12 },
  ES: { code: 'ES', name: 'Spain', lat: 40, lng: -4 },
  NL: { code: 'NL', name: 'Netherlands', lat: 52, lng: 5 },
  SE: { code: 'SE', name: 'Sweden', lat: 62, lng: 15 },
  NO: { code: 'NO', name: 'Norway', lat: 62, lng: 10 },
  PL: { code: 'PL', name: 'Poland', lat: 52, lng: 19 },
  MX: { code: 'MX', name: 'Mexico', lat: 23, lng: -102 },
  AR: { code: 'AR', name: 'Argentina', lat: -34, lng: -64 },
  ZA: { code: 'ZA', name: 'South Africa', lat: -29, lng: 24 },
  AE: { code: 'AE', name: 'UAE', lat: 24, lng: 54 },
  SA: { code: 'SA', name: 'Saudi Arabia', lat: 24, lng: 45 },
  PK: { code: 'PK', name: 'Pakistan', lat: 30, lng: 70 },
  BD: { code: 'BD', name: 'Bangladesh', lat: 24, lng: 90 },
  SG: { code: 'SG', name: 'Singapore', lat: 1.3, lng: 103.8 },
  HK: { code: 'HK', name: 'Hong Kong', lat: 22.3, lng: 114.2 },
  NZ: { code: 'NZ', name: 'New Zealand', lat: -41, lng: 174 },
  IE: { code: 'IE', name: 'Ireland', lat: 53, lng: -8 },
  BE: { code: 'BE', name: 'Belgium', lat: 50, lng: 4 },
  CH: { code: 'CH', name: 'Switzerland', lat: 47, lng: 8 },
  AT: { code: 'AT', name: 'Austria', lat: 47, lng: 14 },
  PT: { code: 'PT', name: 'Portugal', lat: 39, lng: -8 },
  GR: { code: 'GR', name: 'Greece', lat: 39, lng: 22 },
  TR: { code: 'TR', name: 'Turkey', lat: 39, lng: 35 },
  EG: { code: 'EG', name: 'Egypt', lat: 26, lng: 30 },
  NG: { code: 'NG', name: 'Nigeria', lat: 9, lng: 8 },
  KE: { code: 'KE', name: 'Kenya', lat: 0, lng: 38 },
  MA: { code: 'MA', name: 'Morocco', lat: 32, lng: -5 },
  TH: { code: 'TH', name: 'Thailand', lat: 15, lng: 101 },
  VN: { code: 'VN', name: 'Vietnam', lat: 14, lng: 108 },
  ID: { code: 'ID', name: 'Indonesia', lat: -2, lng: 118 },
  PH: { code: 'PH', name: 'Philippines', lat: 13, lng: 122 },
  MY: { code: 'MY', name: 'Malaysia', lat: 4, lng: 109 },
  KR: { code: 'KR', name: 'South Korea', lat: 36, lng: 128 },
  TW: { code: 'TW', name: 'Taiwan', lat: 24, lng: 121 },
  IL: { code: 'IL', name: 'Israel', lat: 31, lng: 35 },
  IR: { code: 'IR', name: 'Iran', lat: 32, lng: 53 },
  IQ: { code: 'IQ', name: 'Iraq', lat: 33, lng: 44 },
  UA: { code: 'UA', name: 'Ukraine', lat: 49, lng: 32 },
  CZ: { code: 'CZ', name: 'Czechia', lat: 49, lng: 15 },
  DK: { code: 'DK', name: 'Denmark', lat: 56, lng: 9 },
  FI: { code: 'FI', name: 'Finland', lat: 64, lng: 26 },
  RO: { code: 'RO', name: 'Romania', lat: 46, lng: 25 },
  HU: { code: 'HU', name: 'Hungary', lat: 47, lng: 19 },
  CO: { code: 'CO', name: 'Colombia', lat: 4, lng: -72 },
  CL: { code: 'CL', name: 'Chile', lat: -33, lng: -71 },
  PE: { code: 'PE', name: 'Peru', lat: -9, lng: -75 },
  VE: { code: 'VE', name: 'Venezuela', lat: 7, lng: -66 },
  UNKNOWN: { code: 'UNKNOWN', name: 'Unknown', lat: 0, lng: 0 },
}

/**
 * Convert lat/lng to x/y on an equirectangular projection.
 * - lng: -180 to 180 → x: 0 to width
 * - lat: 90 to -90 → y: 0 to height (inverted — north is top)
 */
export function latLngToXY(lat: number, lng: number, width: number, height: number): { x: number; y: number } {
  const x = ((lng + 180) / 360) * width
  const y = ((90 - lat) / 180) * height
  return { x, y }
}
