#!/usr/bin/env python3
"""Fetch fixtures, results and tables from football-data.org and write data/data.json.

Runs on a schedule in GitHub Actions. The API token comes from the environment
variable FOOTBALL_DATA_TOKEN (a GitHub secret), so it never reaches the website.

Only the Python standard library is used.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

API = "https://api.football-data.org/v4"
OUT_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "data.json")

# (code, display name, kind). kind "league" = champion is rank 1 once every match is done;
# kind "cup" = champion is the winner of the FINAL.
ALWAYS = [
    ("PL", "Premier League", "league"),
    ("PD", "La Liga", "league"),
    ("BL1", "Bundesliga", "league"),
    ("CL", "Champions League", "cup"),
]
# Only included while it has live games or fixtures within WINDOW_DAYS.
OPTIONAL = [("WC", "FIFA World Cup", "cup")]
WINDOW_DAYS = 60

# Free tier allows 10 calls per minute, so leave a gap between calls.
PAUSE_SECONDS = 7

DONE_STATUSES = {"FINISHED", "AWARDED", "CANCELLED"}


def parse_date(text):
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


def team(t):
    t = t or {}
    return {
        "id": t.get("id"),
        "name": t.get("name"),
        "short": t.get("shortName") or t.get("name"),
        "tla": t.get("tla"),
        "crest": t.get("crest"),
    }


def final_score(score):
    """Score used for settling bets: 90 minutes plus extra time, penalty shootout excluded.

    The shootout handling relies on one fact: a match only goes to penalties if it is level
    after extra time. So whichever reading of the API fields gives a level score is correct.
    """
    score = score or {}
    full = score.get("fullTime") or {}
    if full.get("home") is None or full.get("away") is None:
        return None
    duration = score.get("duration")
    if duration != "PENALTY_SHOOTOUT":
        return {"home": full["home"], "away": full["away"]}

    candidates = []
    pen = score.get("penalties") or {}
    if pen.get("home") is not None and pen.get("away") is not None:
        candidates.append({"home": full["home"] - pen["home"], "away": full["away"] - pen["away"]})
    candidates.append({"home": full["home"], "away": full["away"]})
    reg = score.get("regularTime") or {}
    ext = score.get("extraTime") or {}
    if None not in (reg.get("home"), reg.get("away"), ext.get("home"), ext.get("away")):
        candidates.append({"home": reg["home"] + ext["home"], "away": reg["away"] + ext["away"]})
    for c in candidates:
        if c["home"] == c["away"] and c["home"] >= 0:
            return c
    return candidates[0]


def convert_match(m):
    s = m.get("score") or {}
    status = m.get("status")
    return {
        "id": m.get("id"),
        "utcDate": m.get("utcDate"),
        "status": status,
        "matchday": m.get("matchday"),
        "stage": m.get("stage"),
        "group": m.get("group"),
        "home": team(m.get("homeTeam")),
        "away": team(m.get("awayTeam")),
        "score": final_score(s) if status == "FINISHED" else None,
        "winner": s.get("winner") if status == "FINISHED" else None,
    }


def convert_standings(data):
    groups = []
    for st in (data or {}).get("standings", []):
        if st.get("type") != "TOTAL":
            continue
        rows = []
        for r in st.get("table", []):
            rows.append({
                "position": r.get("position"),
                "team": team(r.get("team")),
                "played": r.get("playedGames"),
                "points": r.get("points"),
                "gd": r.get("goalDifference"),
            })
        groups.append({"group": st.get("group"), "stage": st.get("stage"), "table": rows})
    return groups


def find_champion(kind, matches, standings):
    if kind == "league":
        if matches and all(m["status"] in DONE_STATUSES for m in matches):
            if standings and standings[0]["table"]:
                return standings[0]["table"][0]["team"]
        return None
    for m in matches:
        if m["stage"] == "FINAL" and m["status"] == "FINISHED":
            if m["winner"] == "HOME_TEAM":
                return m["home"]
            if m["winner"] == "AWAY_TEAM":
                return m["away"]
    return None


def is_active(matches, now):
    """True if a competition has live games or fixtures coming up within the window."""
    for m in matches:
        if m["status"] in ("IN_PLAY", "PAUSED", "LIVE"):
            return True
        if m["utcDate"]:
            d = parse_date(m["utcDate"])
            if now <= d <= now + timedelta(days=WINDOW_DAYS):
                return True
    return False


def season_info(standings_raw, matches_raw):
    season = (standings_raw or {}).get("season")
    if not season:
        first = (matches_raw.get("matches") or [{}])[0]
        season = first.get("season") or {}
    start = (season.get("startDate") or "")[:4] or "unknown"
    return start, season.get("startDate"), season.get("endDate")


def build(fetch, now, previous):
    """Build the data structure. `fetch(path)` returns parsed JSON; injectable for tests."""
    out = {}
    errors = []
    plan = [(c, n, k, False) for c, n, k in ALWAYS] + [(c, n, k, True) for c, n, k in OPTIONAL]
    for code, name, kind, optional in plan:
        try:
            matches_raw = fetch(f"/competitions/{code}/matches")
            matches = [convert_match(m) for m in matches_raw.get("matches", [])]
            matches.sort(key=lambda m: (m["utcDate"] or "", m["id"] or 0))
            if optional and not is_active(matches, now):
                continue
            standings_raw = fetch(f"/competitions/{code}/standings")
            standings = convert_standings(standings_raw)
            year, start, end = season_info(standings_raw, matches_raw)
            out[code] = {
                "code": code,
                "name": name,
                "kind": kind,
                "seasonId": f"{code}-{year}",
                "seasonStart": start,
                "seasonEnd": end,
                "totalMatchdays": max([m["matchday"] or 0 for m in matches] or [0]),
                "totalCount": len(matches),
                "finishedCount": sum(1 for m in matches if m["status"] in DONE_STATUSES),
                "champion": find_champion(kind, matches, standings),
                "standings": standings,
                "matches": matches,
            }
        except Exception as exc:  # keep the previous data for this competition
            errors.append(f"{code}: {exc}")
            old = (previous.get("competitions") or {}).get(code)
            if old:
                out[code] = old
    return out, errors


def make_fetch(token):
    state = {"first": True}

    def fetch(path):
        if not state["first"]:
            time.sleep(PAUSE_SECONDS)
        state["first"] = False
        for attempt in range(2):
            req = urllib.request.Request(API + path, headers={"X-Auth-Token": token})
            try:
                with urllib.request.urlopen(req, timeout=30) as resp:
                    return json.load(resp)
            except urllib.error.HTTPError as err:
                if err.code == 429 and attempt == 0:
                    time.sleep(65)
                    continue
                raise RuntimeError(f"HTTP {err.code} for {path}")
        raise RuntimeError(f"giving up on {path}")

    return fetch


def main():
    token = os.environ.get("FOOTBALL_DATA_TOKEN", "").strip()
    if not token:
        sys.exit("FOOTBALL_DATA_TOKEN is not set (add it as a GitHub secret).")

    previous = {}
    if os.path.exists(OUT_FILE):
        try:
            with open(OUT_FILE, encoding="utf-8") as f:
                previous = json.load(f)
        except Exception:
            previous = {}

    now = datetime.now(timezone.utc)
    comps, errors = build(make_fetch(token), now, previous)
    for e in errors:
        print("WARNING:", e, file=sys.stderr)
    if not comps:
        sys.exit("No competition data could be fetched.")

    if comps == previous.get("competitions"):
        print("No changes in data; file left as is.")
        return
    payload = {"fetchedAt": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "competitions": comps}
    os.makedirs(os.path.dirname(OUT_FILE), exist_ok=True)
    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    print(f"Wrote {len(comps)} competitions to data/data.json")


if __name__ == "__main__":
    main()
