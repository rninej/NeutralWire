/**
 * Country → language mapping for the PWA language selection popup.
 *
 * Used to determine if a country's primary language is English. If NOT,
 * the PWA shows a language selection popup before the personalization quiz:
 *   - Top option: English
 *   - Bottom option: the country's primary language (with a selector)
 *
 * English-speaking countries (US, GB, CA, AU, IE, NZ, etc.) skip the popup.
 */

export interface LanguageInfo {
  code: string // ISO 639-1 language code (e.g. "hi", "zh", "es")
  name: string // English name (e.g. "Hindi", "Chinese", "Spanish")
  nativeName: string // Native name (e.g. "हिन्दी", "中文", "Español")
}

// Countries where English is the primary/official language.
// Users in these countries do NOT see the language popup.
const ENGLISH_COUNTRIES = new Set([
  'US', 'GB', 'UK', 'CA', 'AU', 'IE', 'NZ', 'IN', 'HK', 'SG', 'PH', 'ZA',
  'NG', 'KE', 'GH', 'JM', 'TT', 'BB', 'BZ', 'GUY', 'ZW', 'UG', 'MW', 'MT',
])

// Country → primary language mapping (for non-English countries).
// Only includes countries that are likely to visit NeutralWire based on
// the COUNTRY_SOURCES list in country-detect.ts.
const COUNTRY_LANGUAGES: Record<string, LanguageInfo> = {
  // East Asia
  JP: { code: 'ja', name: 'Japanese', nativeName: '日本語' },
  KR: { code: 'ko', name: 'Korean', nativeName: '한국어' },
  CN: { code: 'zh', name: 'Chinese', nativeName: '中文' },
  TW: { code: 'zh', name: 'Chinese', nativeName: '中文' },

  // Europe (non-English)
  DE: { code: 'de', name: 'German', nativeName: 'Deutsch' },
  FR: { code: 'fr', name: 'French', nativeName: 'Français' },
  ES: { code: 'es', name: 'Spanish', nativeName: 'Español' },
  IT: { code: 'it', name: 'Italian', nativeName: 'Italiano' },
  NL: { code: 'nl', name: 'Dutch', nativeName: 'Nederlands' },
  BE: { code: 'nl', name: 'Dutch', nativeName: 'Nederlands' },
  CH: { code: 'de', name: 'German', nativeName: 'Deutsch' },
  AT: { code: 'de', name: 'German', nativeName: 'Deutsch' },
  SE: { code: 'sv', name: 'Swedish', nativeName: 'Svenska' },
  NO: { code: 'no', name: 'Norwegian', nativeName: 'Norsk' },
  DK: { code: 'da', name: 'Danish', nativeName: 'Dansk' },
  FI: { code: 'fi', name: 'Finnish', nativeName: 'Suomi' },
  PL: { code: 'pl', name: 'Polish', nativeName: 'Polski' },
  CZ: { code: 'cs', name: 'Czech', nativeName: 'Čeština' },
  RO: { code: 'ro', name: 'Romanian', nativeName: 'Română' },
  HU: { code: 'hu', name: 'Hungarian', nativeName: 'Magyar' },
  GR: { code: 'el', name: 'Greek', nativeName: 'Ελληνικά' },
  PT: { code: 'pt', name: 'Portuguese', nativeName: 'Português' },

  // Middle East
  IL: { code: 'he', name: 'Hebrew', nativeName: 'עברית' },
  AE: { code: 'ar', name: 'Arabic', nativeName: 'العربية' },
  SA: { code: 'ar', name: 'Arabic', nativeName: 'العربية' },
  QA: { code: 'ar', name: 'Arabic', nativeName: 'العربية' },
  TR: { code: 'tr', name: 'Turkish', nativeName: 'Türkçe' },
  IR: { code: 'fa', name: 'Persian', nativeName: 'فارسی' },
  IQ: { code: 'ar', name: 'Arabic', nativeName: 'العربية' },
  EG: { code: 'ar', name: 'Arabic', nativeName: 'العربية' },

  // South Asia
  PK: { code: 'ur', name: 'Urdu', nativeName: 'اردو' },
  BD: { code: 'bn', name: 'Bengali', nativeName: 'বাংলা' },

  // Southeast Asia
  TH: { code: 'th', name: 'Thai', nativeName: 'ไทย' },
  VN: { code: 'vi', name: 'Vietnamese', nativeName: 'Tiếng Việt' },
  ID: { code: 'id', name: 'Indonesian', nativeName: 'Bahasa Indonesia' },
  PH: { code: 'tl', name: 'Filipino', nativeName: 'Filipino' },
  MY: { code: 'ms', name: 'Malay', nativeName: 'Bahasa Melayu' },

  // Latin America
  BR: { code: 'pt', name: 'Portuguese', nativeName: 'Português' },
  AR: { code: 'es', name: 'Spanish', nativeName: 'Español' },
  MX: { code: 'es', name: 'Spanish', nativeName: 'Español' },
  CL: { code: 'es', name: 'Spanish', nativeName: 'Español' },
  CO: { code: 'es', name: 'Spanish', nativeName: 'Español' },
  PE: { code: 'es', name: 'Spanish', nativeName: 'Español' },
  VE: { code: 'es', name: 'Spanish', nativeName: 'Español' },

  // Africa (non-English)
  MA: { code: 'ar', name: 'Arabic', nativeName: 'العربية' },

  // Eastern Europe
  RU: { code: 'ru', name: 'Russian', nativeName: 'Русский' },
  UA: { code: 'uk', name: 'Ukrainian', nativeName: 'Українська' },
  BY: { code: 'be', name: 'Belarusian', nativeName: 'Беларуская' },
}

/**
 * Returns true if the country's primary language is English.
 * Used to skip the language selection popup.
 */
export function isEnglishCountry(countryCode: string): boolean {
  return ENGLISH_COUNTRIES.has(countryCode.toUpperCase())
}

/**
 * Returns the primary language for a country, or null if the country
 * is English-speaking or unknown.
 *
 * If null, the language popup is NOT shown (either English-speaking
 * country, or we don't have language data — default to English).
 */
export function getCountryLanguage(countryCode: string): LanguageInfo | null {
  const cc = countryCode.toUpperCase()
  if (ENGLISH_COUNTRIES.has(cc)) return null
  return COUNTRY_LANGUAGES[cc] || null
}

/**
 * All available languages for the selector dropdown.
 * Used to populate the <select> in the language popup.
 */
export const ALL_LANGUAGES: LanguageInfo[] = [
  { code: 'en', name: 'English', nativeName: 'English' },
  { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी' },
  { code: 'zh', name: 'Chinese', nativeName: '中文' },
  { code: 'es', name: 'Spanish', nativeName: 'Español' },
  { code: 'fr', name: 'French', nativeName: 'Français' },
  { code: 'ar', name: 'Arabic', nativeName: 'العربية' },
  { code: 'de', name: 'German', nativeName: 'Deutsch' },
  { code: 'ja', name: 'Japanese', nativeName: '日本語' },
  { code: 'ko', name: 'Korean', nativeName: '한국어' },
  { code: 'pt', name: 'Portuguese', nativeName: 'Português' },
  { code: 'it', name: 'Italian', nativeName: 'Italiano' },
  { code: 'ru', name: 'Russian', nativeName: 'Русский' },
  { code: 'tr', name: 'Turkish', nativeName: 'Türkçe' },
  { code: 'nl', name: 'Dutch', nativeName: 'Nederlands' },
  { code: 'sv', name: 'Swedish', nativeName: 'Svenska' },
  { code: 'pl', name: 'Polish', nativeName: 'Polski' },
  { code: 'ur', name: 'Urdu', nativeName: 'اردو' },
  { code: 'bn', name: 'Bengali', nativeName: 'বাংলা' },
  { code: 'th', name: 'Thai', nativeName: 'ไทย' },
  { code: 'vi', name: 'Vietnamese', nativeName: 'Tiếng Việt' },
  { code: 'id', name: 'Indonesian', nativeName: 'Bahasa Indonesia' },
  { code: 'ms', name: 'Malay', nativeName: 'Bahasa Melayu' },
  { code: 'fa', name: 'Persian', nativeName: 'فارسی' },
  { code: 'he', name: 'Hebrew', nativeName: 'עברית' },
  { code: 'el', name: 'Greek', nativeName: 'Ελληνικά' },
  { code: 'uk', name: 'Ukrainian', nativeName: 'Українська' },
  { code: 'no', name: 'Norwegian', nativeName: 'Norsk' },
  { code: 'da', name: 'Danish', nativeName: 'Dansk' },
  { code: 'fi', name: 'Finnish', nativeName: 'Suomi' },
  { code: 'cs', name: 'Czech', nativeName: 'Čeština' },
  { code: 'ro', name: 'Romanian', nativeName: 'Română' },
  { code: 'hu', name: 'Hungarian', nativeName: 'Magyar' },
]
