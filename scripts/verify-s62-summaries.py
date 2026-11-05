#!/usr/bin/env python3
"""Session 62 live verification — random NeutralWire articles:
do they generate + serve proper AI summaries?

1. Pull live topics from several newsCache categories.
2. Sample N random ones.
3. For each: read the stored summary (Firebase) + backoff marker.
4. For every topic WITHOUT a real stored summary, POST /api/summary
   (interactive path) and record whether the response is a REAL AI
   summary (fallback=false) or the extractive/outlet fallback.
5. Print the verdict table + the failure causes.
"""
import json
import random
import sys
import urllib.request

DB = "https://neutralwire-aaedf-default-rtdb.europe-west1.firebasedatabase.app"
SITE = "https://neutralwire.org"
CATEGORIES = ["world", "politics", "business", "technology", "top", "science", "health", "sports"]
SAMPLE = 12

TEMPLATE_MARKERS = (
    "indicating significant public interest",
    "The breadth of coverage suggests",
    "Source details are no longer available",
)


def fb_get(path: str):
    try:
        with urllib.request.urlopen(f"{DB}/{path}.json", timeout=15) as r:
            return json.loads(r.read().decode() or "null")
    except Exception:
        return None


def is_template(summary: str) -> bool:
    return any(m in (summary or "") for m in TEMPLATE_MARKERS)


def post_summary(topic: dict) -> dict:
    body = {
        "topicId": topic["topicId"],
        "title": topic.get("title") or "",
        "topicSummary": (topic.get("summary") or "")[:400],
        "articles": [
            {
                "title": a.get("title") or "",
                "description": (a.get("description") or "")[:200],
                "sourceName": a.get("sourceName") or "",
                "leaning": a.get("leaning") or "center",
            }
            for a in (topic.get("articles") or [])[:12]
        ],
    }
    req = urllib.request.Request(
        f"{SITE}/api/summary",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode())
        except Exception:
            return {"error": f"HTTP {e.code}"}
    except Exception as e:
        return {"error": str(e)[:120]}


def main():
    random.seed()
    pool = []
    for cat in CATEGORIES:
        data = fb_get(f"newsCache/{cat}") or {}
        for t in data.get("topics") or []:
            if t and t.get("topicId") and t.get("title"):
                pool.append((cat, t))
    print(f"live topic pool: {len(pool)} across {len(CATEGORIES)} categories")
    sample = random.sample(pool, min(SAMPLE, len(pool)))

    rows = []
    real_ok = 0
    gen_ok = 0
    gen_fallback = 0
    for cat, topic in sample:
        tid = topic["topicId"]
        stored = fb_get(f"summaries/{tid}")
        backoff = fb_get(f"summaryBackoff/{tid}")
        stored_real = bool(stored and stored.get("summary") and not is_template(stored.get("summary")))
        row = {
            "cat": cat,
            "tid": tid,
            "title": (topic.get("title") or "")[:52],
            "stored": "REAL" if stored_real else ("template" if stored else "none"),
            "backoff": bool(backoff and backoff.get("failedAt")),
        }
        if stored_real:
            real_ok += 1
            row["gen"] = "-"
        else:
            res = post_summary(topic)
            summary = res.get("summary") or ""
            fallback = res.get("fallback")
            has_sections = "**The Big Picture**" in summary or "**Why It Matters**" in summary
            if res.get("error"):
                row["gen"] = f"ERROR {str(res.get('error'))[:40]}"
                gen_fallback += 1
            elif fallback is False and has_sections:
                row["gen"] = "REAL AI"
                gen_ok += 1
            elif fallback is False:
                row["gen"] = "ai?no-sections"
                gen_ok += 1
            else:
                row["gen"] = "FALLBACK"
                gen_fallback += 1
            row["len"] = len(summary)
        rows.append(row)
        print(f"  [{row['cat']:<10}] {row['tid']:<9} stored={row['stored']:<8} "
              f"backoff={'Y' if row['backoff'] else '-'}  gen={row.get('gen','-')}  "
              f"| {row['title']}")

    total = len(rows)
    print(f"\n══ verdict: {total} sampled ──")
    print(f"  already-served REAL summaries : {real_ok}")
    print(f"  generated REAL on demand      : {gen_ok}")
    print(f"  still fallback/error          : {gen_fallback}")
    if total and (real_ok + gen_ok) == total:
        print("  ✅ EVERY sampled article has a proper AI summary")
        sys.exit(0)
    else:
        print("  ⚠ some articles still lack real summaries (see table)")
        sys.exit(1)


if __name__ == "__main__":
    main()
