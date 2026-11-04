#!/usr/bin/env python3
"""Scan live newsCache rooms for stories that would break web-push sends.

Replicates trigger-tz's payload construction and flags:
  - payload > 4096 bytes (web-push hard limit -> sendNotification throws)
  - huge / malformed imageUrl
  - missing title / topicId
"""
import json, urllib.request, urllib.parse, collections

DB = "https://neutralwire-aaedf-default-rtdb.europe-west1.firebasedatabase.app"

def fetch(path):
    with urllib.request.urlopen(f"{DB}/{path}.json", timeout=60) as r:
        return json.load(r)

rooms = [
    "newsCache/mycountry__GB", "newsCache/relevant__GB",
    "newsCache/world", "newsCache/technology", "newsCache/business",
    "newsCache/science", "newsCache/top",
    "newsCache/mycountry__IN", "newsCache/relevant__IN",
]

# Sent-history keys (already-sent stories are excluded from fresh pool)
hist = fetch("notification-sent-history") or {}
print(f"sent-history entries: {len(hist)}\n")

problems = []
for room in rooms:
    try:
        payload = fetch(room)
    except Exception as e:
        print(f"!! {room}: FETCH ERROR {e}")
        continue
    if not payload or not isinstance(payload.get("topics"), list):
        print(f"!! {room}: no topics list (keys: {list((payload or {}).keys())})")
        continue
    topics = payload["topics"]
    # trigger-tz replica: filter(coverage >= 1).slice(0, 5)
    pool = [t for t in topics if (t.get("coverage") or 0) >= 1][:5]
    print(f"{room}: {len(topics)} topics, pool(first5)={len(pool)}, refreshed={payload.get('lastRefresh')}")
    for t in pool:
        if hist.get(t.get("topicId") or ""):
            continue  # exact-dup: would be filtered out as not fresh
        title = t.get("title")
        image_url = t.get("imageUrl")
        ti = t.get("topicId") or ""
        if not isinstance(title, str) or not title:
            problems.append((room, ti, "MISSING/BAD TITLE", title, image_url))
            continue
        if image_url is not None and not isinstance(image_url, str):
            problems.append((room, ti, "NON-STRING imageUrl", title[:60], str(image_url)[:100]))
            continue
        # Replicate ogImageUrl
        if image_url:
            og = ("https://neutralwire.org/api/og-image?topicId=" + urllib.parse.quote(ti, safe="")
                  + "&title=" + urllib.parse.quote(title[:80], safe="")
                  + f"&leanLeft={t.get('leanLeft')}&leanCenter={t.get('leanCenter')}&leanRight={t.get('leanRight')}"
                  + "&imageUrl=" + urllib.parse.quote(image_url, safe=""))
        else:
            og = None
        pl = json.dumps({
            "title": "Evening Briefing", "body": title[:100],
            "url": f"/?topic={ti}", "icon": "/icon-192.png", "badge": "/badge-96.png",
            "image": og, "tag": "briefing-evening",
            "notifId": "tz_2026-09-23_evening_abcdef", "likeButton": True,
        }, separators=(",", ":"))
        size = len(pl.encode())
        flag = "  <<< OVER 4096 (SEND THROWS)" if size > 4096 else ""
        print(f"   [{size:5d}B] {ti} | cov={t.get('coverage')} | img={len(image_url) if image_url else 0}ch | {title[:55]}{flag}")
        if size > 3800:
            problems.append((room, ti, f"PAYLOAD {size}B", title[:60], (image_url or "")[:120]))

print("\n=== PROBLEMS:")
if not problems:
    print("  none in current pools")
for p in problems:
    print(" ", p)
