/**
 * junk-filter.ts — shared social-media / non-news detection.
 *
 * WHY: gossip-blog and social-platform posts leak into every keyless news
 * source (the user-reported case: "#TSRMommyDuties: Aww! #Serayah reflects
 * on her summer and shares photos with her" — a The Shade Room Instagram
 * syndication riding Google News / GDELT results). Real newsroom headlines
 * essentially NEVER open with a hashtag, carry @handles, or read like a
 * caption — so a conservative rule set catches the social layer without
 * touching legitimate news.
 *
 * Used by BOTH pipelines:
 *   • news-aggregator.ts parseFeed() — every RSS item of every category
 *     (main feeds AND the custom-subtopic pool enricher)
 *   • custom-topics.ts — Google News RSS + GDELT raw items
 *
 * The rules are deliberately NARROW (false positives cost real news):
 *   1. Hashtags — a LEADING #tag, or ≥2 hashtags anywhere. A single
 *      embedded "#1"-style token never trips anything.
 *   2. @handles — "RT @user:", "@nasa says…" — social-native syntax.
 *   3. Social-post verb patterns — "shares photos", "takes to Twitter",
 *      "Twitter reacts", "goes viral on TikTok", "fans speculate"…
 *   4. Exclamatory gossip openers — "Aww!", "OMG", "Yikes", "Smh"…
 *   5. Section-tag-only titles — a bare "Watch", "Live", "Photos",
 *      "Opinion" fragment with no story behind it.
 *   6. Too-short titles — under 3 words or 15 characters can't carry a
 *      story ("Day 3", "Read more"); real headlines that short ("Fed cuts
 *      rates") are 3+ words and get clustered with longer siblings anyway.
 *   7. Known social-gossip domains — belt to the title braces (the hashtag
 *      is usually stripped by the time we see the item).
 */

/** Domains whose items are social-platform posts, not newsroom output. */
const SOCIAL_DOMAINS = new Set([
  'theshaderoom.com',
  'theshaderoomblog.com',
  'balleralert.com',
  'mediatakeout.com',
  'bossip.com',
  'theybf.com',
  'lovebscott.com',
  'necolebitchie.com',
])

/** Hashtag tokens (#Word) — #1 / #2 style rank tokens are excluded by
 * requiring a letter after the hash. */
function hashtagCount(title: string): number {
  const tags = title.match(/#[a-zA-Z][a-zA-Z0-9_]*/g) || []
  return tags.length
}

const LEADING_HASHTAG = /^#[a-zA-Z]/

/** Social-post verb / phrasing patterns. Each is rare-to-impossible in a
 * wire or newsroom headline, common in captions and fan accounts. */
const SOCIAL_PHRASES: RegExp[] = [
  // "…shares photos / posts a video / shares snapshots…"
  /\b(shares?|posted|posts?)\s+(a\s+)?(photos?|videos?|pics?|snapshots?|selfies?|footage)\b/i,
  // "…takes to Twitter / X / Instagram to …"
  /\btakes?\s+to\s+(twitter|x|instagram|tiktok|facebook|threads|social\s+media)\b/i,
  // "Twitter reacts…", "X users…", "Instagram is divided…"
  /\b(twitter|x|instagram|tiktok|facebook|threads)\s+(reacts?|users|is\s+divided|goes)\b/i,
  // "…go/goes viral on TikTok / Instagram…"
  /\bgo(es)?\s+viral\s+on\s+(twitter|x|instagram|tiktok|facebook|threads)\b/i,
  // deal-post pricing ("…for just $55") — shopping syndication, not news
  /\bfor (just|only) \$\d/i,
  // first-person forum style ("Finally can invest in …") — subject-dropped
  // verb after "Finally" with no comma = a Reddit-style post, not a desk
  /^finally\s+(can|could|did|do|have|had|am|was|were|went|got|made)\b/i,
  // fan-account speculation verbs ("fans speculate", "fans are convinced")
  /\bfans?\s+(react|speculate|think|are\s+convinced|believe|think\s+they)\b/i,
  // "…took to social media to…"
  /\btook\s+to\s+(twitter|x|instagram|tiktok|facebook|threads|social\s+media)\b/i,
]

/** Exclamatory gossip openers — the "Aww!" in the reported headline. */
const GOSSIP_OPENERS =
  /^(aw+w+|omg+|wow+|yikes|smh|smdh|no\s+way|is\s+it\s+just\s+me|real\s+talk|hot\s+take|the\s+tea|spilling\s+tea)[\s!,.]/i

/** Titles that are ONLY a section tag — no story at all. */
const SECTION_TAG_ONLY =
  /^(photos?|videos?|pics?|watch|live|live\s+updates?|updates?|opinion|analysis|report|explainer|breaking|briefing|cartoon|quiz|poll|horoscope)[\s:!.?]*$/i

/** True when the item is a social-media post or otherwise not a real news
 * headline. Conservative by design — when in doubt, keep the article.
 * `domain` (bare domain OR homepage URL) applies the known social-platform
 * domain list on top of the title rules. */
export function isJunkTitle(title: string, domain?: string): boolean {
  const t = (title || '').trim()
  if (!t) return true

  // Known social/gossip domain — the platform account itself.
  if (isJunkDomain(domain)) return true

  // 6. Too short to be a story.
  const words = t.split(/\s+/).filter(Boolean)
  if (words.length < 3 || t.length < 15) return true

  // 1. Hashtags — leading tag, or two or more anywhere.
  if (LEADING_HASHTAG.test(t) || hashtagCount(t) >= 2) return true

  // 2. @handles.
  if (/@[a-zA-Z][a-zA-Z0-9_.]{2,}/.test(t)) return true

  // 3. Social-post phrasing.
  for (const re of SOCIAL_PHRASES) if (re.test(t)) return true

  // 4. Gossip openers.
  if (GOSSIP_OPENERS.test(t)) return true

  // 5. Section-tag-only fragments.
  if (SECTION_TAG_ONLY.test(t)) return true

  return false
}

/** True when the DOMAIN is a known social/gossip platform account.
 * Accepts a bare domain ("theshaderoom.com") or a full homepage URL
 * ("https://www.theshaderoom.com") — parseFeed passes source.homepage,
 * custom-topics passes the outlet domain. */
export function isJunkDomain(domain?: string): boolean {
  if (!domain) return false
  let bare = domain.trim().toLowerCase()
  if (bare.includes('://')) {
    try {
      bare = new URL(bare).hostname
    } catch {
      return false
    }
  }
  bare = bare.replace(/^www\./, '')
  return SOCIAL_DOMAINS.has(bare)
}
