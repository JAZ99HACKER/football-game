"""Tests for scripts/fetch_data.py using fake API responses (no network).
Run with: python3 -m unittest discover -s tests -p "test_*.py"
"""
import os
import sys
import unittest
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
import fetch_data as fd  # noqa: E402

NOW = datetime(2026, 11, 7, 10, 0, tzinfo=timezone.utc)


def raw_team(i, name):
    return {"id": i, "name": name, "shortName": name.split()[0], "tla": name[:3].upper(), "crest": f"https://c/{i}.png"}


def raw_match(i, date, status, home, away, full=None, winner=None, stage="REGULAR_SEASON", duration="REGULAR", **extra):
    score = {"winner": winner, "duration": duration,
             "fullTime": {"home": full[0], "away": full[1]} if full else {"home": None, "away": None}}
    score.update(extra)
    return {"id": i, "utcDate": date, "status": status, "matchday": 1, "stage": stage, "group": None,
            "homeTeam": raw_team(*home), "awayTeam": raw_team(*away), "score": score}


A, B = (1, "Alpha FC"), (2, "Beta FC")


class FinalScoreTests(unittest.TestCase):
    def test_regular_and_extra_time_use_full_time(self):
        self.assertEqual(fd.final_score({"duration": "REGULAR", "fullTime": {"home": 2, "away": 1}}), {"home": 2, "away": 1})
        self.assertEqual(fd.final_score({"duration": "EXTRA_TIME", "fullTime": {"home": 3, "away": 2}}), {"home": 3, "away": 2})

    def test_missing_score(self):
        self.assertIsNone(fd.final_score({"fullTime": {"home": None, "away": None}}))
        self.assertIsNone(fd.final_score(None))

    def test_shootout_when_fulltime_includes_penalties(self):
        # 1-1 after extra time, shootout 4-3 -> fullTime 5-4 if penalties are added
        s = {"duration": "PENALTY_SHOOTOUT", "fullTime": {"home": 5, "away": 4}, "penalties": {"home": 4, "away": 3}}
        self.assertEqual(fd.final_score(s), {"home": 1, "away": 1})

    def test_shootout_when_fulltime_excludes_penalties(self):
        s = {"duration": "PENALTY_SHOOTOUT", "fullTime": {"home": 1, "away": 1}, "penalties": {"home": 4, "away": 3}}
        self.assertEqual(fd.final_score(s), {"home": 1, "away": 1})

    def test_shootout_from_regular_plus_extra(self):
        s = {"duration": "PENALTY_SHOOTOUT", "fullTime": {"home": 9, "away": 8},
             "regularTime": {"home": 0, "away": 0}, "extraTime": {"home": 1, "away": 1}}
        self.assertEqual(fd.final_score(s), {"home": 1, "away": 1})


class BuildTests(unittest.TestCase):
    def fetcher(self, wc_matches, fail=()):
        league_matches = [
            raw_match(1, "2026-11-01T15:00:00Z", "FINISHED", A, B, full=(2, 1), winner="HOME_TEAM"),
            raw_match(2, "2026-11-08T15:00:00Z", "TIMED", B, A),
        ]
        final = raw_match(9, "2026-05-30T19:00:00Z", "FINISHED", A, B, full=(1, 1), winner="AWAY_TEAM",
                          stage="FINAL", duration="PENALTY_SHOOTOUT", penalties={"home": 3, "away": 4})
        table = {"standings": [{"type": "TOTAL", "stage": "REGULAR_SEASON", "group": None, "table": [
            {"position": 1, "team": raw_team(*A), "playedGames": 12, "points": 30, "goalDifference": 15},
            {"position": 2, "team": raw_team(*B), "playedGames": 12, "points": 25, "goalDifference": 5}]}],
            "season": {"startDate": "2026-08-15", "endDate": "2027-05-23"}}

        def fetch(path):
            code = path.split("/")[2]
            if code in fail:
                raise RuntimeError("HTTP 500")
            if path.endswith("/matches"):
                if code == "WC":
                    return {"matches": wc_matches}
                if code == "CL":
                    return {"matches": league_matches + [final]}
                return {"matches": league_matches}
            return table
        return fetch

    def test_build_shapes_data(self):
        out, errors = fd.build(self.fetcher([]), NOW, {})
        self.assertEqual(errors, [])
        self.assertEqual(sorted(out), ["BL1", "CL", "PD", "PL"])  # WC inactive
        pl = out["PL"]
        self.assertEqual(pl["seasonId"], "PL-2026")
        self.assertEqual(pl["totalCount"], 2)
        self.assertEqual(pl["finishedCount"], 1)
        self.assertIsNone(pl["champion"])  # one match still to play
        self.assertEqual(pl["matches"][0]["score"], {"home": 2, "away": 1})
        self.assertIsNone(pl["matches"][1]["score"])
        self.assertEqual(pl["standings"][0]["table"][0]["team"]["name"], "Alpha FC")

    def test_cup_champion_from_final_winner(self):
        out, _ = fd.build(self.fetcher([]), NOW, {})
        champ = out["CL"]["champion"]
        self.assertEqual(champ["name"], "Beta FC")  # AWAY_TEAM won the shootout
        final = [m for m in out["CL"]["matches"] if m["stage"] == "FINAL"][0]
        self.assertEqual(final["score"], {"home": 1, "away": 1})

    def test_league_champion_when_all_done(self):
        def fetch(path):
            if path.endswith("/matches"):
                return {"matches": [raw_match(1, "2027-05-23T15:00:00Z", "FINISHED", A, B, full=(2, 1), winner="HOME_TEAM")]}
            return self.fetcher([])(path)
        out, _ = fd.build(fetch, NOW, {})
        self.assertEqual(out["PL"]["champion"]["name"], "Alpha FC")

    def test_world_cup_only_when_fixtures_near(self):
        soon = [raw_match(5, "2027-01-05T15:00:00Z", "TIMED", A, B)]
        out, _ = fd.build(self.fetcher(soon), NOW, {})
        self.assertIn("WC", out)
        far = [raw_match(5, "2030-06-11T15:00:00Z", "TIMED", A, B)]
        out, _ = fd.build(self.fetcher(far), NOW, {})
        self.assertNotIn("WC", out)
        old = [raw_match(5, "2026-07-19T19:00:00Z", "FINISHED", A, B, full=(1, 0), winner="HOME_TEAM")]
        out, _ = fd.build(self.fetcher(old), NOW, {})
        self.assertNotIn("WC", out)

    def test_failed_competition_keeps_previous_data(self):
        good, _ = fd.build(self.fetcher([]), NOW, {})
        out, errors = fd.build(self.fetcher([], fail=("PD",)), NOW, {"competitions": good})
        self.assertEqual(len(errors), 1)
        self.assertIn("PD", errors[0])
        self.assertEqual(out["PD"], good["PD"])

    def test_failed_competition_without_previous_is_skipped(self):
        out, errors = fd.build(self.fetcher([], fail=("PD",)), NOW, {})
        self.assertNotIn("PD", out)
        self.assertEqual(len(errors), 1)


if __name__ == "__main__":
    unittest.main()
