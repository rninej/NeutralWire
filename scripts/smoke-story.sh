#!/usr/bin/env bash
# Smoke test: NeutralWire production build — SEO surface + the story page's
# real neutral summary (the fix for "Google opens a fake page with no
# neutral summary").
#
# Usage: bash scripts/smoke-story.sh [PORT]   (default 3100)
# Requires: bun run build already completed (standalone output).

PORT="${1:-3100}"
BASE="http://localhost:$PORT"
PASS=0
FAIL=0

check() { # name, condition-result (0=ok)
  if [ "$2" -eq 0 ]; then echo "  PASS  $1"; PASS=$((PASS+1));
  else echo "  FAIL  $1"; FAIL=$((FAIL+1)); fi
}

contains() { # haystack-file, needle
  grep -qF -- "$2" "$1" 2>/dev/null
}

echo "── Core SEO surface"
for path in robots.txt sitemap.xml news-sitemap.xml feed.xml manifest.json; do
  code=$(curl -s -o "/tmp/nw-$path" -w '%{http_code}' "$BASE/$path")
  [ "$code" = "200" ]; check "/$path → 200 (got $code)" $?
done
curl -s "$BASE/robots.txt" > /tmp/nw-robots.txt
contains /tmp/nw-robots.txt "Sitemap: https://neutralwire.org/sitemap.xml"; check "robots.txt lists sitemap.xml" $?
contains /tmp/nw-robots.txt "news-sitemap.xml"; check "robots.txt lists news-sitemap.xml" $?
contains /tmp/nw-robots.txt "GPTBot"; check "robots.txt keeps AI-crawler blocks" $?

echo "── Homepage"
code=$(curl -s -o /tmp/nw-home.html -w '%{http_code}' "$BASE/")
[ "$code" = "200" ]; check "/ → 200 (got $code)" $?
contains /tmp/nw-home.html "max-image-preview:large"; check "homepage Discover gate (max-image-preview:large)" $?

echo "── Demo routes are gone"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/manifest.webmanifest")
[ "$code" = "404" ]; check "/manifest.webmanifest removed (404, got $code)" $?

echo "── Story page — the real neutral summary"
# Pick the freshest story URL from the news sitemap.
STORY_PATH=$(curl -s "$BASE/news-sitemap.xml" | grep -o '<loc>[^<]*</loc>' | head -2 | tail -1 | sed 's/<[^>]*>//g' | sed "s|https://neutralwire.org||")
if [ -z "$STORY_PATH" ]; then
  echo "  FAIL  could not read a story URL from news-sitemap.xml"; FAIL=$((FAIL+1))
else
  echo "  (testing $STORY_PATH)"
  code=$(curl -s -o /tmp/nw-story.html -w '%{http_code}' "$BASE$STORY_PATH")
  [ "$code" = "200" ]; check "story page → 200 (got $code)" $?
  contains /tmp/nw-story.html "Neutral Summary"; check "story page renders the Neutral Summary card" $?
  contains /tmp/nw-story.html "max-image-preview:large"; check "story page inherits Discover gate" $?
  contains /tmp/nw-story.html "rel=\"canonical\""; check "story page canonical link" $?
  contains /tmp/nw-story.html "NewsArticle"; check "story page NewsArticle JSON-LD" $?
  contains /tmp/nw-story.html "Compare live in the app"; check "story page app deep-link CTA" $?
fi

# A story KNOWN to have a stored LLM summary (verified via the Firebase
# probe) — its HTML must contain the real neutral summary text.
if [ -n "$2" ]; then
  STORED_ID="$2"
  echo "── Story with stored summary ($STORED_ID)"
  code=$(curl -s -o /tmp/nw-stored.html -w '%{http_code}' "$BASE/story/$STORED_ID")
  [ "$code" = "200" ]; check "stored-summary story → 200 (got $code)" $?
  contains /tmp/nw-stored.html "Neutral Summary"; check "Neutral Summary card present" $?
  contains /tmp/nw-stored.html "The Big Picture"; check "stored LLM summary sections in raw HTML" $?
fi

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
