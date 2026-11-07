/* Game logic: players, tokens, bets and settlement. No DOM, so it runs under Node for tests.
   `data` is the parsed data/data.json: { fetchedAt, competitions: { PL: {...}, ... } }. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./scoring.js"));
  else root.Game = factory(root.Scoring);
})(typeof self !== "undefined" ? self : this, function (Scoring) {
  "use strict";

  var R = Scoring.RULES;
  var DAY = 24 * 60 * 60 * 1000;
  var BETTABLE = ["SCHEDULED", "TIMED"];

  function id(prefix) {
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function fail(msg) { throw new Error(msg); }

  function newUser(nick, leagues, now) {
    var iso = new Date(now).toISOString();
    return {
      nick: nick,
      created: iso,
      leagues: leagues.slice(),
      tokens: R.startTokens,
      lastTopUp: iso,
      bets: [],
      winnerBets: [],
      ledger: [{ ts: iso, type: "start", amount: R.startTokens, note: "Starting tokens", balance: R.startTokens }]
    };
  }

  function credit(user, amount, type, note, now) {
    user.tokens = Scoring.round1(user.tokens + amount);
    user.ledger.push({
      ts: new Date(now).toISOString(), type: type, amount: Scoring.round1(amount),
      note: note, balance: user.tokens
    });
  }

  // Free weekly top-up: below the threshold and a week since the last one.
  function applyTopUp(user, now) {
    if (user.tokens >= R.topUpBelow) return false;
    if (now - new Date(user.lastTopUp).getTime() < R.topUpEveryDays * DAY) return false;
    credit(user, R.topUpTo - user.tokens, "topup", "Free weekly top-up to " + R.topUpTo, now);
    user.lastTopUp = new Date(now).toISOString();
    return true;
  }

  function findMatch(data, compCode, matchId) {
    var comp = data && data.competitions && data.competitions[compCode];
    if (!comp) return null;
    for (var i = 0; i < comp.matches.length; i++) if (comp.matches[i].id === matchId) return comp.matches[i];
    return null;
  }

  function openBetFor(user, compCode, matchId) {
    for (var i = 0; i < user.bets.length; i++) {
      var b = user.bets[i];
      if (b.status === "open" && b.comp === compCode && b.matchId === matchId) return b;
    }
    return null;
  }

  function validGoal(n) { return typeof n === "number" && isFinite(n) && n % 1 === 0 && n >= 0 && n <= R.maxGoals; }

  function canBet(match, now) {
    return !!match && BETTABLE.indexOf(match.status) !== -1 &&
      match.home.id != null && match.away.id != null && now < new Date(match.utcDate).getTime();
  }

  // Places a new bet, or replaces the player's open bet on the same match (stake refunded first).
  function placeMatchBet(user, data, req, now) {
    if (user.leagues.indexOf(req.comp) === -1) fail("You have not joined this league.");
    var comp = data.competitions[req.comp];
    var match = findMatch(data, req.comp, req.matchId);
    if (!comp || !match) fail("That match is not available.");
    if (!canBet(match, now)) fail("Betting has closed for this match.");
    if (!validGoal(req.pickHome) || !validGoal(req.pickAway)) fail("Enter whole-number goals between 0 and " + R.maxGoals + ".");
    if (R.stakes.indexOf(req.stake) === -1) fail("Stake must be one of " + R.stakes.join(", ") + ".");

    var existing = openBetFor(user, req.comp, req.matchId);
    var available = user.tokens + (existing ? existing.stake : 0);
    if (req.stake > available) fail("Not enough tokens for that stake.");
    if (existing) {
      credit(user, existing.stake, "refund", "Bet changed: " + match.home.short + " v " + match.away.short, now);
      user.bets.splice(user.bets.indexOf(existing), 1);
    }
    var reason = Scoring.highStakesReason(match, comp, Scoring.rankMap(comp), R);
    var bet = {
      id: id("b"), matchId: match.id, comp: req.comp, home: match.home.short, away: match.away.short,
      kickoff: match.utcDate, pickHome: req.pickHome, pickAway: req.pickAway, stake: req.stake,
      high: !!reason, highReason: reason, placedAt: new Date(now).toISOString(), status: "open"
    };
    credit(user, -req.stake, "stake", "Bet: " + bet.home + " " + bet.pickHome + "-" + bet.pickAway + " " + bet.away, now);
    user.bets.push(bet);
    return bet;
  }

  function cancelMatchBet(user, data, betId, now) {
    var bet = null;
    for (var i = 0; i < user.bets.length; i++) if (user.bets[i].id === betId) bet = user.bets[i];
    if (!bet || bet.status !== "open") fail("Bet not found.");
    var match = findMatch(data, bet.comp, bet.matchId);
    var kickoff = match ? new Date(match.utcDate).getTime() : new Date(bet.kickoff).getTime();
    if (now >= kickoff) fail("The match has started, so this bet is locked.");
    credit(user, bet.stake, "refund", "Bet cancelled: " + bet.home + " v " + bet.away, now);
    user.bets.splice(user.bets.indexOf(bet), 1);
  }

  // ---- season winner bets ----
  function winnerStatus(comp, user) {
    if (!comp) return { open: false, reason: "League not available." };
    if (comp.champion) return { open: false, reason: "Season finished. Champion: " + comp.champion.name + "." };
    var progress = Scoring.seasonProgress(comp);
    if (progress >= R.winner.closeAtProgress) {
      return { open: false, reason: "Winner picks have closed (" + Math.round(R.winner.closeAtProgress * 100) + "% of the season played)." };
    }
    var existing = user && winnerBetFor(user, comp);
    if (existing) return { open: false, reason: "You already picked " + existing.teamName + ". Picks are locked." };
    if (!comp.standings || !comp.standings.length) return { open: false, reason: "Table not available yet." };
    return { open: true, reason: "" };
  }

  function winnerBetFor(user, comp) {
    for (var i = 0; i < user.winnerBets.length; i++) {
      var b = user.winnerBets[i];
      if (b.comp === comp.code && b.seasonId === comp.seasonId) return b;
    }
    return null;
  }

  function winnerOptions(comp) {
    var progress = Scoring.seasonProgress(comp);
    var groups = comp.standings || [];
    var single = comp.kind === "league" && groups.length === 1;
    var opts = [];
    groups.forEach(function (g) {
      g.table.forEach(function (row) {
        var rank = single ? row.position : null;
        opts.push({ team: row.team, rank: rank, multiplier: Scoring.winnerMultiplier(rank, progress, R) });
      });
    });
    opts.sort(function (a, b) {
      if (a.rank != null && b.rank != null) return a.rank - b.rank;
      return String(a.team.name).localeCompare(String(b.team.name));
    });
    return opts;
  }

  function placeWinnerBet(user, data, req, now) {
    if (user.leagues.indexOf(req.comp) === -1) fail("You have not joined this league.");
    var comp = data.competitions[req.comp];
    var status = winnerStatus(comp, user);
    if (!status.open) fail(status.reason);
    var opt = null;
    winnerOptions(comp).forEach(function (o) { if (o.team.id === req.teamId) opt = o; });
    if (!opt) fail("Pick a team from the list.");
    if (typeof req.stake !== "number" || req.stake % 1 !== 0 || req.stake < 1) fail("Stake must be a whole number of tokens.");
    if (req.stake > user.tokens) fail("Not enough tokens for that stake.");
    var bet = {
      id: id("w"), comp: comp.code, seasonId: comp.seasonId, teamId: opt.team.id, teamName: opt.team.name,
      stake: req.stake, multiplier: opt.multiplier, placedAt: new Date(now).toISOString(), status: "open"
    };
    credit(user, -req.stake, "stake", "Season winner: " + opt.team.name + " (" + comp.name + ")", now);
    user.winnerBets.push(bet);
    return bet;
  }

  // ---- settlement ----
  // Returns a list of human-readable events for the UI.
  function settleAll(user, data, now) {
    var events = [];
    var comps = (data && data.competitions) || {};

    user.bets.forEach(function (bet) {
      if (bet.status !== "open") return;
      var match = findMatch(data, bet.comp, bet.matchId);
      if (!match) return;
      if (match.status === "FINISHED" && match.score) {
        var res = Scoring.settleMatchBet(bet, match.score);
        bet.status = "settled";
        bet.result = { home: match.score.home, away: match.score.away };
        bet.error = res.error; bet.multiplier = res.multiplier; bet.payout = res.payout;
        bet.net = res.net; bet.exact = res.exact;
        if (res.payout > 0) credit(user, res.payout, "payout", "Payout: " + bet.home + " v " + bet.away, now);
        events.push(bet.home + " " + match.score.home + "-" + match.score.away + " " + bet.away + ": " +
          (res.net >= 0 ? "+" : "") + res.net + " tokens");
      } else if (match.status === "CANCELLED") {
        bet.status = "refunded"; bet.net = 0;
        credit(user, bet.stake, "refund", "Match cancelled: " + bet.home + " v " + bet.away, now);
        events.push(bet.home + " v " + bet.away + " was cancelled: stake refunded");
      }
    });

    user.winnerBets.forEach(function (bet) {
      if (bet.status !== "open") return;
      var comp = comps[bet.comp];
      if (!comp) return;
      if (comp.seasonId !== bet.seasonId) {
        // The feed moved on to a new season without us seeing a champion: void the bet.
        bet.status = "refunded"; bet.won = false; bet.payout = 0; bet.net = 0;
        credit(user, bet.stake, "refund", "Season ended, bet voided: " + bet.teamName, now);
        events.push("Season winner bet on " + bet.teamName + " was voided: stake refunded");
      } else if (comp.champion) {
        var res = Scoring.settleWinnerBet(bet, comp.champion);
        bet.status = "settled"; bet.won = res.won; bet.payout = res.payout;
        bet.net = Scoring.round1(res.payout - bet.stake);
        if (res.payout > 0) credit(user, res.payout, "payout", "Season winner payout: " + bet.teamName, now);
        events.push(comp.name + " champion " + comp.champion.name + ": your pick " + bet.teamName + (res.won ? " won +" + bet.net : " lost " + bet.net));
      }
    });
    return events;
  }

  // ---- stats ----
  function stats(user) {
    var s = {
      balance: user.tokens, placed: 0, settled: 0, wins: 0, exact: 0, netMatch: 0, netWinner: 0,
      open: 0, openStake: 0, byLeague: {}
    };
    function league(code) {
      if (!s.byLeague[code]) s.byLeague[code] = { bets: 0, settled: 0, wins: 0, exact: 0, net: 0 };
      return s.byLeague[code];
    }
    user.bets.forEach(function (b) {
      s.placed++;
      var l = league(b.comp); l.bets++;
      if (b.status === "open") { s.open++; s.openStake += b.stake; }
      if (b.status === "settled") {
        s.settled++; l.settled++;
        if (b.net > 0) { s.wins++; l.wins++; }
        if (b.exact) { s.exact++; l.exact++; }
        s.netMatch = Scoring.round1(s.netMatch + b.net);
        l.net = Scoring.round1(l.net + b.net);
      }
    });
    user.winnerBets.forEach(function (b) {
      var l = league(b.comp);
      if (b.status === "open") { s.open++; s.openStake += b.stake; }
      if (b.status === "settled") {
        s.netWinner = Scoring.round1(s.netWinner + b.net);
        l.net = Scoring.round1(l.net + b.net);
      }
    });
    s.hitRate = s.settled ? Math.round((s.wins / s.settled) * 100) : null;
    return s;
  }

  // ---- backup / restore ----
  function exportAll(users) {
    return JSON.stringify({ app: "football-prediction-game", version: 1, exportedAt: new Date().toISOString(), users: users }, null, 2);
  }

  function importAll(text, existing) {
    var parsed;
    try { parsed = JSON.parse(text); } catch (e) { fail("That file is not valid JSON."); }
    if (!parsed || parsed.app !== "football-prediction-game" || !parsed.users || typeof parsed.users !== "object") {
      fail("That does not look like a backup from this game.");
    }
    var merged = Object.assign({}, existing);
    var count = 0;
    Object.keys(parsed.users).forEach(function (nick) {
      var u = parsed.users[nick];
      if (u && typeof u.tokens === "number" && Array.isArray(u.bets) && Array.isArray(u.winnerBets) && Array.isArray(u.leagues)) {
        if (!Array.isArray(u.ledger)) u.ledger = [];
        merged[nick] = u;
        count++;
      }
    });
    if (!count) fail("No players found in that file.");
    return { users: merged, count: count };
  }

  return {
    newUser: newUser,
    applyTopUp: applyTopUp,
    findMatch: findMatch,
    openBetFor: openBetFor,
    canBet: canBet,
    placeMatchBet: placeMatchBet,
    cancelMatchBet: cancelMatchBet,
    winnerStatus: winnerStatus,
    winnerBetFor: winnerBetFor,
    winnerOptions: winnerOptions,
    placeWinnerBet: placeWinnerBet,
    settleAll: settleAll,
    stats: stats,
    exportAll: exportAll,
    importAll: importAll
  };
});
