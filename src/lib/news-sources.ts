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
 */
export const CATEGORIES = [
  'top',
  'world',
  'politics',
  'business',
  'technology',
  'science',
  'health',
] as const

export type Category = (typeof CATEGORIES)[number]

export const CATEGORY_LABELS: Record<Category, string> = {
  top: 'Top Stories',
  world: 'World',
  politics: 'Politics',
  business: 'Business',
  technology: 'Tech',
  science: 'Science',
  health: 'Health',
}

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
]

/**
 * Returns the list of sources filtered by a leaning.
 */
export function sourcesByLeaning(leaning: Leaning): NewsSource[] {
  return NEWS_SOURCES.filter((s) => s.leaning === leaning)
}

/**
 * Returns all RSS feed URLs that match a given category, with the source they belong to.
 */
export function feedsForCategory(
  category: Category,
): { url: string; source: NewsSource; feedCategory: string }[] {
  const out: { url: string; source: NewsSource; feedCategory: string }[] = []
  for (const source of NEWS_SOURCES) {
    for (const feed of source.feeds) {
      if (feed.category === category || category === 'top') {
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
