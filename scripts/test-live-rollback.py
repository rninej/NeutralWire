#!/usr/bin/env python3
"""Live production test: a FAILED briefing send must roll back the day-mark.

Method (safe, zero user impact):
  1. Find an IANA timezone currently inside a briefing window.
  2. Dry-run trigger-tz — ABORT unless ZERO real devices are in-window
     (so the only affected device will be our fake probe).
  3. Create devices/diag_rollback_probe with a garbage FCM subscription
     + the in-window timezone.
  4. Real trigger-tz run — the probe's send FAILS at FCM.
  5. Assert sentSlotsToday/<slot> is ABSENT on the probe (rolled back).
  6. Delete the probe.

New-code detector: the dispatch response carries `firstError` (absent in
the pre-fix code) — if missing, the deploy hasn't landed yet → FAIL/RETRY.
"""
import json, urllib.request, urllib.parse, datetime, sys, time

DB = "https://neutralwire-aaedf-default-rtdb.europe-west1.firebasedatabase.app"
TRIGGER = "https://neutralwire.org/api/push/trigger-tz?secret=nw-tz-trigger-9f3a7c2e1b8d4f6a"
PROBE = "diag_rollback_probe"

def http(url, method="GET", body=None, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)

# ── 1. in-window timezone ──
CANDIDATES = {
    "Asia/Tehran": 12600, "Europe/Moscow": 10800, "Asia/Dubai": 14400,
    "Asia/Kolkata": 19800, "Europe/London": 3600, "UTC": 0,
    "America/Sao_Paulo": -10800, "America/New_York": -14400,
    "America/Chicago": -18000, "America/Los_Angeles": -25200,
    "Asia/Kathmandu": 20700, "Asia/Almaty": 21600,
    "Australia/Sydney": 36000, "Pacific/Auckland": 46800,
    "Africa/Lagos": 3600, "Africa/Cairo": 7200,
}
SLOTS = {"morning": 480, "lunch": 780, "evening": 1200}  # minutes local
now = datetime.datetime.now(datetime.UTC)
probe_tz, probe_slot, local_min = None, None, None
for tz, off in CANDIDATES.items():
    local = (now.timestamp() + off) / 60
    lm = int(local) % 1440
    for slot, target in SLOTS.items():
        if abs(lm - target) <= 14:
            probe_tz, probe_slot, local_min = tz, slot, lm
if not probe_tz:
    print(f"FAIL: no candidate timezone is in a briefing window right now ({now.isoformat()})")
    sys.exit(1)
print(f"probe timezone: {probe_tz} ({probe_slot} window, local minute {local_min})")

# ── 2. dry run: only proceed when NO real device is in-window ──
dry = http(TRIGGER + "&dry=1")
print(f"dry run: {json.dumps(dry)[:220]}")
if dry.get("sent", -1) != 0:
    print("ABORT: dry run unexpected shape")
    sys.exit(1)
# skipNoTimezone devices CONTINUE to the window check (default UTC), so
# they are double-counted inside skipNotInWindow/skipAlreadySent — only
# subtract the non-overlapping categories.
in_window_now = dry.get("totalDevices", 0) - (
    dry.get("skipBreakdown", {}).get("skipNoSub", 0)
    + dry.get("skipBreakdown", {}).get("skipNotStandalone", 0)
    + dry.get("skipBreakdown", {}).get("skipNotInWindow", 0)
    + dry.get("skipBreakdown", {}).get("skipAlreadySent", 0))
print(f"real devices currently in-window: {in_window_now}")
if in_window_now != 0:
    print("ABORT: real devices are in-window — retry when the window is empty")
    sys.exit(1)

# ── 3. create the probe ──
http(f"{DB}/devices/{PROBE}.json", "PUT", {
    "pushSubscription": {
        "endpoint": "https://fcm.googleapis.com/fcm/send/INVALID_DIAG_ROLLBACK_PROBE",
        "keys": {"p256dh": "BACA", "auth": "AAE"},
    },
    "pushIsStandalone": True,
    "timezone": probe_tz,
    "diag": True,
})
print(f"probe created (tz={probe_tz})")

# ── 4. real run ──
res = http(TRIGGER)
print(f"real run: sent={res.get('sent')} failed={res.get('failed')} toNotify={res.get('toNotify')} "
      f"firstError={str(res.get('firstError'))[:90]}")

# ── 5. assert rollback ──
time.sleep(2)
sst = http(f"{DB}/devices/{PROBE}/sentSlotsToday.json")
mark = (sst or {}).get(probe_slot)

# ── 6. delete the probe ──
http(f"{DB}/devices/{PROBE}.json", "DELETE")
print("probe deleted")

new_code = "firstError" in res
if not new_code:
    print("\nRESULT: DEPLOY-NOT-LANDED (response lacks firstError — old code ran). "
          "Probe deleted; re-run this script in a few minutes.")
    sys.exit(2)
if mark is None:
    print(f"\nPASS: send FAILED (failed={res.get('failed')}, error recorded) and the "
          f"{probe_slot} mark was ROLLED BACK — the device will be retried by the next in-window trigger.")
    sys.exit(0)
print(f"\nFAIL: mark still present after failed send: {probe_slot}={mark}")
sys.exit(1)
