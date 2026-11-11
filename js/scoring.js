/* Scoring rules and payout maths. No DOM, so it also runs under Node for tests. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Scoring = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // All tunable numbers live here.
  var RULES = {
    startTokens: 100,
    stakes: [5, 10, 15, 20, 25],
    topUpBelow: 5,
    topUpTo: 25,
    topUpEveryDays: 7,
    dailyBonus: 10, // free tokens for the first bet placed each day
    // Match bet multipliers by total goal error
    multExact: 2,
    multExactHigh: 3,
    multOff1: 1.5,
    multOff2: 0.5,
    multOff3Plus: 0,
    wrongResultCap: 0.5, // max multiplier when win/draw/loss is wrong
    maxGoals: 20,
    topN: 6, // "top-6 clash" rule for domestic leagues
    // Season winner bet
    winner: {
      tiers: [[1, 1.5], [2, 2.5], [3, 4], [4, 6], [5, 10], [7, 15]], // [rank from, base multiplier]
      progressReduction: 0.5, // share of the base removed by the end of the season
      minMultiplier: 1.1,
      flatMultiplier: 8, // when there is no single table (e.g. World Cup groups)
      closeAtProgress: 0.8 // winner picks close once this share of matches is played
    }
  };

  var NON_KNOCKOUT_STAGES = ["REGULAR_SEASON", "LEAGUE_STAGE", "GROUP_STAGE"];

  // ---- Rivalries (accent-free lowercase keywords; each side lists alternatives) ----
  function r(name, a, b) { return { name: name, a: a, b: b }; }
  var PL = [
    r("Manchester derby", ["manchester united", "man united"], ["manchester city", "man city"]),
    r("Merseyside derby", ["liverpool"], ["everton"]),
    r("North London derby", ["arsenal"], ["tottenham"]),
    r("North West derby", ["liverpool"], ["manchester united", "man united"]),
    r("Liverpool v Man City", ["liverpool"], ["manchester city", "man city"]),
    r("Arsenal v Man United", ["arsenal"], ["manchester united", "man united"]),
    r("London derby", ["arsenal"], ["chelsea"]),
    r("London derby", ["chelsea"], ["tottenham"]),
    r("London derby", ["west ham"], ["tottenham"]),
    r("London derby", ["west ham"], ["chelsea"]),
    r("Tyne-Wear derby", ["newcastle"], ["sunderland"]),
    r("M23 derby", ["crystal palace"], ["brighton"]),
    r("Roses match", ["leeds"], ["manchester united", "man united"])
  ];
  var PD = [
    r("El Clasico", ["real madrid"], ["fc barcelona", "barca"]),
    r("Madrid derby", ["real madrid"], ["atletico"]),
    r("Catalan derby", ["fc barcelona", "barca"], ["espanyol"]),
    r("Seville derby", ["sevilla"], ["betis"]),
    r("Basque derby", ["athletic"], ["real sociedad"]),
    r("Valencian derby", ["valencia"], ["villarreal"]),
    r("Valencian derby", ["valencia"], ["levante"])
  ];
  var BL1 = [
    r("Der Klassiker", ["bayern"], ["dortmund"]),
    r("Revierderby", ["dortmund"], ["schalke"]),
    r("Hamburg derby", ["hamburg"], ["pauli"]),
    r("Nordderby", ["hamburg"], ["werder"]),
    r("Rhine derby", ["koln"], ["gladbach"]),
    r("Rhine derby", ["koln"], ["leverkusen"]),
    r("Rhein-Main derby", ["frankfurt"], ["mainz"])
  ];
  var EUROPE = [
    r("Real Madrid v Bayern", ["real madrid"], ["bayern"]),
    r("Real Madrid v Man City", ["real madrid"], ["manchester city", "man city"]),
    r("Real Madrid v Liverpool", ["real madrid"], ["liverpool"]),
    r("Real Madrid v Juventus", ["real madrid"], ["juventus"]),
    r("Barcelona v Bayern", ["fc barcelona", "barca"], ["bayern"]),
    r("Milan derby", ["internazionale", "inter milan"], ["ac milan"]),
    r("Derby d'Italia", ["juventus"], ["internazionale", "inter milan"]),
    r("Juventus v Milan", ["juventus"], ["ac milan"]),
    r("Le Classique", ["paris"], ["marseille"]),
    r("Dutch Klassieker", ["ajax"], ["feyenoord"]),
    r("Portuguese Classico", ["benfica"], ["porto"]),
    r("Portuguese Classico", ["sporting"], ["porto"]),
    r("Lisbon derby", ["benfica"], ["sporting"]),
    r("Intercontinental derby", ["galatasaray"], ["fenerbahce"]),
    r("Old Firm", ["celtic"], ["rangers"])
  ];
  var RIVALRIES = {
    PL: PL,
    PD: PD,
    BL1: BL1,
    CL: PL.concat(PD, BL1, EUROPE),
    WC: []
  };

  // ---- helpers ----
  function round1(x) { return Math.round(x * 10) / 10; }
  function round2(x) { return Math.round(x * 100) / 100; }
  function sign(n) { return n > 0 ? 1 : n < 0 ? -1 : 0; }
  function norm(s) {
    return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  }
  function hay(team) { return norm((team.name || "") + " " + (team.short || "")); }
  function hasAny(h, words) {
    for (var i = 0; i < words.length; i++) if (h.indexOf(words[i]) !== -1) return true;
    return false;
  }

  // ---- match bets ----
  function totalError(pred, actual) {
    return Math.abs(pred.home - actual.home) + Math.abs(pred.away - actual.away);
  }

  function matchMultiplier(pred, actual, high, rules) {
    rules = rules || RULES;
    var err = totalError(pred, actual);
    var m;
    if (err === 0) m = high ? rules.multExactHigh : rules.multExact;
    else if (err === 1) m = rules.multOff1;
    else if (err === 2) m = rules.multOff2;
    else m = rules.multOff3Plus;
    if (sign(pred.home - pred.away) !== sign(actual.home - actual.away)) {
      m = Math.min(m, rules.wrongResultCap);
    }
    return { error: err, multiplier: m };
  }

  function settleMatchBet(bet, actual, rules) {
    var res = matchMultiplier({ home: bet.pickHome, away: bet.pickAway }, actual, bet.high, rules);
    var payout = round1(bet.stake * res.multiplier);
    return {
      error: res.error,
      multiplier: res.multiplier,
      payout: payout,
      net: round1(payout - bet.stake),
      exact: res.error === 0
    };
  }

  // ---- high-stakes detection ----
  // rankById: { teamId: position } from the current league table (domestic leagues only).
  function highStakesReason(match, comp, rankById, rules) {
    rules = rules || RULES;
    if (match.stage === "FINAL") return "Final";
    if ((comp.kind === "cup") && match.stage && NON_KNOCKOUT_STAGES.indexOf(match.stage) === -1) {
      return "Knockout";
    }
    var list = RIVALRIES[comp.code] || [];
    var h = hay(match.home), a = hay(match.away);
    for (var i = 0; i < list.length; i++) {
      var rv = list[i];
      if ((hasAny(h, rv.a) && hasAny(a, rv.b)) || (hasAny(h, rv.b) && hasAny(a, rv.a))) return rv.name;
    }
    if (comp.kind === "league" && rankById) {
      var rh = rankById[match.home.id], ra = rankById[match.away.id];
      if (rh && ra && rh <= rules.topN && ra <= rules.topN) return "Top-" + rules.topN + " clash";
    }
    return null;
  }

  function rankMap(comp) {
    var map = {};
    var groups = comp.standings || [];
    if (comp.kind === "league" && groups.length === 1) {
      groups[0].table.forEach(function (row) { map[row.team.id] = row.position; });
    }
    return map;
  }

  // ---- season winner bets ----
  function seasonProgress(comp) {
    if (!comp.totalCount) return 0;
    return Math.min(1, comp.finishedCount / comp.totalCount);
  }

  function baseMultiplier(rank, rules) {
    var w = (rules || RULES).winner;
    var base = w.tiers[0][1];
    for (var i = 0; i < w.tiers.length; i++) if (rank >= w.tiers[i][0]) base = w.tiers[i][1];
    return base;
  }

  // rank may be null (no single table); then the flat multiplier is the base.
  function winnerMultiplier(rank, progress, rules) {
    var w = (rules || RULES).winner;
    var base = rank ? baseMultiplier(rank, rules) : w.flatMultiplier;
    return Math.max(w.minMultiplier, round2(base * (1 - progress * w.progressReduction)));
  }

  function settleWinnerBet(bet, champion) {
    var won = !!champion && champion.id === bet.teamId;
    return { won: won, payout: won ? Math.round(bet.stake * bet.multiplier) : 0 };
  }

  return {
    RULES: RULES,
    RIVALRIES: RIVALRIES,
    NON_KNOCKOUT_STAGES: NON_KNOCKOUT_STAGES,
    round1: round1,
    norm: norm,
    totalError: totalError,
    matchMultiplier: matchMultiplier,
    settleMatchBet: settleMatchBet,
    highStakesReason: highStakesReason,
    rankMap: rankMap,
    seasonProgress: seasonProgress,
    baseMultiplier: baseMultiplier,
    winnerMultiplier: winnerMultiplier,
    settleWinnerBet: settleWinnerBet
  };
});
