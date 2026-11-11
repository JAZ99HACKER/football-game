// Run with: node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const Scoring = require("../js/scoring.js");
const Game = require("../js/game.js");

const NOW = Date.parse("2026-11-07T10:00:00Z");
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();

// Local calendar day, same format the game uses for the daily bonus.
const dk = (ms) => { const d = new Date(ms); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
// A player who has already had today's daily bonus, so the older tests can check stakes and payouts on their own.
function quiet(u) { u.dailyDays.push(dk(NOW)); return u; }

function t(id, name, short) { return { id, name, short: short || name, tla: null, crest: null }; }
const RM = t(86, "Real Madrid CF", "Real Madrid");
const FCB = t(81, "FC Barcelona", "Barça");
const ESP = t(80, "RCD Espanyol de Barcelona", "Espanyol");
const ATM = t(78, "Club Atlético de Madrid", "Atleti");
const GIR = t(298, "Girona FC", "Girona");
const SEV = t(559, "Sevilla FC", "Sevilla");

function table(rows) {
  return [{ group: null, stage: "REGULAR_SEASON", table: rows.map((tm, i) => ({ position: i + 1, team: tm, played: 12, points: 30 - i, gd: 10 - i })) }];
}

function makeData(extra) {
  const pd = {
    code: "PD", name: "La Liga", kind: "league", seasonId: "PD-2026", totalCount: 380, finishedCount: 120, totalMatchdays: 38,
    champion: null,
    standings: table([FCB, RM, ATM, GIR, SEV, ESP]),
    matches: [
      { id: 1, utcDate: iso(NOW + 2 * DAY), status: "SCHEDULED", matchday: 14, stage: "REGULAR_SEASON", home: RM, away: FCB, score: null, winner: null },
      { id: 2, utcDate: iso(NOW + 3 * DAY), status: "TIMED", matchday: 14, stage: "REGULAR_SEASON", home: GIR, away: SEV, score: null, winner: null },
      { id: 3, utcDate: iso(NOW - 3 * DAY), status: "FINISHED", matchday: 13, stage: "REGULAR_SEASON", home: ATM, away: ESP, score: { home: 2, away: 0 }, winner: "HOME_TEAM" },
      { id: 4, utcDate: iso(NOW + HOUR), status: "SCHEDULED", matchday: 14, stage: "REGULAR_SEASON", home: ESP, away: FCB, score: null, winner: null }
    ]
  };
  return { fetchedAt: iso(NOW), competitions: Object.assign({ PD: pd }, extra || {}) };
}

// ---------------- scoring ----------------
test("match payouts follow the rules table", () => {
  const cases = [
    // [pred, actual, high, expected multiplier]
    [[2, 1], [2, 1], false, 2],
    [[2, 1], [2, 1], true, 3],
    [[2, 1], [2, 0], false, 1.5], // off by 1, right result
    [[1, 1], [2, 1], false, 0.5], // off by 1, wrong result: capped
    [[1, 0], [2, 1], false, 0.5], // off by 2, right result
    [[1, 0], [0, 3], false, 0],   // far off
    [[0, 0], [1, 1], false, 0.5], // off by 2, draw predicted and draw happened
    [[2, 1], [0, 0], false, 0],   // off by 3
    [[3, 0], [1, 0], false, 0.5]  // off by 2 right result
  ];
  for (const [p, a, high, expected] of cases) {
    const r = Scoring.matchMultiplier({ home: p[0], away: p[1] }, { home: a[0], away: a[1] }, high);
    assert.equal(r.multiplier, expected, `pred ${p} actual ${a} high ${high}`);
  }
});

test("settleMatchBet computes payout and net", () => {
  const bet = { stake: 20, pickHome: 2, pickAway: 1, high: true };
  const r = Scoring.settleMatchBet(bet, { home: 2, away: 1 });
  assert.equal(r.payout, 60);
  assert.equal(r.net, 40);
  assert.equal(r.exact, true);
  const loss = Scoring.settleMatchBet({ stake: 25, pickHome: 1, pickAway: 0, high: false }, { home: 0, away: 3 });
  assert.equal(loss.payout, 0);
  assert.equal(loss.net, -25);
  const half = Scoring.settleMatchBet({ stake: 5, pickHome: 1, pickAway: 0, high: false }, { home: 2, away: 1 });
  assert.equal(half.payout, 2.5);
  assert.equal(half.net, -2.5);
});

test("high-stakes detection: rivalries, finals, knockouts, top-6", () => {
  const pd = { code: "PD", kind: "league" };
  const m = (home, away, stage) => ({ home, away, stage: stage || "REGULAR_SEASON" });
  assert.equal(Scoring.highStakesReason(m(RM, FCB), pd, {}), "El Clasico");
  assert.equal(Scoring.highStakesReason(m(FCB, RM), pd, {}), "El Clasico");
  assert.equal(Scoring.highStakesReason(m(ATM, RM), pd, {}), "Madrid derby");
  assert.equal(Scoring.highStakesReason(m(FCB, ESP), pd, {}), "Catalan derby");
  // Espanyol's name contains "Barcelona" but must not make Real Madrid v Espanyol a Clasico
  assert.equal(Scoring.highStakesReason(m(RM, ESP), pd, {}), null);
  assert.equal(Scoring.highStakesReason(m(GIR, SEV), pd, {}), null);
  // top-6 rule
  const ranks = { 81: 1, 86: 2, 78: 3, 298: 4, 559: 5, 80: 12 };
  assert.equal(Scoring.highStakesReason(m(GIR, SEV), pd, ranks), "Top-6 clash");
  assert.equal(Scoring.highStakesReason(m(GIR, ESP), pd, ranks), null);

  const cl = { code: "CL", kind: "cup" };
  assert.equal(Scoring.highStakesReason(m(GIR, SEV, "LEAGUE_STAGE"), cl, {}), null);
  assert.equal(Scoring.highStakesReason(m(GIR, SEV, "LAST_16"), cl, {}), "Knockout");
  assert.equal(Scoring.highStakesReason(m(GIR, SEV, "PLAYOFFS"), cl, {}), "Knockout");
  assert.equal(Scoring.highStakesReason(m(GIR, SEV, "FINAL"), cl, {}), "Final");
  assert.equal(Scoring.highStakesReason(m(RM, FCB, "LEAGUE_STAGE"), cl, {}), "El Clasico");

  const bl = { code: "BL1", kind: "league" };
  const bay = t(5, "FC Bayern München", "Bayern");
  const bvb = t(4, "Borussia Dortmund", "Dortmund");
  const kol = t(1, "1. FC Köln", "Köln");
  const bmg = t(18, "Borussia Mönchengladbach", "Gladbach");
  assert.equal(Scoring.highStakesReason(m(bay, bvb), bl, {}), "Der Klassiker");
  assert.equal(Scoring.highStakesReason(m(kol, bmg), bl, {}), "Rhine derby");

  const pl = { code: "PL", kind: "league" };
  const mun = t(66, "Manchester United FC", "Man United");
  const mci = t(65, "Manchester City FC", "Man City");
  const liv = t(64, "Liverpool FC", "Liverpool");
  const eve = t(62, "Everton FC", "Everton");
  assert.equal(Scoring.highStakesReason(m(mun, mci), pl, {}), "Manchester derby");
  assert.equal(Scoring.highStakesReason(m(eve, liv), pl, {}), "Merseyside derby");
});

test("winner multiplier by rank and progress", () => {
  assert.equal(Scoring.winnerMultiplier(1, 0), 1.5);
  assert.equal(Scoring.winnerMultiplier(3, 0), 4);
  assert.equal(Scoring.winnerMultiplier(6, 0), 10);
  assert.equal(Scoring.winnerMultiplier(7, 0), 15);
  assert.equal(Scoring.winnerMultiplier(20, 0), 15);
  assert.equal(Scoring.winnerMultiplier(3, 12 / 38), 3.37);
  assert.equal(Scoring.winnerMultiplier(1, 0.79), 1.1); // floor
  assert.equal(Scoring.winnerMultiplier(null, 0), 8);   // no single table
});

// ---------------- game ----------------
test("placing, changing and cancelling a match bet moves tokens correctly", () => {
  const data = makeData();
  const u = Game.newUser("ana", ["PD"], NOW);
  assert.equal(u.tokens, 100);
  const bet = Game.placeMatchBet(u, data, { comp: "PD", matchId: 1, pickHome: 2, pickAway: 2, stake: 20 }, NOW);
  assert.equal(u.tokens, 90); // 100 - 20 stake + 10 daily bonus for the first bet of the day
  assert.equal(bet.high, true); // Clasico
  // change: stake refunded then re-placed, and the daily bonus is not paid twice
  Game.placeMatchBet(u, data, { comp: "PD", matchId: 1, pickHome: 1, pickAway: 0, stake: 10 }, NOW);
  assert.equal(u.tokens, 100);
  assert.equal(u.bets.length, 1);
  // cancelling the only bet of the day gives the stake back and takes the daily bonus back
  Game.cancelMatchBet(u, data, u.bets[0].id, NOW);
  assert.equal(u.tokens, 100);
  assert.equal(u.bets.length, 0);
});

test("bet validation", () => {
  const data = makeData();
  const u = quiet(Game.newUser("ben", ["PD"], NOW));
  const ok = { comp: "PD", matchId: 2, pickHome: 1, pickAway: 1, stake: 5 };
  assert.throws(() => Game.placeMatchBet(u, data, Object.assign({}, ok, { stake: 7 }), NOW), /Stake must be/);
  assert.throws(() => Game.placeMatchBet(u, data, Object.assign({}, ok, { pickHome: -1 }), NOW), /whole-number/);
  assert.throws(() => Game.placeMatchBet(u, data, Object.assign({}, ok, { pickHome: 1.5 }), NOW), /whole-number/);
  assert.throws(() => Game.placeMatchBet(u, data, Object.assign({}, ok, { matchId: 3 }), NOW), /closed/); // finished
  assert.throws(() => Game.placeMatchBet(u, data, ok, NOW + 5 * DAY), /closed/); // after kickoff
  assert.throws(() => Game.placeMatchBet(u, data, Object.assign({}, ok, { comp: "PL" }), NOW), /not joined/);
  u.tokens = 5;
  assert.throws(() => Game.placeMatchBet(u, data, Object.assign({}, ok, { stake: 10 }), NOW), /Not enough/);
  assert.equal(Game.placeMatchBet(u, data, ok, NOW).stake, 5);
  assert.equal(u.tokens, 0);
  // cannot cancel after kickoff
  assert.throws(() => Game.cancelMatchBet(u, data, u.bets[0].id, NOW + 5 * DAY), /locked/);
});

test("settlement pays out finished matches once", () => {
  const data = makeData();
  const u = quiet(Game.newUser("cy", ["PD"], NOW));
  Game.placeMatchBet(u, data, { comp: "PD", matchId: 4, pickHome: 0, pickAway: 1, stake: 10 }, NOW);
  assert.equal(u.tokens, 90);
  assert.deepEqual(Game.settleAll(u, data, NOW), []); // not finished yet
  const m = data.competitions.PD.matches.find((x) => x.id === 4);
  m.status = "FINISHED"; m.score = { home: 0, away: 1 }; m.winner = "AWAY_TEAM";
  const ev = Game.settleAll(u, data, NOW + 3 * HOUR);
  assert.equal(ev.length, 1);
  assert.equal(u.tokens, 120); // 90 left after the stake + 30 payout (exact on a Catalan derby: 3x)
  assert.equal(u.bets[0].status, "settled");
  assert.equal(u.bets[0].exact, true);
  assert.deepEqual(Game.settleAll(u, data, NOW + 4 * HOUR), []); // no double payout
  assert.equal(u.tokens, 120);
});

test("cancelled match refunds the stake", () => {
  const data = makeData();
  const u = quiet(Game.newUser("di", ["PD"], NOW));
  Game.placeMatchBet(u, data, { comp: "PD", matchId: 2, pickHome: 1, pickAway: 0, stake: 15 }, NOW);
  data.competitions.PD.matches[1].status = "CANCELLED";
  Game.settleAll(u, data, NOW);
  assert.equal(u.tokens, 100);
  assert.equal(u.bets[0].status, "refunded");
});

test("weekly top-up only when below 5 and a week has passed", () => {
  const u = Game.newUser("ed", ["PD"], NOW);
  u.tokens = 3;
  assert.equal(Game.applyTopUp(u, NOW + 3 * DAY), false);
  assert.equal(Game.applyTopUp(u, NOW + 7 * DAY), true);
  assert.equal(u.tokens, 25);
  u.tokens = 2;
  assert.equal(Game.applyTopUp(u, NOW + 8 * DAY), false); // too soon after last top-up
  u.tokens = 50;
  assert.equal(Game.applyTopUp(u, NOW + 30 * DAY), false); // not below threshold
});

test("winner bets: lock, multiplier fixed, settle on champion", () => {
  const data = makeData();
  const u = quiet(Game.newUser("flo", ["PD"], NOW));
  const comp = data.competitions.PD;
  const opts = Game.winnerOptions(comp);
  assert.equal(opts[0].team.id, FCB.id);
  const bet = Game.placeWinnerBet(u, data, { comp: "PD", teamId: RM.id, stake: 30 }, NOW);
  assert.equal(u.tokens, 70);
  assert.equal(bet.multiplier, Scoring.winnerMultiplier(2, 120 / 380));
  assert.throws(() => Game.placeWinnerBet(u, data, { comp: "PD", teamId: FCB.id, stake: 10 }, NOW), /already picked/);
  // season ends with Real Madrid champions
  comp.finishedCount = 380;
  comp.champion = RM;
  const ev = Game.settleAll(u, data, NOW);
  assert.equal(ev.length, 1);
  assert.equal(u.winnerBets[0].won, true);
  assert.equal(u.tokens, 70 + Math.round(30 * bet.multiplier));
});

test("winner picks close late in the season and when champion is known", () => {
  const data = makeData();
  const u = Game.newUser("gus", ["PD"], NOW);
  data.competitions.PD.finishedCount = 320; // 84%
  assert.throws(() => Game.placeWinnerBet(u, data, { comp: "PD", teamId: FCB.id, stake: 10 }, NOW), /closed/);
});

test("a lost winner bet pays nothing; a voided one is refunded", () => {
  let data = makeData();
  const u = quiet(Game.newUser("hal", ["PD"], NOW));
  Game.placeWinnerBet(u, data, { comp: "PD", teamId: GIR.id, stake: 10 }, NOW);
  data.competitions.PD.champion = FCB;
  Game.settleAll(u, data, NOW);
  assert.equal(u.winnerBets[0].won, false);
  assert.equal(u.tokens, 90);

  const u2 = quiet(Game.newUser("ivy", ["PD"], NOW));
  data = makeData();
  Game.placeWinnerBet(u2, data, { comp: "PD", teamId: GIR.id, stake: 10 }, NOW);
  data.competitions.PD.seasonId = "PD-2027"; // feed moved to next season
  Game.settleAll(u2, data, NOW);
  assert.equal(u2.tokens, 100);
  assert.equal(u2.winnerBets[0].status, "refunded");
});

test("stats summarise bets", () => {
  const data = makeData();
  const u = Game.newUser("jo", ["PD"], NOW);
  Game.placeMatchBet(u, data, { comp: "PD", matchId: 4, pickHome: 0, pickAway: 1, stake: 10 }, NOW);
  Game.placeMatchBet(u, data, { comp: "PD", matchId: 2, pickHome: 1, pickAway: 0, stake: 5 }, NOW);
  const m = data.competitions.PD.matches.find((x) => x.id === 4);
  m.status = "FINISHED"; m.score = { home: 0, away: 1 };
  Game.settleAll(u, data, NOW);
  const s = Game.stats(u);
  assert.equal(s.placed, 2);
  assert.equal(s.settled, 1);
  assert.equal(s.wins, 1);
  assert.equal(s.exact, 1);
  assert.equal(s.netMatch, 20);
  assert.equal(s.open, 1);
  assert.equal(s.hitRate, 100);
});

test("export and import round-trip, and reject bad files", () => {
  const u = Game.newUser("kit", ["PD", "PL"], NOW);
  const text = Game.exportAll({ kit: u });
  const res = Game.importAll(text, { other: Game.newUser("other", ["PD"], NOW) });
  assert.equal(res.count, 1);
  assert.deepEqual(Object.keys(res.users).sort(), ["kit", "other"]);
  assert.throws(() => Game.importAll("not json", {}), /valid JSON/);
  assert.throws(() => Game.importAll(JSON.stringify({ hello: 1 }), {}), /does not look like/);
});

// ---------------- daily bonus ----------------
test("daily bonus: the first bet of each day pays 10 tokens, once", () => {
  const data = makeData();
  const u = Game.newUser("dan", ["PD"], NOW);
  assert.equal(Game.dailyClaimed(u, NOW), false);
  Game.placeMatchBet(u, data, { comp: "PD", matchId: 2, pickHome: 1, pickAway: 0, stake: 5 }, NOW);
  assert.equal(u.tokens, 105); // 100 - 5 stake + 10 bonus
  assert.equal(Game.dailyClaimed(u, NOW), true);
  Game.placeMatchBet(u, data, { comp: "PD", matchId: 1, pickHome: 1, pickAway: 1, stake: 5 }, NOW);
  assert.equal(u.tokens, 100); // a second bet the same day pays no extra bonus
  assert.equal(u.ledger.filter((e) => e.type === "daily").length, 1);
  // changing a bet on the next day counts as that day's bet
  Game.placeMatchBet(u, data, { comp: "PD", matchId: 1, pickHome: 2, pickAway: 1, stake: 5 }, NOW + DAY);
  assert.equal(u.tokens, 110);
  assert.equal(u.ledger.filter((e) => e.type === "daily").length, 2);
});

test("daily bonus: winner bets count too", () => {
  const data = makeData();
  const u = Game.newUser("eve", ["PD"], NOW);
  Game.placeWinnerBet(u, data, { comp: "PD", teamId: RM.id, stake: 30 }, NOW);
  assert.equal(u.tokens, 80); // 100 - 30 + 10
});

test("daily bonus is taken back if the only bet of the day is cancelled", () => {
  const data = makeData();
  const u = Game.newUser("fay", ["PD"], NOW);
  Game.placeMatchBet(u, data, { comp: "PD", matchId: 2, pickHome: 1, pickAway: 0, stake: 10 }, NOW);
  assert.equal(u.tokens, 100);
  Game.cancelMatchBet(u, data, u.bets[0].id, NOW);
  assert.equal(u.tokens, 100); // stake back, bonus removed again
  assert.equal(Game.dailyClaimed(u, NOW), false);
  // the bonus can be earned again by betting again that day
  Game.placeMatchBet(u, data, { comp: "PD", matchId: 2, pickHome: 1, pickAway: 0, stake: 10 }, NOW);
  assert.equal(u.tokens, 100);
  // with two bets that day, cancelling one keeps the bonus
  Game.placeMatchBet(u, data, { comp: "PD", matchId: 1, pickHome: 1, pickAway: 1, stake: 5 }, NOW);
  Game.cancelMatchBet(u, data, u.bets[1].id, NOW);
  assert.equal(u.tokens, 100); // 100 - 10 + 10 bonus (kept)
  assert.equal(Game.dailyClaimed(u, NOW), true);
});

test("taking the daily bonus back never makes the balance negative", () => {
  const data = makeData();
  const u = Game.newUser("gil", ["PD"], NOW);
  Game.placeMatchBet(u, data, { comp: "PD", matchId: 2, pickHome: 1, pickAway: 0, stake: 5 }, NOW);
  u.tokens = 0; // everything else was spent
  Game.cancelMatchBet(u, data, u.bets[0].id, NOW);
  assert.equal(u.tokens, 0); // 5 refunded, then only those 5 can be taken back
});

test("countdown text", () => {
  assert.equal(Game.countdownText(0), "Kick-off!");
  assert.equal(Game.countdownText(-5000), "Kick-off!");
  assert.equal(Game.countdownText(2 * DAY + 4 * HOUR + 59 * 60000), "2d 4h");
  assert.equal(Game.countdownText(3 * HOUR + 12 * 60000 + 30000), "3h 12m");
  assert.equal(Game.countdownText(9 * 60000 + 5000), "9m 05s");
  assert.equal(Game.countdownText(42000), "0m 42s");
});

// ---------------- Know Stats ----------------
function formData() {
  const m = (id, daysAgo, h, a, hs, as, stage) => ({ id, utcDate: iso(NOW - daysAgo * DAY), status: "FINISHED", matchday: 1, stage: stage || "REGULAR_SEASON", home: h, away: a, score: { home: hs, away: as }, winner: null });
  const comp = makeData().competitions.PD;
  comp.matches = [
    m(11, 20, RM, FCB, 1, 1), m(12, 18, RM, ATM, 2, 0), m(13, 16, GIR, RM, 0, 3), m(14, 14, RM, SEV, 1, 2),
    m(15, 12, ESP, RM, 0, 0), m(16, 10, RM, GIR, 4, 1), m(17, 8, FCB, ATM, 3, 0),
    { id: 18, utcDate: iso(NOW + 2 * DAY), status: "SCHEDULED", matchday: 14, stage: "REGULAR_SEASON", home: RM, away: FCB, score: null, winner: null }
  ];
  return comp;
}

test("team records and last-5 form come from finished matches only", () => {
  const comp = formData();
  const rec = Game.teamRecords(comp)[RM.id];
  assert.deepEqual([rec.played, rec.w, rec.d, rec.l, rec.gf, rec.ga, rec.pts], [6, 3, 2, 1, 11, 4, 11]);
  const pv = Game.matchPreview(comp, comp.matches[7], false);
  assert.equal(pv.home.team.id, RM.id);
  assert.equal(pv.home.form.map((r) => r.res).join(""), "WWLDW"); // last 5, oldest first
  assert.equal(pv.home.formPts, 10);
  assert.equal(pv.home.form[0].opp.id, ATM.id);
  assert.equal(pv.home.form[1].home, false); // away at Girona
  assert.equal(pv.home.position, 2);          // from the table
  assert.equal(pv.home.tableSize, 6);
  assert.equal(pv.home.points, 29);           // points come from the table row
  assert.equal(pv.away.form.map((r) => r.res).join(""), "DW");   // Barca: 1-1 then 3-0
});

test("a team with no matches has empty form", () => {
  const comp = makeData().competitions.PD; // only Atletico v Espanyol is finished
  const pv = Game.matchPreview(comp, comp.matches[0], false);
  assert.equal(pv.home.form.length, 0);
  assert.equal(pv.home.w + pv.home.d + pv.home.l, 0);
  assert.equal(pv.home.position, 2);
});

test("cups: W/D/L covers the league phase only, form covers every round", () => {
  const comp = formData();
  comp.kind = "cup";
  comp.matches = [
    { id: 1, utcDate: iso(NOW - 9 * DAY), status: "FINISHED", stage: "LEAGUE_STAGE", home: RM, away: FCB, score: { home: 1, away: 0 } },
    { id: 2, utcDate: iso(NOW - 2 * DAY), status: "FINISHED", stage: "LAST_16", home: ATM, away: RM, score: { home: 2, away: 0 } }
  ];
  const rec = Game.teamRecords(comp)[RM.id];
  assert.deepEqual([rec.played, rec.w, rec.l], [1, 1, 0]);
  assert.equal(rec.results.length, 2);
  const pv = Game.matchPreview(comp, { home: RM, away: ATM }, false);
  assert.equal(pv.home.form.map((r) => r.res).join(""), "WL");
});

test("mini table: window around both teams, gaps, highlights and full table", () => {
  const comp = makeData().competitions.PD;
  const teams = [];
  for (let i = 0; i < 10; i++) teams.push(t(100 + i, "Team " + i));
  comp.standings = table(teams);
  comp.matches = [];
  const [tab] = Game.matchPreview(comp, { home: teams[0], away: teams[9] }, false).tables;
  assert.deepEqual(tab.rows.map((r) => (r.gap ? "gap" : r.position)), [1, 2, 3, "gap", 8, 9, 10]);
  assert.equal(tab.rows[0].side, "home");
  assert.equal(tab.rows[6].side, "away");
  assert.equal(tab.rows[1].side, null);
  assert.equal(tab.size, 10);
  const [full] = Game.matchPreview(comp, { home: teams[0], away: teams[9] }, true).tables;
  assert.equal(full.rows.length, 10);
  // neighbouring teams share one table with no gap
  const [near] = Game.matchPreview(comp, { home: teams[4], away: teams[5] }, false).tables;
  assert.deepEqual(near.rows.map((r) => r.position), [3, 4, 5, 6, 7, 8]);
});

test("world cup style groups: each team gets the table of its own group", () => {
  const comp = makeData().competitions.PD;
  comp.kind = "cup";
  comp.standings = [
    { group: "GROUP_A", stage: "GROUP_STAGE", table: [{ position: 1, team: RM, played: 1, points: 3, gd: 2 }, { position: 2, team: FCB, played: 1, points: 0, gd: -2 }] },
    { group: "GROUP_B", stage: "GROUP_STAGE", table: [{ position: 1, team: ATM, played: 1, points: 1, gd: 0 }, { position: 2, team: GIR, played: 1, points: 1, gd: 0 }] }
  ];
  const pv = Game.matchPreview(comp, { home: RM, away: GIR }, false);
  assert.equal(pv.tables.length, 2);
  assert.deepEqual(pv.tables.map((x) => x.group), ["GROUP_A", "GROUP_B"]);
  assert.equal(pv.home.groupName, "GROUP_A");
  assert.equal(pv.away.position, 2);
});

// ---------------- streaks and badges ----------------
let betSeq = 0;
function settledBet(pick, result, extra) {
  betSeq++;
  const bet = Object.assign({
    id: "s" + betSeq, matchId: betSeq, comp: "PD", home: "A", away: "B", kickoff: iso(NOW - (500 - betSeq) * HOUR),
    placedAt: iso(NOW - (510 - betSeq) * HOUR), pickHome: pick[0], pickAway: pick[1], stake: 10, high: false, status: "settled"
  }, extra);
  const r = Scoring.settleMatchBet(bet, { home: result[0], away: result[1] });
  return Object.assign(bet, { result: { home: result[0], away: result[1] }, error: r.error, exact: r.exact, multiplier: r.multiplier, payout: r.payout, net: r.net });
}
function userWith(bets) {
  const u = Game.newUser("badge", ["PD"], NOW);
  u.bets = bets;
  return u;
}
const earnedIds = (u) => Object.keys(u.badges).sort();

test("streaks count settled bets in kickoff order", () => {
  const u = userWith([
    settledBet([1, 0], [2, 0]), settledBet([2, 1], [3, 1]), settledBet([0, 0], [1, 1]), // three right results (draw included)
    settledBet([1, 0], [0, 2])                                                         // wrong result breaks it
  ]);
  const st = Game.streaks(u);
  assert.deepEqual([st.right.current, st.right.best], [0, 3]);
  assert.deepEqual([st.close.current, st.close.best], [0, 2]); // errors 1, 1, 2, 3: two within one goal
  assert.deepEqual([st.profit.current, st.profit.best], [0, 2]); // 1.5x, 1.5x, 0.5x
  const fresh = Game.updateBadges(u, NOW).map((b) => b.id);
  assert.ok(fresh.includes("hattrick"));
  assert.ok(fresh.includes("kickoff"));
  assert.ok(fresh.includes("green"));
  assert.ok(!fresh.includes("fire"));
  assert.ok(!fresh.includes("laser"));
  assert.ok(!fresh.includes("machine"));
  assert.deepEqual(Game.updateBadges(u, NOW), []); // nothing announced twice
});

test("exact-score badges", () => {
  const u = userWith([
    settledBet([2, 1], [2, 1], { high: true }),  // exact in a high-stakes match
    settledBet([1, 1], [1, 1]),                  // exact draw
    settledBet([3, 2], [3, 2], { stake: 20, high: true }) // five goals, 3x on 20 = +40
  ]);
  const ids = Game.updateBadges(u, NOW).map((b) => b.id);
  for (const id of ["bullseye", "sharpshooter", "double", "biggame", "draw", "goalfest", "jackpot", "hattrick"]) assert.ok(ids.includes(id), id);
  assert.ok(!ids.includes("crystal"));
  assert.ok(ids.includes("machine")); // three in profit in a row
});

test("analyst needs 70% right results over at least 10 settled bets", () => {
  const make = (right) => userWith(Array.from({ length: 10 }, (_, i) => (i < right ? settledBet([1, 0], [1, 0]) : settledBet([1, 0], [0, 1]))));
  assert.ok(Game.updateBadges(make(7), NOW).some((b) => b.id === "analyst"));
  assert.ok(!Game.updateBadges(make(6), NOW).some((b) => b.id === "analyst"));
});

test("other badges: globetrotter, regular, season seer, banker", () => {
  const u = userWith([]);
  for (let i = 0; i < 7; i++) u.bets.push({ id: "o" + i, comp: ["PD", "PL", "CL"][i % 3], status: "open", placedAt: iso(NOW - i * DAY), stake: 5 });
  u.winnerBets.push({ id: "w1", comp: "PD", status: "settled", won: true, net: 20, stake: 10, placedAt: iso(NOW) });
  u.tokens = 250;
  const ids = Game.updateBadges(u, NOW).map((b) => b.id);
  for (const id of ["globe", "regular", "seer", "banker", "kickoff"]) assert.ok(ids.includes(id), id);
});

test("badge status shows progress and keeps earned badges", () => {
  const u = userWith([settledBet([1, 0], [1, 0]), settledBet([1, 0], [1, 0])]);
  Game.updateBadges(u, NOW);
  let list = Game.badgeStatus(u);
  assert.equal(list.length, 20);
  const sharp = list.find((b) => b.id === "sharpshooter");
  assert.deepEqual([sharp.earned, sharp.have, sharp.need], [false, 2, 3]);
  assert.equal(list.find((b) => b.id === "bullseye").earned, true);
  assert.equal(list.find((b) => b.id === "bullseye").earnedAt, new Date(NOW).toISOString());
  u.bets = []; // even if the bets disappear, the earned badge stays
  list = Game.badgeStatus(u);
  assert.equal(list.find((b) => b.id === "bullseye").earned, true);
});

test("older players and backups get the new fields", () => {
  const old = { nick: "old", created: iso(NOW), leagues: ["PD"], tokens: 50, lastTopUp: iso(NOW), bets: [], winnerBets: [] }; // no ledger, badges or dailyDays
  const res = Game.importAll(JSON.stringify({ app: "football-prediction-game", version: 1, users: { old } }), {});
  const u = res.users.old;
  assert.deepEqual(u.badges, {});
  assert.deepEqual(u.dailyDays, []);
  assert.deepEqual(u.ledger, []);
  assert.equal(Game.dailyClaimed(u, NOW), false);
  assert.deepEqual(Game.updateBadges(u, NOW), []);
});
