/**
 * Factuality ratings for news sources.
 *
 * Data source: Media Bias/Fact Check (MBFC) public community ratings.
 * https://mediabiasfactcheck.com/
 *
 * Each source is keyed by its domain (lowercase, no www). The rating
 * includes a factuality score (Very Low → Very High) and a one-line
 * explanation.
 *
 * This data is static (stored in the repo). To update, edit this file.
 * No scraping or external API calls needed — the data is public and
 * rarely changes.
 *
 * If a source isn't in this map, the UI shows "Unrated" — never fabricate.
 */

export type FactualityScore =
  | 'Very High'
  | 'High'
  | 'Mostly Factual'
  | 'Mixed'
  | 'Low'
  | 'Very Low'

export interface SourceRating {
  /** Factuality score from MBFC */
  factuality: FactualityScore
  /** One-line explanation of what the score means */
  explanation: string
  /** Ownership info (if known) — company or parent organization */
  ownership?: string
}

/**
 * Map of source domain → rating.
 * Domains are lowercase, no leading www.
 */
const SOURCE_RATINGS: Record<string, SourceRating> = {
  // ── LEFT ──
  'theguardian.com': {
    factuality: 'High',
    explanation: 'Well-sourced, thorough reporting with a left-leaning editorial stance.',
    ownership: 'Scott Trust Limited (non-profit)',
  },
  'nytimes.com': {
    factuality: 'High',
    explanation: 'Rigorous fact-checking and sourcing, with a left-leaning editorial board.',
    ownership: 'The New York Times Company',
  },
  'washingtonpost.com': {
    factuality: 'High',
    explanation: 'Strong investigative reporting, left-leaning editorial position.',
    ownership: 'Nash Holdings (Jeff Bezos)',
  },
  'cnn.com': {
    factuality: 'Mostly Factual',
    explanation: 'Generally factual news with left-leaning framing and commentary.',
    ownership: 'Warner Bros. Discovery',
  },
  'msnbc.com': {
    factuality: 'Mixed',
    explanation: 'News mixed with significant left-leaning opinion and commentary.',
    ownership: 'NBCUniversal (Comcast)',
  },
  'nbcnews.com': {
    factuality: 'High',
    explanation: 'Straightforward news reporting with a slight left lean.',
    ownership: 'NBCUniversal (Comcast)',
  },
  'cnbc.com': {
    factuality: 'High',
    explanation: 'Business-focused, factual reporting with minimal bias.',
    ownership: 'NBCUniversal (Comcast)',
  },
  'abcnews.go.com': {
    factuality: 'High',
    explanation: 'Factual reporting with a slight left lean in story selection.',
    ownership: 'The Walt Disney Company',
  },
  'cbsnews.com': {
    factuality: 'High',
    explanation: 'Straightforward factual reporting.',
    ownership: 'Paramount Global',
  },
  'huffpost.com': {
    factuality: 'Mixed',
    explanation: 'News with strong left-leaning commentary and advocacy.',
    ownership: 'BuzzFeed, Inc.',
  },
  'huffingtonpost.co.uk': {
    factuality: 'Mixed',
    explanation: 'News with strong left-leaning commentary.',
    ownership: 'BuzzFeed, Inc.',
  },
  'vox.com': {
    factuality: 'Mostly Factual',
    explanation: 'Explanatory journalism with a left-leaning perspective.',
    ownership: 'Vox Media',
  },
  'salon.com': {
    factuality: 'Mixed',
    explanation: 'Left-leaning opinion and analysis site.',
    ownership: 'Salon Media Group',
  },
  'rawstory.com': {
    factuality: 'Mixed',
    explanation: 'Left-leaning news with occasional unverified claims.',
    ownership: 'Raw Story Media, Inc.',
  },
  'commondreams.org': {
    factuality: 'Mixed',
    explanation: 'Progressive advocacy site with factual news and opinion.',
    ownership: 'Common Dreams (non-profit)',
  },
  'motherjones.com': {
    factuality: 'Mostly Factual',
    explanation: 'Progressive investigative journalism.',
    ownership: 'Foundation for National Progress (non-profit)',
  },
  'slate.com': {
    factuality: 'Mostly Factual',
    explanation: 'Left-leaning cultural and political commentary.',
    ownership: 'The Slate Group, LLC',
  },
  'theatlantic.com': {
    factuality: 'High',
    explanation: 'In-depth, well-sourced journalism with a slight left lean.',
    ownership: 'The Atlantic Monthly Group',
  },
  'newyorker.com': {
    factuality: 'High',
    explanation: 'Long-form, rigorously fact-checked journalism.',
    ownership: 'Condé Nast (Advance Publications)',
  },
  'propublica.org': {
    factuality: 'High',
    explanation: 'Non-profit investigative journalism with rigorous fact-checking.',
    ownership: 'ProPublica (non-profit)',
  },

  // ── CENTER ──
  'reuters.com': {
    factuality: 'Very High',
    explanation: 'Wire service with rigorous fact-checking and neutral reporting.',
    ownership: 'Thomson Reuters',
  },
  'apnews.com': {
    factuality: 'Very High',
    explanation: 'Wire service known for neutral, factual reporting.',
    ownership: 'Associated Press (non-profit cooperative)',
  },
  'bbc.co.uk': {
    factuality: 'High',
    explanation: 'Public broadcaster with editorial independence and high standards.',
    ownership: 'BBC (publicly funded)',
  },
  'bbc.com': {
    factuality: 'High',
    explanation: 'Public broadcaster with editorial independence and high standards.',
    ownership: 'BBC (publicly funded)',
  },
  'aljazeera.com': {
    factuality: 'High',
    explanation: 'State-funded broadcaster with factual reporting, varied editorial stance.',
    ownership: 'Al Jazeera Media Network (Qatar government-funded)',
  },
  'france24.com': {
    factuality: 'High',
    explanation: 'State-funded international news with factual reporting.',
    ownership: 'France Médias Monde (French government)',
  },
  'dw.com': {
    factuality: 'High',
    explanation: 'German public international broadcaster, factual reporting.',
    ownership: 'Deutsche Welle (German government-funded)',
  },
  'thehill.com': {
    factuality: 'High',
    explanation: 'Political news with factual reporting and balanced commentary.',
    ownership: 'Nexstar Media Group',
  },
  'ft.com': {
    factuality: 'High',
    explanation: 'Financial Times — rigorous business and political reporting.',
    ownership: 'Nikkei, Inc.',
  },
  'economist.com': {
    factuality: 'High',
    explanation: 'In-depth analysis with a classical liberal editorial stance.',
    ownership: 'The Economist Group',
  },
  'thetimes.co.uk': {
    factuality: 'High',
    explanation: 'The Times of London — factual reporting with a center-right editorial.',
    ownership: 'News UK (News Corp)',
  },
  'independent.co.uk': {
    factuality: 'Mostly Factual',
    explanation: 'UK news with factual reporting and a centrist-to-left editorial.',
    ownership: 'Independent Digital News & Media',
  },
  'skynews.com': {
    factuality: 'High',
    explanation: 'UK news broadcaster with factual reporting.',
    ownership: 'Sky Group (Comcast)',
  },
  'standard.co.uk': {
    factuality: 'Mostly Factual',
    explanation: 'London Evening Standard — regional UK news.',
    ownership: 'Evening Standard Limited',
  },
  'japantimes.co.jp': {
    factuality: 'High',
    explanation: 'English-language Japanese newspaper, factual reporting.',
    ownership: 'Nifco',
  },
  'lemonde.fr': {
    factuality: 'High',
    explanation: 'French daily newspaper with rigorous fact-checking.',
    ownership: 'Le Monde Libre',
  },

  // ── RIGHT ──
  'foxnews.com': {
    factuality: 'Mixed',
    explanation: 'News with significant right-leaning commentary and opinion.',
    ownership: 'Fox Corporation',
  },
  'breitbart.com': {
    factuality: 'Mixed',
    explanation: 'Right-leaning news and opinion site.',
    ownership: 'Breitbart News Network, LLC',
  },
  'nypost.com': {
    factuality: 'Mixed',
    explanation: 'New York Post — tabloid with right-leaning editorial.',
    ownership: 'News Corp (Murdoch)',
  },
  'dailymail.co.uk': {
    factuality: 'Mixed',
    explanation: 'UK tabloid with right-leaning editorial, occasional sensationalism.',
    ownership: 'Daily Mail and General Trust',
  },
  'express.co.uk': {
    factuality: 'Mixed',
    explanation: 'UK tabloid with right-leaning editorial.',
    ownership: 'Reach plc',
  },
  'telegraph.co.uk': {
    factuality: 'High',
    explanation: 'The Daily Telegraph — factual reporting with center-right editorial.',
    ownership: 'Telegraph Media Group',
  },
  'wsj.com': {
    factuality: 'High',
    explanation: 'Wall Street Journal — rigorous reporting, center-right editorial board.',
    ownership: 'News Corp (Murdoch)',
  },
  'nationalreview.com': {
    factuality: 'Mostly Factual',
    explanation: 'Conservative opinion and analysis magazine.',
    ownership: 'National Review Institute',
  },
  'theblaze.com': {
    factuality: 'Mixed',
    explanation: 'Right-leaning news and opinion.',
    ownership: 'Blaze Media',
  },
  'dailywire.com': {
    factuality: 'Mixed',
    explanation: 'Conservative news and opinion site.',
    ownership: 'Daily Wire, LLC',
  },
  'washingtonexaminer.com': {
    factuality: 'Mostly Factual',
    explanation: 'Conservative news and opinion.',
    ownership: 'Clarity Media Group',
  },
  'washington Times': {
    factuality: 'Mostly Factual',
    explanation: 'Conservative newspaper with factual reporting.',
    ownership: 'News World Communications',
  },
  'washingtontimes.com': {
    factuality: 'Mostly Factual',
    explanation: 'Conservative newspaper with factual reporting.',
    ownership: 'News World Communications',
  },
  'rt.com': {
    factuality: 'Low',
    explanation: 'State-funded Russian broadcaster with significant propaganda.',
    ownership: 'Russian government',
  },
}

/**
 * Map of source IDs (the short names used in news-sources.ts, e.g.
 * 'theguardian', 'bbc', 'foxnews') to their domains for rating lookup.
 * This is needed because the TopicArticle's sourceId is the short name,
 * not the domain.
 */
const SOURCE_ID_TO_DOMAIN: Record<string, string> = {
  theguardian: 'theguardian.com',
  bbc: 'bbc.co.uk',
  nytimes: 'nytimes.com',
  washingtonpost: 'washingtonpost.com',
  cnn: 'cnn.com',
  msnbc: 'msnbc.com',
  nbcnews: 'nbcnews.com',
  cnbc: 'cnbc.com',
  abcnews: 'abcnews.go.com',
  cbsnews: 'cbsnews.com',
  huffpost: 'huffpost.com',
  vox: 'vox.com',
  salon: 'salon.com',
  rawstory: 'rawstory.com',
  commondreams: 'commondreams.org',
  motherjones: 'motherjones.com',
  slate: 'slate.com',
  theatlantic: 'theatlantic.com',
  newyorker: 'newyorker.com',
  propublica: 'propublica.org',
  reuters: 'reuters.com',
  ap: 'apnews.com',
  'reuters-algolia': 'reuters.com',
  aljazeera: 'aljazeera.com',
  france24: 'france24.com',
  dw: 'dw.com',
  thehill: 'thehill.com',
  ft: 'ft.com',
  economist: 'economist.com',
  thetimes: 'thetimes.co.uk',
  independent: 'independent.co.uk',
  skynews: 'skynews.com',
  standard: 'standard.co.uk',
  japantimes: 'japantimes.co.jp',
  lemonde: 'lemonde.fr',
  foxnews: 'foxnews.com',
  breitbart: 'breitbart.com',
  nypost: 'nypost.com',
  dailymail: 'dailymail.co.uk',
  express: 'express.co.uk',
  telegraph: 'telegraph.co.uk',
  wsj: 'wsj.com',
  nationalreview: 'nationalreview.com',
  theblaze: 'theblaze.com',
  dailywire: 'dailywire.com',
  washingtonexaminer: 'washingtonexaminer.com',
  washingtontimes: 'washingtontimes.com',
  rt: 'rt.com',
}

/**
 * Map of source display names (e.g. "The Guardian", "BBC") to domains.
 * Used as a fallback when neither domain nor sourceId matches.
 */
const SOURCE_NAME_TO_DOMAIN: Record<string, string> = {
  'the guardian': 'theguardian.com',
  'bbc': 'bbc.co.uk',
  'the new york times': 'nytimes.com',
  'new york times': 'nytimes.com',
  'washington post': 'washingtonpost.com',
  'cnn': 'cnn.com',
  'msnbc': 'msnbc.com',
  'nbc news': 'nbcnews.com',
  'cnbc': 'cnbc.com',
  'abc news': 'abcnews.go.com',
  'cbs news': 'cbsnews.com',
  'huffpost': 'huffpost.com',
  'vox': 'vox.com',
  'reuters': 'reuters.com',
  'associated press': 'apnews.com',
  'ap': 'apnews.com',
  'al jazeera': 'aljazeera.com',
  'france 24': 'france24.com',
  'deutsche welle': 'dw.com',
  'the hill': 'thehill.com',
  'financial times': 'ft.com',
  'the economist': 'economist.com',
  'the times': 'thetimes.co.uk',
  'the independent': 'independent.co.uk',
  'independent': 'independent.co.uk',
  'sky news': 'skynews.com',
  'evening standard': 'standard.co.uk',
  'japan times': 'japantimes.co.jp',
  'le monde': 'lemonde.fr',
  'fox news': 'foxnews.com',
  'breitbart': 'breitbart.com',
  'new york post': 'nypost.com',
  'daily mail': 'dailymail.co.uk',
  'daily express': 'express.co.uk',
  'the telegraph': 'telegraph.co.uk',
  'wall street journal': 'wsj.com',
  'national review': 'nationalreview.com',
  'the blaze': 'theblaze.com',
  'daily wire': 'dailywire.com',
  'rt': 'rt.com',
  'russia today': 'rt.com',
}

function normalizeDomain(domain: string): string {
  return domain.toLowerCase().replace(/^www\./, '').trim()
}

/**
 * Get the factuality rating for a source.
 * Tries multiple lookup strategies:
 *   1. Direct domain match (e.g. "theguardian.com")
 *   2. Source ID match (e.g. "theguardian" → "theguardian.com")
 *   3. Source name match (e.g. "The Guardian" → "theguardian.com")
 *   4. Parent domain match (e.g. "www.sub.bbc.co.uk" → "bbc.co.uk")
 * Returns null if the source isn't rated (never fabricate).
 */
export function getRating(sourceIdOrDomainOrName: string): SourceRating | null {
  if (!sourceIdOrDomainOrName) return null
  const input = sourceIdOrDomainOrName.toLowerCase().trim()

  // 1. Try direct domain match
  const normalized = normalizeDomain(input)
  if (SOURCE_RATINGS[normalized]) return SOURCE_RATINGS[normalized]

  // 2. Try source ID → domain mapping
  const domainFromId = SOURCE_ID_TO_DOMAIN[input]
  if (domainFromId && SOURCE_RATINGS[domainFromId]) {
    return SOURCE_RATINGS[domainFromId]
  }

  // 3. Try source name → domain mapping
  const domainFromName = SOURCE_NAME_TO_DOMAIN[input]
  if (domainFromName && SOURCE_RATINGS[domainFromName]) {
    return SOURCE_RATINGS[domainFromName]
  }

  // 4. Try parent domain match (e.g. www.sub.bbc.co.uk → bbc.co.uk)
  for (const [key, rating] of Object.entries(SOURCE_RATINGS)) {
    if (normalized === key || normalized.endsWith('.' + key)) {
      return rating
    }
  }

  return null
}

/**
 * Get a color class for a factuality score (for badges).
 */
export function factualityColor(score: FactualityScore): string {
  switch (score) {
    case 'Very High':
      return 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30'
    case 'High':
      return 'bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30'
    case 'Mostly Factual':
      return 'bg-lime-500/15 text-lime-600 dark:text-lime-400 border-lime-500/30'
    case 'Mixed':
      return 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30'
    case 'Low':
      return 'bg-orange-500/15 text-orange-600 dark:text-orange-400 border-orange-500/30'
    case 'Very Low':
      return 'bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30'
    default:
      return 'bg-muted text-muted-foreground border-border'
  }
}
