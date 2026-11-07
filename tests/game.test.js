// Run with: node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const Scoring = require("../js/scoring.js");
const Game = require("../js/game.js");

const NOW = Date.parse("2026-11-07T10:00:00Z");
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();

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
  assert.equal(u.tokens, 80);
  assert.equal(bet.high, true); // Clasico
  // change: stake refunded then re-placed
  Game.placeMatchBet(u, data, { comp: "PD", matchId: 1, pickHome: 1, pickAway: 0, stake: 10 }, NOW);
  assert.equal(u.tokens, 90);
  assert.equal(u.bets.length, 1);
  Game.cancelMatchBet(u, data, u.bets[0].id, NOW);
  assert.equal(u.tokens, 100);
  assert.equal(u.bets.length, 0);
});

test("bet validation", () => {
  const data = makeData();
  const u = Game.newUser("ben", ["PD"], NOW);
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
  const u = Game.newUser("cy", ["PD"], NOW);
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
  const u = Game.newUser("di", ["PD"], NOW);
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
  const u = Game.newUser("flo", ["PD"], NOW);
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
  const u = Game.newUser("hal", ["PD"], NOW);
  Game.placeWinnerBet(u, data, { comp: "PD", teamId: GIR.id, stake: 10 }, NOW);
  data.competitions.PD.champion = FCB;
  Game.settleAll(u, data, NOW);
  assert.equal(u.winnerBets[0].won, false);
  assert.equal(u.tokens, 90);

  const u2 = Game.newUser("ivy", ["PD"], NOW);
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
