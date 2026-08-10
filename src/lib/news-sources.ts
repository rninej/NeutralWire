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
  'blindspots',
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
  blindspots: 'Blindspots',
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
  'blindspots',
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

  // ---------- ADDITIONAL SOURCES (more coverage = more sources per topic) ----------

  // ── CENTER (international + wire services) ──
  {
    id: 'ap',
    name: 'Associated Press',
    homepage: 'https://apnews.com',
    leaning: 'center',
    country: 'US',
    feeds: [
      { url: 'https://feeds.apnews.com/rss/apf-topnews', category: 'top' },
      { url: 'https://feeds.apnews.com/apf-worldnews', category: 'world' },
      { url: 'https://feeds.apnews.com/apf-politics', category: 'politics' },
      { url: 'https://feeds.apnews.com/apf-business', category: 'business' },
      { url: 'https://feeds.apnews.com/apf-technology', category: 'technology' },
      { url: 'https://feeds.apnews.com/apf-health', category: 'health' },
      { url: 'https://feeds.apnews.com/apf-sports', category: 'sports' },
    ],
  },
  {
    id: 'reuters-world',
    name: 'Reuters World',
    homepage: 'https://www.reuters.com',
    leaning: 'center',
    country: 'GB',
    feeds: [
      { url: 'https://www.reutersagency.com/feed/?best-topics=top-news&post_type=best', category: 'top' },
      { url: 'https://www.reutersagency.com/feed/?best-topics=political&post_type=best', category: 'politics' },
      { url: 'https://www.reutersagency.com/feed/?best-topics=business-finance&post_type=best', category: 'business' },
      { url: 'https://www.reutersagency.com/feed/?best-topics=technology&post_type=best', category: 'technology' },
      { url: 'https://www.reutersagency.com/feed/?best-topics=science&post_type=best', category: 'science' },
      { url: 'https://www.reutersagency.com/feed/?best-topics=health-news&post_type=best', category: 'health' },
      { url: 'https://www.reutersagency.com/feed/?best-topics=sports&post_type=best', category: 'sports' },
    ],
  },
  {
    id: 'afp',
    name: 'AFP News',
    homepage: 'https://www.afp.com',
    leaning: 'center',
    country: 'FR',
    feeds: [
      { url: 'https://www.afp.com/rss/rss.xml', category: 'top' },
    ],
  },
  {
    id: 'dw',
    name: 'Deutsche Welle',
    homepage: 'https://www.dw.com',
    leaning: 'center',
    country: 'DE',
    feeds: [
      { url: 'https://rss.dw.com/rdf/rss-en-top', category: 'top' },
      { url: 'https://rss.dw.com/rdf/rss-en-world', category: 'world' },
      { url: 'https://rss.dw.com/rdf/rss-en-bus', category: 'business' },
      { url: 'https://rss.dw.com/rdf/rss-en-sci', category: 'science' },
      { url: 'https://rss.dw.com/rdf/rss-en-spo', category: 'sports' },
    ],
  },
  {
    id: 'france24',
    name: 'France 24',
    homepage: 'https://www.france24.com',
    leaning: 'center',
    country: 'FR',
    feeds: [
      { url: 'https://www.france24.com/en/rss', category: 'top' },
      { url: 'https://www.france24.com/en/world/rss', category: 'world' },
      { url: 'https://www.france24.com/en/business/rss', category: 'business' },
      { url: 'https://www.france24.com/en/tech/rss', category: 'technology' },
      { url: 'https://www.france24.com/en/science/rss', category: 'science' },
    ],
  },
  {
    id: 'nhk',
    name: 'NHK World',
    homepage: 'https://www3.nhk.or.jp/nhkworld',
    leaning: 'center',
    country: 'JP',
    feeds: [
      { url: 'https://www3.nhk.or.jp/rss/news/cat0.xml', category: 'top' },
      { url: 'https://www3.nhk.or.jp/rss/news/cat5.xml', category: 'world' },
      { url: 'https://www3.nhk.or.jp/rss/news/cat4.xml', category: 'business' },
      { url: 'https://www3.nhk.or.jp/rss/news/cat7.xml', category: 'science' },
    ],
  },
  {
    id: 'scmp',
    name: 'South China Morning Post',
    homepage: 'https://www.scmp.com',
    leaning: 'center',
    country: 'HK',
    feeds: [
      { url: 'https://www.scmp.com/rss/91/feed', category: 'top' },
      { url: 'https://www.scmp.com/rss/5/feed', category: 'world' },
      { url: 'https://www.scmp.com/rss/4/feed', category: 'politics' },
      { url: 'https://www.scmp.com/rss/8/feed', category: 'business' },
      { url: 'https://www.scmp.com/rss/14/feed', category: 'technology' },
      { url: 'https://www.scmp.com/rss/96/feed', category: 'sports' },
    ],
  },
  {
    id: 'smh',
    name: 'Sydney Morning Herald',
    homepage: 'https://www.smh.com.au',
    leaning: 'center',
    country: 'AU',
    feeds: [
      { url: 'https://www.smh.com.au/rss/feed.xml', category: 'top' },
      { url: 'https://www.smh.com.au/rss/world.xml', category: 'world' },
      { url: 'https://www.smh.com.au/rss/business.xml', category: 'business' },
      { url: 'https://www.smh.com.au/rss/technology.xml', category: 'technology' },
      { url: 'https://www.smh.com.au/rss/sport.xml', category: 'sports' },
    ],
  },
  {
    id: 'globe-mail',
    name: 'The Globe and Mail',
    homepage: 'https://www.theglobeandmail.com',
    leaning: 'center',
    country: 'CA',
    feeds: [
      { url: 'https://www.theglobeandmail.com/arc/outboundfeeds/rss/category/top-stories/', category: 'top' },
      { url: 'https://www.theglobeandmail.com/arc/outboundfeeds/rss/category/world/', category: 'world' },
      { url: 'https://www.theglobeandmail.com/arc/outboundfeeds/rss/category/business/', category: 'business' },
      { url: 'https://www.theglobeandmail.com/arc/outboundfeeds/rss/category/technology/', category: 'technology' },
    ],
  },
  {
    id: 'al-arabiya',
    name: 'Al Arabiya English',
    homepage: 'https://english.alarabiya.net',
    leaning: 'center',
    country: 'AE',
    feeds: [
      { url: 'https://www.alarabiya.net/tools/rss', category: 'top' },
      { url: 'https://english.alarabiya.net/.rss.xml', category: 'world' },
    ],
  },
  {
    id: 'times-of-india',
    name: 'Times of India',
    homepage: 'https://timesofindia.indiatimes.com',
    leaning: 'center',
    country: 'IN',
    feeds: [
      { url: 'https://timesofindia.indiatimes.com/rssfeeds/-2128936835.cms', category: 'top' },
      { url: 'https://timesofindia.indiatimes.com/rssfeeds/2965892924.cms', category: 'world' },
      { url: 'https://timesofindia.indiatimes.com/rssfeeds/1898055.cms', category: 'politics' },
      { url: 'https://timesofindia.indiatimes.com/rssfeeds/2147478130.cms', category: 'business' },
      { url: 'https://timesofindia.indiatimes.com/rssfeeds/66956762.cms', category: 'technology' },
      { url: 'https://timesofindia.indiatimes.com/rssfeeds/-2128672765.cms', category: 'sports' },
    ],
  },
  {
    id: 'the-hindu',
    name: 'The Hindu',
    homepage: 'https://www.thehindu.com',
    leaning: 'center',
    country: 'IN',
    feeds: [
      { url: 'https://www.thehindu.com/news/national/feeder/default.rss', category: 'top' },
      { url: 'https://www.thehindu.com/news/international/feeder/default.rss', category: 'world' },
      { url: 'https://www.thehindu.com/news/national/feeder/default.rss', category: 'politics' },
      { url: 'https://www.thehindu.com/business/feeder/default.rss', category: 'business' },
      { url: 'https://www.thehindu.com/sci-tech/feeder/default.rss', category: 'technology' },
      { url: 'https://www.thehindu.com/sport/feeder/default.rss', category: 'sports' },
    ],
  },
  {
    id: 'ndtv',
    name: 'NDTV',
    homepage: 'https://www.ndtv.com',
    leaning: 'center',
    country: 'IN',
    feeds: [
      { url: 'https://www.ndtv.com/rss/top-stories', category: 'top' },
      { url: 'https://www.ndtv.com/rss/news', category: 'top' },
      { url: 'https://www.ndtv.com/rss/world-news', category: 'world' },
      { url: 'https://www.ndtv.com/rss/business', category: 'business' },
      { url: 'https://www.ndtv.com/rss/tech', category: 'technology' },
      { url: 'https://www.ndtv.com/rss/cricket', category: 'sports' },
      { url: 'https://www.ndtv.com/rss/sports', category: 'sports' },
    ],
  },
  {
    id: 'indian-express',
    name: 'The Indian Express',
    homepage: 'https://indianexpress.com',
    leaning: 'center',
    country: 'IN',
    feeds: [
      { url: 'https://indianexpress.com/feed', category: 'top' },
      { url: 'https://indianexpress.com/section/world/feed', category: 'world' },
      { url: 'https://indianexpress.com/section/business/feed', category: 'business' },
      { url: 'https://indianexpress.com/section/technology/feed', category: 'technology' },
      { url: 'https://indianexpress.com/section/sports/feed', category: 'sports' },
    ],
  },
  {
    id: 'hindustan-times',
    name: 'Hindustan Times',
    homepage: 'https://www.hindustantimes.com',
    leaning: 'center',
    country: 'IN',
    feeds: [
      { url: 'https://www.hindustantimes.com/feeds/rss/india-news/news', category: 'top' },
      { url: 'https://www.hindustantimes.com/feeds/rss/world-news/news', category: 'world' },
      { url: 'https://www.hindustantimes.com/feeds/rss/business/news', category: 'business' },
      { url: 'https://www.hindustantimes.com/feeds/rss/tech/news', category: 'technology' },
      { url: 'https://www.hindustantimes.com/feeds/rss/sports/news', category: 'sports' },
    ],
  },
  {
    id: 'economic-times',
    name: 'The Economic Times',
    homepage: 'https://economictimes.indiatimes.com',
    leaning: 'center',
    country: 'IN',
    feeds: [
      { url: 'https://economictimes.indiatimes.com/rssfeeds/-2128936835.cms', category: 'top' },
      { url: 'https://economictimes.indiatimes.com/rssfeeds/2965892924.cms', category: 'world' },
      { url: 'https://economictimes.indiatimes.com/rssfeeds/2147478130.cms', category: 'business' },
      { url: 'https://economictimes.indiatimes.com/rssfeeds/66956762.cms', category: 'technology' },
    ],
  },
  {
    id: 'abc-news-au',
    name: 'ABC News Australia',
    homepage: 'https://www.abc.net.au',
    leaning: 'center',
    country: 'AU',
    feeds: [
      { url: 'https://www.abc.net.au/news/feed/2942460/top-stories.xml', category: 'top' },
      { url: 'https://www.abc.net.au/news/feed/51192/world.xml', category: 'world' },
      { url: 'https://www.abc.net.au/news/feed/45910/business.xml', category: 'business' },
      { url: 'https://www.abc.net.au/news/feed/52278/sport.xml', category: 'sports' },
    ],
  },
  {
    id: 'cs-monitor',
    name: 'Christian Science Monitor',
    homepage: 'https://www.csmonitor.com',
    leaning: 'center',
    country: 'US',
    feeds: [
      { url: 'https://www.csmonitor.com/rss/top.rss', category: 'top' },
      { url: 'https://www.csmonitor.com/rss/world.rss', category: 'world' },
      { url: 'https://www.csmonitor.com/rss/business.rss', category: 'business' },
      { url: 'https://www.csmonitor.com/rss/science.rss', category: 'science' },
    ],
  },
  {
    id: 'axios',
    name: 'Axios',
    homepage: 'https://www.axios.com',
    leaning: 'center',
    country: 'US',
    feeds: [
      { url: 'https://api.axios.com/feed/top', category: 'top' },
      { url: 'https://api.axios.com/feed/politics', category: 'politics' },
      { url: 'https://api.axios.com/feed/technology', category: 'technology' },
      { url: 'https://api.axios.com/feed/business', category: 'business' },
    ],
  },
  {
    id: 'the-hill',
    name: 'The Hill',
    homepage: 'https://thehill.com',
    leaning: 'center',
    country: 'US',
    feeds: [
      { url: 'https://thehill.com/feed/', category: 'top' },
      { url: 'https://thehill.com/feed/?p=33', category: 'politics' },
    ],
  },

  // ── LEFT/LEAN-LEFT (additional) ──
  {
    id: 'huffpost',
    name: 'HuffPost',
    homepage: 'https://www.huffpost.com',
    leaning: 'left',
    country: 'US',
    feeds: [
      { url: 'https://www.huffpost.com/section/front-page/feed', category: 'top' },
      { url: 'https://www.huffpost.com/section/politics/feed', category: 'politics' },
      { url: 'https://www.huffpost.com/section/business/feed', category: 'business' },
      { url: 'https://www.huffpost.com/section/tech/feed', category: 'technology' },
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
      { url: 'https://www.vox.com/rss/technology/index.xml', category: 'technology' },
      { url: 'https://www.vox.com/rss/science/index.xml', category: 'science' },
      { url: 'https://www.vox.com/rss/health/index.xml', category: 'health' },
    ],
  },
  {
    id: 'slate',
    name: 'Slate',
    homepage: 'https://slate.com',
    leaning: 'left',
    country: 'US',
    feeds: [
      { url: 'https://slate.com/feeds/all.rss', category: 'top' },
      { url: 'https://slate.com/feeds/news-and-politics.rss', category: 'politics' },
      { url: 'https://slate.com/feeds/business.rss', category: 'business' },
      { url: 'https://slate.com/feeds/technology.rss', category: 'technology' },
    ],
  },
  {
    id: 'mother-jones',
    name: 'Mother Jones',
    homepage: 'https://www.motherjones.com',
    leaning: 'left',
    country: 'US',
    feeds: [
      { url: 'https://www.motherjones.com/feed', category: 'politics' },
    ],
  },
  {
    id: 'propublica',
    name: 'ProPublica',
    homepage: 'https://www.propublica.org',
    leaning: 'left',
    country: 'US',
    feeds: [
      { url: 'https://feeds.propublica.org/propublica/main', category: 'politics' },
    ],
  },
  {
    id: 'common-dreams',
    name: 'Common Dreams',
    homepage: 'https://www.commondreams.org',
    leaning: 'left',
    country: 'US',
    feeds: [
      { url: 'https://www.commondreams.org/rss.xml', category: 'politics' },
    ],
  },
  {
    id: 'the-intercept',
    name: 'The Intercept',
    homepage: 'https://theintercept.com',
    leaning: 'left',
    country: 'US',
    feeds: [
      { url: 'https://theintercept.com/feed/?rss', category: 'politics' },
    ],
  },
  {
    id: 'mashable',
    name: 'Mashable',
    homepage: 'https://mashable.com',
    leaning: 'left',
    country: 'US',
    feeds: [
      { url: 'https://mashable.com/feeds/rss/all', category: 'technology' },
    ],
  },
  {
    id: 'wired',
    name: 'Wired',
    homepage: 'https://www.wired.com',
    leaning: 'left',
    country: 'US',
    feeds: [
      { url: 'https://www.wired.com/feed/rss', category: 'technology' },
      { url: 'https://www.wired.com/feed/category/business/latest/rss', category: 'business' },
      { url: 'https://www.wired.com/feed/category/science/latest/rss', category: 'science' },
    ],
  },
  {
    id: 'vice',
    name: 'Vice News',
    homepage: 'https://www.vice.com',
    leaning: 'left',
    country: 'US',
    feeds: [
      { url: 'https://www.vice.com/rss', category: 'top' },
    ],
  },
  {
    id: 'salon',
    name: 'Salon',
    homepage: 'https://www.salon.com',
    leaning: 'left',
    country: 'US',
    feeds: [
      { url: 'https://www.salon.com/feed.rss', category: 'top' },
    ],
  },
  {
    id: 'the-conversation',
    name: 'The Conversation',
    homepage: 'https://theconversation.com',
    leaning: 'left',
    country: 'AU',
    feeds: [
      { url: 'https://theconversation.com/global/articles.rss', category: 'top' },
      { url: 'https://theconversation.com/global/technology/articles.rss', category: 'technology' },
      { url: 'https://theconversation.com/global/science/articles.rss', category: 'science' },
      { url: 'https://theconversation.com/global/health/articles.rss', category: 'health' },
      { url: 'https://theconversation.com/global/business/articles.rss', category: 'business' },
      { url: 'https://theconversation.com/global/politics/articles.rss', category: 'politics' },
    ],
  },
  {
    id: 'business-insider',
    name: 'Business Insider',
    homepage: 'https://www.businessinsider.com',
    leaning: 'left',
    country: 'US',
    feeds: [
      { url: 'https://www.businessinsider.com/rss', category: 'business' },
      { url: 'https://www.businessinsider.com/rss/tech', category: 'technology' },
    ],
  },
  {
    id: 'engadget',
    name: 'Engadget',
    homepage: 'https://www.engadget.com',
    leaning: 'left',
    country: 'US',
    feeds: [
      { url: 'https://www.engadget.com/rss.xml', category: 'technology' },
    ],
  },
  {
    id: 'the-verge',
    name: 'The Verge',
    homepage: 'https://www.theverge.com',
    leaning: 'left',
    country: 'US',
    feeds: [
      { url: 'https://www.theverge.com/rss/index.xml', category: 'technology' },
    ],
  },
  {
    id: 'arstechnica',
    name: 'Ars Technica',
    homepage: 'https://arstechnica.com',
    leaning: 'left',
    country: 'US',
    feeds: [
      { url: 'https://feeds.arstechnica.com/arstechnica/index', category: 'technology' },
      { url: 'https://feeds.arstechnica.com/arstechnica/science', category: 'science' },
    ],
  },
  {
    id: 'techcrunch',
    name: 'TechCrunch',
    homepage: 'https://techcrunch.com',
    leaning: 'left',
    country: 'US',
    feeds: [
      { url: 'https://techcrunch.com/feed/', category: 'technology' },
    ],
  },

  // ── RIGHT/LEAN-RIGHT (additional) ──
  {
    id: 'fox-business',
    name: 'Fox Business',
    homepage: 'https://www.foxbusiness.com',
    leaning: 'right',
    country: 'US',
    feeds: [
      { url: 'https://moxie.foxnews.com/google-publisher/business.xml', category: 'business' },
      { url: 'https://moxie.foxnews.com/google-publisher/economy.xml', category: 'business' },
    ],
  },
  {
    id: 'nypost',
    name: 'New York Post',
    homepage: 'https://nypost.com',
    leaning: 'right',
    country: 'US',
    feeds: [
      { url: 'https://nypost.com/feed/', category: 'top' },
      { url: 'https://nypost.com/news/feed/', category: 'top' },
      { url: 'https://nypost.com/business/feed/', category: 'business' },
      { url: 'https://nypost.com/sports/feed/', category: 'sports' },
    ],
  },
  {
    id: 'wash-examiner',
    name: 'Washington Examiner',
    homepage: 'https://www.washingtonexaminer.com',
    leaning: 'right',
    country: 'US',
    feeds: [
      { url: 'https://www.washingtonexaminer.com/feeds/rss', category: 'politics' },
    ],
  },
  {
    id: 'national-review',
    name: 'National Review',
    homepage: 'https://www.nationalreview.com',
    leaning: 'right',
    country: 'US',
    feeds: [
      { url: 'https://www.nationalreview.com/feed/', category: 'politics' },
      { url: 'https://www.nationalreview.com/feeds/feedbase/business', category: 'business' },
    ],
  },
  {
    id: 'wash-times',
    name: 'The Washington Times',
    homepage: 'https://www.washingtontimes.com',
    leaning: 'right',
    country: 'US',
    feeds: [
      { url: 'https://www.washingtontimes.com/rss/headlines/news/politics/', category: 'politics' },
      { url: 'https://www.washingtontimes.com/rss/headlines/news/world/', category: 'world' },
      { url: 'https://www.washingtontimes.com/rss/headlines/business/', category: 'business' },
    ],
  },
  {
    id: 'daily-wire',
    name: 'The Daily Wire',
    homepage: 'https://www.dailywire.com',
    leaning: 'right',
    country: 'US',
    feeds: [
      { url: 'https://www.dailywire.com/feeds/rss.xml', category: 'politics' },
    ],
  },
  {
    id: 'newsmax',
    name: 'Newsmax',
    homepage: 'https://www.newsmax.com',
    leaning: 'right',
    country: 'US',
    feeds: [
      { url: 'https://www.newsmax.com/rss/Newsfront/16', category: 'top' },
      { url: 'https://www.newsmax.com/rss/Politics/1', category: 'politics' },
      { url: 'https://www.newsmax.com/rss/Finance/352', category: 'business' },
    ],
  },
  {
    id: 'breitbart',
    name: 'Breitbart',
    homepage: 'https://www.breitbart.com',
    leaning: 'right',
    country: 'US',
    feeds: [
      { url: 'https://www.breitbart.com/feed/', category: 'top' },
      { url: 'https://www.breitbart.com/politics/feed/', category: 'politics' },
      { url: 'https://www.breitbart.com/world-news/feed/', category: 'world' },
      { url: 'https://www.breitbart.com/tech/feed/', category: 'technology' },
    ],
  },
  {
    id: 'the-federalist',
    name: 'The Federalist',
    homepage: 'https://thefederalist.com',
    leaning: 'right',
    country: 'US',
    feeds: [
      { url: 'https://thefederalist.com/feed/', category: 'politics' },
    ],
  },
  {
    id: 'reason',
    name: 'Reason',
    homepage: 'https://reason.com',
    leaning: 'right',
    country: 'US',
    feeds: [
      { url: 'https://reason.com/feed/', category: 'politics' },
    ],
  },
  {
    id: 'oz',
    name: 'The Australian',
    homepage: 'https://www.theaustralian.com.au',
    leaning: 'right',
    country: 'AU',
    feeds: [
      { url: 'https://www.theaustralian.com.au/feed', category: 'top' },
      { url: 'https://www.theaustralian.com.au/news/world/feed', category: 'world' },
      { url: 'https://www.theaustralian.com.au/business/feed', category: 'business' },
    ],
  },

  // ── SCIENCE / HEALTH (dedicated) ──
  {
    id: 'nature',
    name: 'Nature',
    homepage: 'https://www.nature.com',
    leaning: 'center',
    country: 'GB',
    feeds: [
      { url: 'https://www.nature.com/nature.rss', category: 'science' },
      { url: 'https://www.nature.com/news/rss', category: 'science' },
    ],
  },
  {
    id: 'new-scientist',
    name: 'New Scientist',
    homepage: 'https://www.newscientist.com',
    leaning: 'center',
    country: 'GB',
    feeds: [
      { url: 'https://www.newscientist.com/feed/home', category: 'science' },
      { url: 'https://www.newscientist.com/feed/health', category: 'health' },
    ],
  },
  {
    id: 'science-daily',
    name: 'Science Daily',
    homepage: 'https://www.sciencedaily.com',
    leaning: 'center',
    country: 'US',
    feeds: [
      { url: 'https://www.sciencedaily.com/rss/all.xml', category: 'science' },
      { url: 'https://www.sciencedaily.com/rss/health_medicine.xml', category: 'health' },
      { url: 'https://www.sciencedaily.com/rss/computers_math.xml', category: 'technology' },
    ],
  },
  {
    id: 'stat-news',
    name: 'STAT News',
    homepage: 'https://www.statnews.com',
    leaning: 'center',
    country: 'US',
    feeds: [
      { url: 'https://www.statnews.com/feed/', category: 'health' },
    ],
  },
  {
    id: 'medscape',
    name: 'Medscape',
    homepage: 'https://www.medscape.com',
    leaning: 'center',
    country: 'US',
    feeds: [
      { url: 'https://www.medscape.com/rss/public/news', category: 'health' },
    ],
  },

  // ── SPORTS (dedicated) ──
  {
    id: 'espn',
    name: 'ESPN',
    homepage: 'https://www.espn.com',
    leaning: 'center',
    country: 'US',
    feeds: [
      { url: 'https://www.espn.com/espn/rss/news', category: 'sports' },
      { url: 'https://www.espn.com/espn/rss/nfl/news', category: 'sports' },
      { url: 'https://www.espn.com/espn/rss/nba/news', category: 'sports' },
      { url: 'https://www.espn.com/espn/rss/mlb/news', category: 'sports' },
    ],
  },
  {
    id: 'sky-sports',
    name: 'Sky Sports',
    homepage: 'https://www.skysports.com',
    leaning: 'center',
    country: 'GB',
    feeds: [
      { url: 'https://www.skysports.com/rss/12040', category: 'sports' },
      { url: 'https://www.skysports.com/rss/11095', category: 'sports' },
    ],
  },
  {
    id: 'bbc-sport',
    name: 'BBC Sport',
    homepage: 'https://www.bbc.co.uk/sport',
    leaning: 'center',
    country: 'GB',
    feeds: [
      { url: 'https://feeds.bbci.co.uk/sport/rss.xml', category: 'sports' },
      { url: 'https://feeds.bbci.co.uk/sport/football/rss.xml', category: 'sports' },
      { url: 'https://feeds.bbci.co.uk/sport/cricket/rss.xml', category: 'sports' },
      { url: 'https://feeds.bbci.co.uk/sport/tennis/rss.xml', category: 'sports' },
      { url: 'https://feeds.bbci.co.uk/sport/rugby-union/rss.xml', category: 'sports' },
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
