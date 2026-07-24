/**
 * News source registry.
 *
 * Each source has:
 *  - id (slug)
 *  - name
 *  - homepage URL
 *  - RSS feed URLs
 *  - political leaning: 'left' | 'center' | 'right'
 *   (Roughly calibrated against AllSides / Media Bias Fact Check public ratings.
 *    These are best-effort community approximations, not authoritative.)
 *  - country code for the originating outlet
 *  - categories: which topic feeds to subscribe to
 *
 * All feeds below are free public RSS endpoints. No API key required.
 */

export type Leaning = 'left' | 'center' | 'right'

export interface NewsSource {
  id: string
  name: string
  homepage: string
  leaning: Leaning
  country: string
  /** RSS feed URLs belonging to this outlet. */
  feeds: { url: string; category: string }[]
}

/**
 * Categories that map to user-visible sections.
 * Each source's feeds carry one of these categories.
 *
 * `relevant` and `mycountry` are *virtual* categories — they don't appear
 * in source feed definitions. Instead they're computed at request time
 * based on the visitor's detected country:
 *   - `mycountry`: only feeds from sources relevant to the visitor's country
 *   - `relevant`: a mix — local feeds PLUS global `top` and `world` feeds,
 *     with local stories prioritised in clustering.
 */
export const CATEGORIES = [
  'relevant',
  'mycountry',
  'top',
  'world',
  'politics',
  'business',
  'technology',
  'science',
  'health',
  'sports',
] as const

export type Category = (typeof CATEGORIES)[number]

export const CATEGORY_LABELS: Record<Category, string> = {
  relevant: 'Relevant',
  mycountry: 'My Country',
  top: 'Top Stories',
  world: 'World',
  politics: 'Politics',
  business: 'Business',
  technology: 'Tech',
  science: 'Science',
  health: 'Health',
  sports: 'Sports',
}

/**
 * The "main" categories shown as primary tabs.
 * `top`/`world`/etc. are shown under "More".
 */
export const PRIMARY_CATEGORIES: Category[] = ['relevant', 'mycountry']
export const SECONDARY_CATEGORIES: Category[] = [
  'top',
  'world',
  'politics',
  'business',
  'technology',
  'science',
  'health',
  'sports',
]

export const NEWS_SOURCES: NewsSource[] = [
  // ---------- LEFT ----------
  {
    id: 'theguardian',
    name: 'The Guardian',
    homepage: 'https://www.theguardian.com',
    leaning: 'left',
    country: 'UK',
    feeds: [
      { url: 'https://www.theguardian.com/world/rss', category: 'world' },
      { url: 'https://www.theguardian.com/us-news/rss', category: 'top' },
      { url: 'https://www.theguardian.com/us-news/rss', category: 'politics' },
      { url: 'https://www.theguardian.com/politics/rss', category: 'politics' },
      { url: 'https://www.theguardian.com/business/rss', category: 'business' },
      { url: 'https://www.theguardian.com/technology/rss', category: 'technology' },
      { url: 'https://www.theguardian.com/science/rss', category: 'science' },
      { url: 'https://www.theguardian.com/sport/rss', category: 'sports' },
      { url: 'https://www.theguardian.com/football/rss', category: 'sports' },
      { url: 'https://www.theguardian.com/sport/cricket/rss', category: 'sports' },
      { url: 'https://www.theguardian.com/sport/rugby-union/rss', category: 'sports' },
      { url: 'https://www.theguardian.com/sport/tennis/rss', category: 'sports' },
      { url: 'https://www.theguardian.com/sport/formulaone/rss', category: 'sports' },
    ],
  },
  {
    id: 'nbcnews',
    name: 'NBC News',
    homepage: 'https://www.nbcnews.com',
    leaning: 'left',
    country: 'US',
    feeds: [
      { url: 'https://feeds.nbcnews.com/nbcnews/public/news', category: 'top' },
      { url: 'https://feeds.nbcnews.com/health-topics.xml', category: 'health' },
      { url: 'https://feeds.nbcnews.com/rss/features/business/', category: 'business' },
    ],
  },
  {
    id: 'cnn',
    name: 'CNN',
    homepage: 'https://www.cnn.com',
    leaning: 'left',
    country: 'US',
    feeds: [
      { url: 'http://rss.cnn.com/rss/edition_world.rss', category: 'world' },
      { url: 'http://rss.cnn.com/rss/edition.rss', category: 'top' },
      { url: 'http://rss.cnn.com/rss/edition_politics.rss', category: 'politics' },
      { url: 'http://rss.cnn.com/rss/money_news_international.rss', category: 'business' },
      { url: 'http://rss.cnn.com/rss/edition_technology.rss', category: 'technology' },
      { url: 'http://rss.cnn.com/rss/edition_space.rss', category: 'science' },
      { url: 'http://rss.cnn.com/rss/edition_health.rss', category: 'health' },
    ],
  },
  {
    id: 'vox',
    name: 'Vox',
    homepage: 'https://www.vox.com',
    leaning: 'left',
    country: 'US',
    feeds: [
      { url: 'https://www.vox.com/rss/index.xml', category: 'top' },
      { url: 'https://www.vox.com/rss/policy-and-politics/index.xml', category: 'politics' },
    ],
  },
  {
    id: 'huffpost',
    name: 'HuffPost',
    homepage: 'https://www.huffpost.com',
    leaning: 'left',
    country: 'US',
    feeds: [
      { url: 'https://www.huffpost.com/section/world-news/feed', category: 'world' },
    ],
  },
  {
    id: 'msnbc',
    name: 'MSNBC',
    homepage: 'https://www.msnbc.com',
    leaning: 'left',
    country: 'US',
    feeds: [
      { url: 'https://www.msnbc.com/feeds/latest', category: 'top' },
    ],
  },
  {
    id: 'salon',
    name: 'Salon',
    homepage: 'https://www.salon.com',
    leaning: 'left',
    country: 'US',
    feeds: [{ url: 'https://www.salon.com/feed/', category: 'top' }],
  },
  {
    id: 'rawstory',
    name: 'Raw Story',
    homepage: 'https://www.rawstory.com',
    leaning: 'left',
    country: 'US',
    feeds: [{ url: 'https://www.rawstory.com/feed/', category: 'top' }],
  },
  {
    id: 'commondreams',
    name: 'Common Dreams',
    homepage: 'https://www.commondreams.org',
    leaning: 'left',
    country: 'US',
    feeds: [{ url: 'https://www.commondreams.org/rss.xml', category: 'politics' }],
  },
  {
    id: 'democracynow',
    name: 'Democracy Now!',
    homepage: 'https://www.democracynow.org',
    leaning: 'left',
    country: 'US',
    feeds: [{ url: 'https://www.democracynow.org/democracynow.rss.xml', category: 'top' }],
  },
  {
    id: 'latimes',
    name: 'Los Angeles Times',
    homepage: 'https://www.latimes.com',
    leaning: 'left',
    country: 'US',
    feeds: [
      { url: 'https://www.latimes.com/world-nation/rss2.xml', category: 'world' },
      { url: 'https://www.latimes.com/politics/rss2.xml', category: 'politics' },
      { url: 'https://www.latimes.com/business/rss2.xml', category: 'business' },
      { url: 'https://www.latimes.com/science/rss2.xml', category: 'science' },
    ],
  },

  // ---------- CENTER / BROAD ----------
  {
    id: 'bbc',
    name: 'BBC News',
    homepage: 'https://www.bbc.com/news',
    leaning: 'center',
    country: 'UK',
    feeds: [
      { url: 'https://feeds.bbci.co.uk/news/rss.xml', category: 'top' },
      { url: 'https://feeds.bbci.co.uk/news/world/rss.xml', category: 'world' },
      { url: 'https://feeds.bbci.co.uk/news/uk/rss.xml', category: 'world' },
      { url: 'https://feeds.bbci.co.uk/news/politics/rss.xml', category: 'politics' },
      { url: 'https://feeds.bbci.co.uk/news/business/rss.xml', category: 'business' },
      { url: 'https://feeds.bbci.co.uk/news/technology/rss.xml', category: 'technology' },
      { url: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml', category: 'science' },
      { url: 'https://feeds.bbci.co.uk/news/health/rss.xml', category: 'health' },
      { url: 'https://feeds.bbci.co.uk/sport/rss.xml', category: 'sports' },
      { url: 'https://feeds.bbci.co.uk/sport/football/rss.xml', category: 'sports' },
      { url: 'https://feeds.bbci.co.uk/sport/cricket/rss.xml', category: 'sports' },
      { url: 'https://feeds.bbci.co.uk/sport/rugby-union/rss.xml', category: 'sports' },
      { url: 'https://feeds.bbci.co.uk/sport/tennis/rss.xml', category: 'sports' },
      { url: 'https://feeds.bbci.co.uk/sport/formula1/rss.xml', category: 'sports' },
    ],
  },
  {
    id: 'reuters-algolia',
    name: 'Reuters (via Wired)',
    homepage: 'https://www.reuters.com',
    leaning: 'center',
    country: 'UK',
    feeds: [],
  },
  {
    id: 'nytimes',
    name: 'The New York Times',
    homepage: 'https://www.nytimes.com',
    leaning: 'left',
    country: 'US',
    feeds: [
      { url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', category: 'world' },
      { url: 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml', category: 'top' },
      { url: 'https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml', category: 'politics' },
      { url: 'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml', category: 'business' },
      { url: 'https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml', category: 'technology' },
      { url: 'https://rss.nytimes.com/services/xml/rss/nyt/Science.xml', category: 'science' },
      { url: 'https://rss.nytimes.com/services/xml/rss/nyt/Health.xml', category: 'health' },
      { url: 'https://rss.nytimes.com/services/xml/rss/nyt/Sports.xml', category: 'sports' },
    ],
  },
  {
    id: 'washingtonpost',
    name: 'The Washington Post',
    homepage: 'https://www.washingtonpost.com',
    leaning: 'left',
    country: 'US',
    feeds: [],
  },
  {
    id: 'abcnews',
    name: 'ABC News',
    homepage: 'https://abcnews.go.com',
    leaning: 'center',
    country: 'US',
    feeds: [{ url: 'https://feeds.abcnews.com/abcnews/topstories', category: 'top' }],
  },
  {
    id: 'npr',
    name: 'NPR',
    homepage: 'https://www.npr.org',
    leaning: 'center',
    country: 'US',
    feeds: [
      { url: 'https://www.npr.org/rss/rss.php?id=1001', category: 'top' },
      { url: 'https://www.npr.org/rss/rss.php?id=1004', category: 'world' },
      { url: 'https://www.npr.org/rss/rss.php?id=1014', category: 'politics' },
      { url: 'https://www.npr.org/rss/rss.php?id=1006', category: 'business' },
      { url: 'https://www.npr.org/rss/rss.php?id=1009', category: 'technology' },
      { url: 'https://www.npr.org/rss/rss.php?id=1007', category: 'science' },
      { url: 'https://www.npr.org/rss/rss.php?id=1128', category: 'health' },
    ],
  },
  {
    id: 'cnbc',
    name: 'CNBC',
    homepage: 'https://www.cnbc.com',
    leaning: 'center',
    country: 'US',
    feeds: [
      { url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', category: 'top' },
      { url: 'https://www.cnbc.com/id/10001147/device/rss/rss.html', category: 'business' },
      { url: 'https://www.cnbc.com/id/10000664/device/rss/rss.html', category: 'technology' },
      { url: 'https://www.cnbc.com/id/100727362/device/rss/rss.html', category: 'politics' },
    ],
  },
  {
    id: 'marketwatch',
    name: 'MarketWatch',
    homepage: 'https://www.marketwatch.com',
    leaning: 'center',
    country: 'US',
    feeds: [{ url: 'https://feeds.marketwatch.com/marketwatch/topstories/', category: 'business' }],
  },
  {
    id: 'ft',
    name: 'Financial Times',
    homepage: 'https://www.ft.com',
    leaning: 'center',
    country: 'UK',
    feeds: [
      { url: 'https://www.ft.com/rss/home', category: 'top' },
      { url: 'https://www.ft.com/rss/world', category: 'world' },
      { url: 'https://www.ft.com/rss/companies', category: 'business' },
    ],
  },
  {
    id: 'thehill',
    name: 'The Hill',
    homepage: 'https://thehill.com',
    leaning: 'center',
    country: 'US',
    feeds: [{ url: 'https://thehill.com/feed/', category: 'politics' }],
  },
  {
    id: 'newyorker',
    name: 'The New Yorker',
    homepage: 'https://www.newyorker.com',
    leaning: 'left',
    country: 'US',
    feeds: [{ url: 'https://www.newyorker.com/feed/everything', category: 'top' }],
  },
  {
    id: 'economist',
    name: 'The Economist',
    homepage: 'https://www.economist.com',
    leaning: 'center',
    country: 'UK',
    feeds: [
      { url: 'https://www.economist.com/the-world-this-week/rss.xml', category: 'world' },
      { url: 'https://www.economist.com/finance-and-economics/rss.xml', category: 'business' },
    ],
  },

  // ---------- RIGHT ----------
  {
    id: 'foxnews',
    name: 'Fox News',
    homepage: 'https://www.foxnews.com',
    leaning: 'right',
    country: 'US',
    feeds: [
      { url: 'https://feeds.foxnews.com/foxnews/fox-news/politics', category: 'politics' },
      { url: 'https://feeds.foxnews.com/foxnews/world', category: 'world' },
      { url: 'https://feeds.foxnews.com/foxnews/national', category: 'top' },
      { url: 'https://feeds.foxnews.com/foxnews/scitech', category: 'science' },
      { url: 'https://feeds.foxnews.com/foxnews/health', category: 'health' },
      { url: 'https://feeds.foxnews.com/foxnews/sports', category: 'sports' },
    ],
  },
  {
    id: 'breitbart',
    name: 'Breitbart',
    homepage: 'https://www.breitbart.com',
    leaning: 'right',
    country: 'US',
    feeds: [
      { url: 'https://feeds.feedburner.com/breitbart', category: 'top' },
      { url: 'https://www.breitbart.com/feed/', category: 'top' },
    ],
  },
  {
    id: 'nationalreview',
    name: 'National Review',
    homepage: 'https://www.nationalreview.com',
    leaning: 'right',
    country: 'US',
    feeds: [{ url: 'https://www.nationalreview.com/feed/', category: 'politics' }],
  },
  {
    id: 'theblaze',
    name: 'The Blaze',
    homepage: 'https://www.theblaze.com',
    leaning: 'right',
    country: 'US',
    feeds: [{ url: 'https://www.theblaze.com/feed/', category: 'top' }],
  },
  {
    id: 'dailywire',
    name: 'The Daily Wire',
    homepage: 'https://www.dailywire.com',
    leaning: 'right',
    country: 'US',
    feeds: [{ url: 'https://www.dailywire.com/feed.xml', category: 'top' }],
  },
  {
    id: 'nypost',
    name: 'New York Post',
    homepage: 'https://nypost.com',
    leaning: 'right',
    country: 'US',
    feeds: [
      { url: 'https://nypost.com/feed/', category: 'top' },
      { url: 'https://nypost.com/news/feed/', category: 'world' },
      { url: 'https://nypost.com/politics/feed/', category: 'politics' },
      { url: 'https://nypost.com/business/feed/', category: 'business' },
      { url: 'https://nypost.com/tech/feed/', category: 'technology' },
    ],
  },

  // ---------- INTERNATIONAL ----------
  {
    id: 'aljazeera',
    name: 'Al Jazeera',
    homepage: 'https://www.aljazeera.com',
    leaning: 'center',
    country: 'QA',
    feeds: [{ url: 'https://www.aljazeera.com/xml/rss/all.xml', category: 'world' }],
  },
  {
    id: 'france24',
    name: 'France 24',
    homepage: 'https://www.france24.com',
    leaning: 'center',
    country: 'FR',
    feeds: [
      { url: 'https://www.france24.com/en/rss', category: 'world' },
      { url: 'https://www.france24.com/en/middle-east/rss', category: 'world' },
      { url: 'https://www.france24.com/en/americas/rss', category: 'world' },
      { url: 'https://www.france24.com/en/asia-pacific/rss', category: 'world' },
      { url: 'https://www.france24.com/en/europe/rss', category: 'world' },
      { url: 'https://www.france24.com/en/africa/rss', category: 'world' },
    ],
  },
  {
    id: 'dw',
    name: 'Deutsche Welle',
    homepage: 'https://www.dw.com',
    leaning: 'center',
    country: 'DE',
    feeds: [{ url: 'https://rss.dw.com/rdf/rss-en-all', category: 'world' }],
  },
  {
    id: 'japantimes',
    name: 'The Japan Times',
    homepage: 'https://www.japantimes.co.jp',
    leaning: 'center',
    country: 'JP',
    feeds: [{ url: 'https://www.japantimes.co.jp/feed/', category: 'world' }],
  },
  {
    id: 'rt',
    name: 'RT',
    homepage: 'https://www.rt.com',
    leaning: 'right',
    country: 'RU',
    feeds: [{ url: 'https://www.rt.com/rss/news/', category: 'world' }],
  },
  {
    id: 'lemonde',
    name: 'Le Monde',
    homepage: 'https://www.lemonde.fr',
    leaning: 'left',
    country: 'FR',
    feeds: [{ url: 'https://www.lemonde.fr/international/rss_full.xml', category: 'world' }],
  },

  // ---------- UK-SPECIFIC SOURCES (for My Country GB) ----------
  {
    id: 'skynews',
    name: 'Sky News',
    homepage: 'https://news.sky.com',
    leaning: 'center',
    country: 'UK',
    feeds: [
      { url: 'https://feeds.skynews.com/feeds/rss/home.xml', category: 'top' },
      { url: 'https://feeds.skynews.com/feeds/rss/uk.xml', category: 'world' },
      { url: 'https://feeds.skynews.com/feeds/rss/politics.xml', category: 'politics' },
      { url: 'https://feeds.skynews.com/feeds/rss/business.xml', category: 'business' },
      { url: 'https://feeds.skynews.com/feeds/rss/technology.xml', category: 'technology' },
      { url: 'https://feeds.skynews.com/feeds/rss/strange.xml', category: 'world' },
      { url: 'https://feeds.skynews.com/feeds/rss/sport.xml', category: 'sports' },
    ],
  },
  {
    id: 'telegraph',
    name: 'The Telegraph',
    homepage: 'https://www.telegraph.co.uk',
    leaning: 'right',
    country: 'UK',
    feeds: [
      { url: 'https://www.telegraph.co.uk/rss.xml', category: 'top' },
      { url: 'https://www.telegraph.co.uk/news/rss', category: 'world' },
      { url: 'https://www.telegraph.co.uk/politics/rss', category: 'politics' },
      { url: 'https://www.telegraph.co.uk/business/rss', category: 'business' },
      { url: 'https://www.telegraph.co.uk/technology/rss', category: 'technology' },
      { url: 'https://www.telegraph.co.uk/science/rss', category: 'science' },
      { url: 'https://www.telegraph.co.uk/sport/rss', category: 'sports' },
    ],
  },
  {
    id: 'independent',
    name: 'The Independent',
    homepage: 'https://www.independent.co.uk',
    leaning: 'center',
    country: 'UK',
    feeds: [
      { url: 'https://www.independent.co.uk/news/uk/rss', category: 'world' },
      { url: 'https://www.independent.co.uk/news/world/rss', category: 'world' },
      { url: 'https://www.independent.co.uk/news/politics/rss', category: 'politics' },
      { url: 'https://www.independent.co.uk/news/business/rss', category: 'business' },
      { url: 'https://www.independent.co.uk/life-style/gadgets-and-tech/rss', category: 'technology' },
      { url: 'https://www.independent.co.uk/news/science/rss', category: 'science' },
      { url: 'https://www.independent.co.uk/news/health/rss', category: 'health' },
      { url: 'https://www.independent.co.uk/sport/rss', category: 'sports' },
      { url: 'https://www.independent.co.uk/sport/football/rss', category: 'sports' },
    ],
  },
  {
    id: 'dailymail',
    name: 'Daily Mail',
    homepage: 'https://www.dailymail.co.uk',
    leaning: 'right',
    country: 'UK',
    feeds: [
      { url: 'https://www.dailymail.co.uk/news/index.rss', category: 'top' },
      { url: 'https://www.dailymail.co.uk/news/worldnews/index.rss', category: 'world' },
      { url: 'https://www.dailymail.co.uk/news/politics/index.rss', category: 'politics' },
      { url: 'https://www.dailymail.co.uk/money/index.rss', category: 'business' },
      { url: 'https://www.dailymail.co.uk/sciencetech/index.rss', category: 'science' },
      { url: 'https://www.dailymail.co.uk/health/index.rss', category: 'health' },
      { url: 'https://www.dailymail.co.uk/sport/index.rss', category: 'sports' },
      { url: 'https://www.dailymail.co.uk/sport/football/index.rss', category: 'sports' },
    ],
  },
  {
    id: 'mirror',
    name: 'Daily Mirror',
    homepage: 'https://www.mirror.co.uk',
    leaning: 'left',
    country: 'UK',
    feeds: [
      { url: 'https://www.mirror.co.uk/news/?service=rss', category: 'top' },
      { url: 'https://www.mirror.co.uk/news/uk-news/?service=rss', category: 'world' },
      { url: 'https://www.mirror.co.uk/news/politics/?service=rss', category: 'politics' },
      { url: 'https://www.mirror.co.uk/sport/?service=rss', category: 'sports' },
      { url: 'https://www.mirror.co.uk/sport/football/?service=rss', category: 'sports' },
    ],
  },
  {
    id: 'standard',
    name: 'Evening Standard',
    homepage: 'https://www.standard.co.uk',
    leaning: 'center',
    country: 'UK',
    feeds: [
      { url: 'https://www.standard.co.uk/rss.xml', category: 'top' },
      { url: 'https://www.standard.co.uk/news/politics/rss.xml', category: 'politics' },
      { url: 'https://www.standard.co.uk/business/rss.xml', category: 'business' },
      { url: 'https://www.standard.co.uk/tech/rss.xml', category: 'technology' },
    ],
  },
  {
    id: 'express',
    name: 'Daily Express',
    homepage: 'https://www.express.co.uk',
    leaning: 'right',
    country: 'UK',
    feeds: [
      { url: 'https://www.express.co.uk/posts/rss/1', category: 'top' },
      { url: 'https://www.express.co.uk/posts/rss/3', category: 'politics' },
      { url: 'https://www.express.co.uk/posts/rss/24', category: 'business' },
    ],
  },
]

/**
 * Returns the list of sources filtered by a leaning.
 */
export function sourcesByLeaning(leaning: Leaning): NewsSource[] {
  return NEWS_SOURCES.filter((s) => s.leaning === leaning)
}

/**
 * Returns all RSS feed URLs that match a given category, with the source they belong to.
 *
 * For virtual categories (`relevant`, `mycountry`), the caller must pass a
 * `country` ISO code; we look up the relevant source IDs via
 * `sourcesForCountry()` from country-detect.ts. To avoid a circular import,
 * the source-id list is passed in directly.
 */
export function feedsForCategory(
  category: Category,
  options: { countrySourceIds?: string[] } = {},
): { url: string; source: NewsSource; feedCategory: string }[] {
  const out: { url: string; source: NewsSource; feedCategory: string }[] = []
  const countryIds = new Set(options.countrySourceIds ?? [])

  for (const source of NEWS_SOURCES) {
    for (const feed of source.feeds) {
      // `top` is a catch-all — every feed's first category counts.
      if (category === 'top') {
        out.push({ url: feed.url, source, feedCategory: feed.category })
        continue
      }

      // `mycountry`: only feeds from sources relevant to the visitor's country.
      if (category === 'mycountry') {
        if (countryIds.has(source.id)) {
          out.push({ url: feed.url, source, feedCategory: 'mycountry' })
        }
        continue
      }

      // `relevant`: local feeds PLUS global top/world feeds.
      // Local sources contribute all their feeds; international sources
      // contribute only their `top` and `world` feeds.
      if (category === 'relevant') {
        if (countryIds.has(source.id)) {
          out.push({ url: feed.url, source, feedCategory: 'local' })
        } else if (feed.category === 'top' || feed.category === 'world') {
          out.push({ url: feed.url, source, feedCategory: feed.category })
        }
        continue
      }

      if (feed.category === category) {
        out.push({ url: feed.url, source, feedCategory: feed.category })
      }
    }
  }
  return out
}

export const LEANING_META: Record<
  Leaning,
  { label: string; color: string; bg: string; text: string }
> = {
  left: { label: 'Left', color: '#2563eb', bg: 'bg-blue-500', text: 'text-blue-600' },
  center: { label: 'Center', color: '#71717a', bg: 'bg-zinc-500', text: 'text-zinc-600' },
  right: { label: 'Right', color: '#dc2626', bg: 'bg-red-500', text: 'text-red-600' },
}
