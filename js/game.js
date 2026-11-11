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
      badges: {},     // badge id -> when it was earned
      dailyDays: [],  // days (YYYY-MM-DD) on which the daily bonus was paid
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
    claimDaily(user, now);
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
    revokeDaily(user, bet, now);
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
    claimDaily(user, now);
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

  // ---- daily bonus: the first bet of each day earns a few free tokens ----
  function pad2(n) { return n < 10 ? "0" + n : String(n); }
  function dayKey(when) {
    var d = new Date(when);
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  function normalizeUser(user) {
    if (!user.badges || typeof user.badges !== "object" || Array.isArray(user.badges)) user.badges = {};
    if (!Array.isArray(user.dailyDays)) user.dailyDays = [];
    if (!Array.isArray(user.ledger)) user.ledger = [];
    return user;
  }

  function dailyClaimed(user, now) {
    normalizeUser(user);
    return user.dailyDays.indexOf(dayKey(now)) !== -1;
  }

  function claimDaily(user, now) {
    if (dailyClaimed(user, now)) return false;
    user.dailyDays.push(dayKey(now));
    if (user.dailyDays.length > 60) user.dailyDays.shift();
    credit(user, R.dailyBonus, "daily", "Daily bonus: you placed a bet today", now);
    return true;
  }

  // If the only bet that earned a day's bonus is cancelled, the bonus is taken back
  // (otherwise someone could place a bet, collect the bonus and cancel it every day).
  function revokeDaily(user, bet, now) {
    if (!bet.placedAt) return;
    var day = dayKey(bet.placedAt);
    var at = user.dailyDays.indexOf(day);
    if (at === -1) return;
    function sameDay(b) { return b.placedAt && dayKey(b.placedAt) === day; }
    if (user.bets.some(sameDay) || user.winnerBets.some(sameDay)) return;
    user.dailyDays.splice(at, 1);
    var amount = Math.min(R.dailyBonus, user.tokens);
    if (amount > 0) credit(user, -amount, "daily-revoke", "Daily bonus removed: bet cancelled", now);
  }

  // "2d 4h", "3h 12m", "9m 05s". Used by the kickoff countdown.
  function countdownText(ms) {
    if (!(ms > 0)) return "Kick-off!";
    var s = Math.floor(ms / 1000);
    var d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (d >= 1) return d + "d " + h + "h";
    if (h >= 1) return h + "h " + m + "m";
    return m + "m " + (sec < 10 ? "0" : "") + sec + "s";
  }

  // ---- team statistics for the Know Stats page (worked out from data.json) ----
  var FORM_LEN = 5;
  var TABLE_WINDOW = 2; // rows shown above and below each team in the mini table

  function emptyRec() { return { played: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, results: [] }; }
  function resultLetter(gf, ga) { return gf > ga ? "W" : gf < ga ? "L" : "D"; }

  // Cups also have knockout rounds that the table does not include, so the W/D/L tally
  // only counts the league/group phase there. The last-5 form counts every match.
  function inTable(comp, m) {
    return comp.kind !== "cup" || !m.stage || Scoring.NON_KNOCKOUT_STAGES.indexOf(m.stage) !== -1;
  }

  // Record for every team in one competition: { teamId: { played, w, d, l, gf, ga, pts, results } }
  // results are the finished matches, oldest first.
  function teamRecords(comp) {
    var by = {};
    function rec(t) { if (!by[t.id]) by[t.id] = emptyRec(); return by[t.id]; }
    (comp.matches || []).forEach(function (m) {
      if (m.status !== "FINISHED" || !m.score || m.home.id == null || m.away.id == null) return;
      var counted = inTable(comp, m);
      [[m.home, m.away, m.score.home, m.score.away, true], [m.away, m.home, m.score.away, m.score.home, false]].forEach(function (s) {
        var r = rec(s[0]), res = resultLetter(s[2], s[3]);
        if (counted) {
          r.played++; r.gf += s[2]; r.ga += s[3];
          if (res === "W") r.w++; else if (res === "D") r.d++; else r.l++;
        }
        r.results.push({ id: m.id, date: m.utcDate, home: s[4], opp: s[1], gf: s[2], ga: s[3], res: res, stage: m.stage });
      });
    });
    Object.keys(by).forEach(function (k) {
      var r = by[k];
      r.pts = r.w * 3 + r.d;
      r.results.sort(function (a, b) { return (new Date(a.date) - new Date(b.date)) || ((a.id || 0) - (b.id || 0)); });
    });
    return by;
  }

  function lastResults(rec, n) { return rec.results.slice(-(n || FORM_LEN)); }

  function findRow(comp, teamId) {
    var groups = comp.standings || [];
    for (var g = 0; g < groups.length; g++) {
      var rows = groups[g].table || [];
      for (var i = 0; i < rows.length; i++) if (rows[i].team.id === teamId) return { group: groups[g], row: rows[i] };
    }
    return null;
  }

  function teamView(comp, recs, team) {
    var rec = recs[team.id] || emptyRec();
    var hit = findRow(comp, team.id);
    var row = hit && hit.row;
    var form = lastResults(rec);
    var formPts = 0;
    form.forEach(function (r) { formPts += r.res === "W" ? 3 : r.res === "D" ? 1 : 0; });
    return {
      team: team,
      position: row ? row.position : null,
      tableSize: hit ? hit.group.table.length : null,
      // only competitions with several groups (World Cup) name them; leagues come labelled "Matchday" by the data source
      groupName: hit && (comp.standings || []).length > 1 ? hit.group.group : null,
      played: row && row.played != null ? row.played : rec.played,
      points: row && row.points != null ? row.points : rec.pts,
      gd: row && row.gd != null ? row.gd : rec.gf - rec.ga,
      w: rec.w, d: rec.d, l: rec.l, gf: rec.gf, ga: rec.ga,
      form: form, formPts: formPts
    };
  }

  // The part of the table around the two teams (or the whole table when `full`).
  // One table per group, so World Cup teams from different groups each get their own.
  function miniTables(comp, recs, ids, full) {
    var out = [];
    (comp.standings || []).forEach(function (g) {
      var table = g.table || [], hits = [];
      table.forEach(function (row, i) { if (ids.indexOf(row.team.id) !== -1) hits.push(i); });
      if (!hits.length) return;
      var keep = {};
      if (full) table.forEach(function (row, i) { keep[i] = true; });
      else hits.forEach(function (i) {
        for (var k = i - TABLE_WINDOW; k <= i + TABLE_WINDOW; k++) if (k >= 0 && k < table.length) keep[k] = true;
      });
      var rows = [], prev = null;
      table.forEach(function (row, i) {
        if (!keep[i]) return;
        if (prev !== null && i !== prev + 1) rows.push({ gap: true });
        prev = i;
        var rec = recs[row.team.id] || emptyRec();
        rows.push({
          position: row.position, team: row.team, played: row.played != null ? row.played : rec.played,
          points: row.points != null ? row.points : rec.pts, gd: row.gd != null ? row.gd : rec.gf - rec.ga,
          w: rec.w, d: rec.d, l: rec.l, form: lastResults(rec),
          side: row.team.id === ids[0] ? "home" : row.team.id === ids[1] ? "away" : null
        });
      });
      out.push({ group: (comp.standings || []).length > 1 ? g.group : null, size: table.length, rows: rows });
    });
    return out;
  }

  function matchPreview(comp, match, full) {
    var recs = teamRecords(comp);
    return {
      home: teamView(comp, recs, match.home),
      away: teamView(comp, recs, match.away),
      tables: miniTables(comp, recs, [match.home.id, match.away.id], !!full)
    };
  }

  // ---- streaks and badges ----
  function sgn(n) { return n > 0 ? 1 : n < 0 ? -1 : 0; }

  function settledBets(user) {
    return user.bets.filter(function (b) { return b.status === "settled" && b.result; }).sort(function (a, b) {
      return (new Date(a.kickoff) - new Date(b.kickoff)) || String(a.placedAt || "").localeCompare(String(b.placedAt || ""));
    });
  }

  function betFlags(b) {
    var err = typeof b.error === "number" ? b.error : Scoring.totalError({ home: b.pickHome, away: b.pickAway }, b.result);
    return {
      right: sgn(b.pickHome - b.pickAway) === sgn(b.result.home - b.result.away), // win/draw/loss called correctly
      profit: b.net > 0,
      exact: err === 0,
      close: err <= 1                                                           // within one goal in total
    };
  }

  function runLengths(flags) {
    var best = 0, cur = 0;
    flags.forEach(function (f) { cur = f ? cur + 1 : 0; if (cur > best) best = cur; });
    return { current: cur, best: best };
  }

  // Runs of consecutive settled bets (in kickoff order) that are: right result, in profit, exact, within 1 goal.
  function streaks(user) {
    var flags = settledBets(user).map(betFlags);
    function run(key) { return runLengths(flags.map(function (f) { return f[key]; })); }
    return { right: run("right"), profit: run("profit"), exact: run("exact"), close: run("close") };
  }

  function badgeContext(user) {
    var settled = settledBets(user);
    var flags = settled.map(betFlags);
    var ctx = {
      user: user, settled: settled.length, placed: user.bets.length + user.winnerBets.length, streaks: streaks(user),
      right: 0, profit: 0, exact: 0, bigGame: 0, jackpot: 0, goalFest: 0, drawExact: 0, comps: 0, days: 0, seasonWins: 0
    };
    settled.forEach(function (b, i) {
      var f = flags[i], goals = b.result.home + b.result.away;
      if (f.right) ctx.right++;
      if (f.profit) ctx.profit++;
      if (f.exact) {
        ctx.exact++;
        if (b.high) ctx.bigGame++;
        if (goals >= 5) ctx.goalFest++;
        if (b.result.home === b.result.away) ctx.drawExact++;
      }
      if (b.net >= 40) ctx.jackpot++;
    });
    var comps = {}, days = {};
    user.bets.concat(user.winnerBets).forEach(function (b) {
      comps[b.comp] = true;
      if (b.placedAt) days[dayKey(b.placedAt)] = true;
    });
    ctx.comps = Object.keys(comps).length;
    ctx.days = Object.keys(days).length;
    user.winnerBets.forEach(function (b) { if (b.status === "settled" && b.won) ctx.seasonWins++; });
    return ctx;
  }

  // need = the target; have = progress towards it; ok (optional) replaces the have >= need test.
  function badge(id, icon, name, desc, need, have, ok) {
    return { id: id, icon: icon, name: name, desc: desc, need: need, have: have, ok: ok };
  }
  var BADGES = [
    badge("kickoff", "🎟️", "Kick-off", "Place your first bet.", 1, function (c) { return c.placed; }),
    badge("green", "💚", "In the Green", "Finish a bet in profit.", 1, function (c) { return c.profit; }),
    badge("bullseye", "🎯", "Bullseye", "Predict an exact score.", 1, function (c) { return c.exact; }),
    badge("sharpshooter", "🏹", "Sharpshooter", "Predict 3 exact scores.", 3, function (c) { return c.exact; }),
    badge("crystal", "🔮", "Crystal Ball", "Predict 10 exact scores.", 10, function (c) { return c.exact; }),
    badge("double", "✌️", "Double Bullseye", "Predict 2 exact scores in a row.", 2, function (c) { return c.streaks.exact.best; }),
    badge("hattrick", "🎩", "Hat-trick", "Call the result right in 3 bets in a row.", 3, function (c) { return c.streaks.right.best; }),
    badge("fire", "🔥", "On Fire", "Call the result right in 5 bets in a row.", 5, function (c) { return c.streaks.right.best; }),
    badge("unstoppable", "🚀", "Unstoppable", "Call the result right in 10 bets in a row.", 10, function (c) { return c.streaks.right.best; }),
    badge("machine", "💰", "Money Machine", "Finish 3 bets in a row in profit.", 3, function (c) { return c.streaks.profit.best; }),
    badge("laser", "🔬", "Laser Focus", "Get 3 bets in a row within 1 goal of the score.", 3, function (c) { return c.streaks.close.best; }),
    badge("analyst", "📈", "Analyst", "Call 70% of results right over at least 10 settled bets.", 10,
      function (c) { return c.settled; }, function (c) { return c.settled >= 10 && c.right / c.settled >= 0.7; }),
    badge("biggame", "🏟️", "Big Game Player", "Predict an exact score in a high-stakes match.", 1, function (c) { return c.bigGame; }),
    badge("jackpot", "🤑", "Jackpot", "Win 40 or more tokens on a single bet.", 1, function (c) { return c.jackpot; }),
    badge("goalfest", "🎆", "Goal Fest", "Predict an exact score in a match with 5 or more goals.", 1, function (c) { return c.goalFest; }),
    badge("draw", "🤝", "Draw Whisperer", "Predict an exact score that is a draw.", 1, function (c) { return c.drawExact; }),
    badge("globe", "🌍", "Globetrotter", "Place bets in 3 different competitions.", 3, function (c) { return c.comps; }),
    badge("regular", "📅", "Regular", "Place bets on 7 different days.", 7, function (c) { return c.days; }),
    badge("seer", "🏆", "Season Seer", "Win a season winner bet.", 1, function (c) { return c.seasonWins; }),
    badge("banker", "🏦", "Banker", "Reach a balance of 250 tokens.", 250, function (c) { return c.user.tokens; })
  ];

  function badgeEarned(def, ctx) { return def.ok ? def.ok(ctx) : def.have(ctx) >= def.need; }

  // Records any newly earned badges on the player and returns them (so the UI can announce them).
  function updateBadges(user, now) {
    normalizeUser(user);
    var ctx = badgeContext(user), fresh = [];
    BADGES.forEach(function (def) {
      if (!user.badges[def.id] && badgeEarned(def, ctx)) {
        user.badges[def.id] = new Date(now).toISOString();
        fresh.push(def);
      }
    });
    return fresh;
  }

  // For the badges section: every badge with its progress. Earned badges are never lost.
  function badgeStatus(user) {
    normalizeUser(user);
    var ctx = badgeContext(user);
    return BADGES.map(function (def) {
      var at = user.badges[def.id] || null;
      return {
        id: def.id, icon: def.icon, name: def.name, desc: def.desc, need: def.need,
        have: Math.min(def.have(ctx), def.need), earned: !!at || badgeEarned(def, ctx), earnedAt: at
      };
    });
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
        normalizeUser(u);
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
    normalizeUser: normalizeUser,
    dailyClaimed: dailyClaimed,
    countdownText: countdownText,
    teamRecords: teamRecords,
    matchPreview: matchPreview,
    streaks: streaks,
    updateBadges: updateBadges,
    badgeStatus: badgeStatus,
    exportAll: exportAll,
    importAll: importAll
  };
});
