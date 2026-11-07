/* Football Prediction Game: user interface. Game rules live in scoring.js and game.js. */
(function () {
  "use strict";

  var R = Scoring.RULES;
  var LS_USERS = "fpg.users.v1";
  var LS_CUR = "fpg.current.v1";
  var ALWAYS = [["PL", "Premier League"], ["PD", "La Liga"], ["BL1", "Bundesliga"], ["CL", "Champions League"]];
  var COMP_ORDER = ["PL", "PD", "BL1", "CL", "WC"];
  var LIVE = ["IN_PLAY", "PAUSED", "LIVE"];
  var STEP = 10;
  var REFRESH_MS = 10 * 60 * 1000;

  var S = {
    data: { fetchedAt: null, competitions: {} },
    dataError: null,
    users: {},
    nick: null,       // key of the logged-in player
    signup: null,     // nickname being registered (step 2)
    tab: "matches",
    comp: null,
    more: {},
    storageOk: true,
    lastLoad: 0
  };

  var $app = document.getElementById("app");
  var $toast = document.getElementById("toast");

  // ---------- helpers ----------
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function tok(n) { return String(Math.round(n * 10) / 10); }
  function mult(n) { return "×" + String(Math.round(n * 100) / 100); }
  function signed(n) { return (n > 0 ? "+" : "") + tok(n); }
  function fmtDate(iso) {
    return new Date(iso).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  }
  function fmtDay(iso) {
    return new Date(iso).toLocaleString([], { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  function keyOf(nick) { return nick.trim().toLowerCase(); }
  function U() { return S.nick ? S.users[S.nick] : null; }
  function cls(n) { return n > 0 ? "pos" : n < 0 ? "neg" : ""; }

  var STAGES = {
    LEAGUE_STAGE: "League stage", GROUP_STAGE: "Group stage", PLAYOFFS: "Play-offs", LAST_32: "Round of 32",
    LAST_16: "Round of 16", QUARTER_FINALS: "Quarter-final", SEMI_FINALS: "Semi-final", THIRD_PLACE: "Third place", FINAL: "Final"
  };
  function roundLabel(m) {
    if (m.stage && m.stage !== "REGULAR_SEASON") return STAGES[m.stage] || m.stage.replace(/_/g, " ").toLowerCase();
    return m.matchday ? "Matchday " + m.matchday : "";
  }

  // ---------- storage ----------
  function loadUsers() {
    try { var raw = localStorage.getItem(LS_USERS); return raw ? JSON.parse(raw) : {}; } catch (e) { return {}; }
  }
  function save() {
    try {
      localStorage.setItem(LS_USERS, JSON.stringify(S.users));
      if (S.nick) localStorage.setItem(LS_CUR, S.nick); else localStorage.removeItem(LS_CUR);
    } catch (e) { S.storageOk = false; }
  }
  function checkStorage() {
    try { localStorage.setItem("fpg.test", "1"); localStorage.removeItem("fpg.test"); } catch (e) { S.storageOk = false; }
  }

  var toastTimer;
  function toast(text, kind) {
    $toast.className = "toast " + (kind || "ok");
    $toast.textContent = text;
    $toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { $toast.hidden = true; }, 6000);
  }

  // ---------- data ----------
  function loadData() {
    return fetch("data/data.json?t=" + Date.now(), { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (d) { S.data = d; S.dataError = null; })
      .catch(function (e) {
        S.dataError = location.protocol === "file:"
          ? "Scores can't load when this page is opened as a file. Open the hosted site instead."
          : "Could not load scores (" + e.message + "). Showing what is already known.";
      })
      .then(function () { S.lastLoad = Date.now(); });
  }

  function sync() {
    var u = U();
    if (!u) return;
    var now = Date.now(), notes = [];
    if (Game.applyTopUp(u, now)) notes.push("Free top-up: your balance is back to " + R.topUpTo + " tokens.");
    Game.settleAll(u, S.data, now).forEach(function (e) { notes.push(e); });
    if (notes.length) { save(); toast(notes.join(" · "), "ok"); }
  }

  function compName(code) {
    var c = S.data.competitions[code];
    if (c) return c.name;
    for (var i = 0; i < ALWAYS.length; i++) if (ALWAYS[i][0] === code) return ALWAYS[i][1];
    return code;
  }
  function availableLeagues() {
    var codes = ALWAYS.map(function (a) { return a[0]; });
    Object.keys(S.data.competitions).forEach(function (c) { if (codes.indexOf(c) === -1) codes.push(c); });
    return codes.sort(function (a, b) {
      var ia = COMP_ORDER.indexOf(a), ib = COMP_ORDER.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
  }

  // ---------- views ----------
  function renderLogin() {
    if (S.signup) {
      var boxes = availableLeagues().map(function (c) {
        var on = c !== "WC" ? "checked" : "";
        return '<label class="check"><input type="checkbox" name="league" value="' + esc(c) + '" ' + on + "> " + esc(compName(c)) + "</label>";
      }).join("");
      return '<main class="login card"><h1>Welcome, ' + esc(S.signup) + "!</h1>" +
        "<p>Pick the leagues you want to play. You can change this later.</p>" +
        '<form data-form="signup"><div class="checks">' + boxes + "</div>" +
        '<p class="hint">The World Cup appears here automatically when its fixtures are about to start.</p>' +
        '<div class="row"><button type="button" class="btn ghost" data-action="signup-back">Back</button>' +
        '<button class="btn" type="submit">Start with ' + R.startTokens + " tokens</button></div></form></main>";
    }
    var existing = Object.keys(S.users).map(function (k) {
      return '<button class="chip" data-action="login-as" data-nick="' + esc(k) + '">' + esc(S.users[k].nick) + "</button>";
    }).join("");
    return '<main class="login card"><h1>Football Prediction Game</h1>' +
      "<p>Predict scores, stake game tokens and see how sharp you are. Tokens are for fun only: no real money.</p>" +
      '<form data-form="login"><label class="field" for="nick">Choose a nickname (2 to 20 letters or numbers)</label>' +
      '<input id="nick" name="nick" type="text" maxlength="20" autocomplete="off" required>' +
      '<button class="btn" type="submit">Continue</button></form>' +
      (existing ? '<h3 style="margin-top:1.2rem">Players on this device</h3><div class="chips">' + existing + "</div>" : "") +
      '<p class="hint">No password: anyone using this browser can open any nickname here. Your progress is saved only on this device. ' +
      "Use Stats → Backup to keep a copy.</p></main>";
  }

  function renderHeader(u) {
    var tabs = [["matches", "Matches"], ["winner", "Season winner"], ["bets", "My bets"], ["stats", "Stats"]];
    return '<header class="topbar"><div class="brand">⚽ Football Prediction Game</div>' +
      '<div class="me"><span class="balance" title="Your tokens">🪙 ' + tok(u.tokens) + '</span><span class="who">' + esc(u.nick) +
      '</span><button class="btn ghost" data-action="switch">Switch player</button></div></header>' +
      '<nav class="tabs" role="tablist">' + tabs.map(function (t) {
        return '<button class="tab" role="tab" aria-selected="' + (S.tab === t[0]) + '" data-action="tab" data-tab="' + t[0] + '">' + t[1] + "</button>";
      }).join("") + "</nav>";
  }

  function notices() {
    var out = "";
    if (!S.storageOk) out += '<div class="notice">Your browser is blocking saved data, so progress will be lost when you close this page.</div>';
    if (S.dataError) out += '<div class="notice">' + esc(S.dataError) + "</div>";
    else if (!S.data.fetchedAt) out += '<div class="notice">Waiting for the first score update. Fixtures will appear here once the update job has run.</div>';
    return out;
  }

  function crest(t) {
    return t.crest ? '<img class="crest" src="' + esc(t.crest) + '" alt="" loading="lazy" width="26" height="26">' : "";
  }

  function findBet(u, comp, matchId) {
    for (var i = 0; i < u.bets.length; i++) if (u.bets[i].comp === comp && u.bets[i].matchId === matchId) return u.bets[i];
    return null;
  }

  function betForm(u, comp, m, bet, high) {
    var canAfford = u.tokens + (bet ? bet.stake : 0) >= R.stakes[0];
    if (!canAfford) return '<p class="hint">Not enough tokens to bet right now.</p>';
    var def = bet ? bet.stake : (R.stakes.filter(function (s) { return s <= u.tokens; }).indexOf(10) !== -1 ? 10 : R.stakes[0]);
    var opts = R.stakes.map(function (s) {
      var disabled = s > u.tokens + (bet ? bet.stake : 0) ? " disabled" : "";
      return '<option value="' + s + '"' + (s === def ? " selected" : "") + disabled + ">" + s + "</option>";
    }).join("");
    return '<form class="betform" data-form="bet" data-comp="' + esc(comp.code) + '" data-match="' + m.id + '">' +
      '<div class="pick"><input class="goal" type="number" name="h" min="0" max="' + R.maxGoals + '" inputmode="numeric" aria-label="' + esc(m.home.short) + ' goals" value="' + (bet ? bet.pickHome : "") + '">' +
      '<span>–</span><input class="goal" type="number" name="a" min="0" max="' + R.maxGoals + '" inputmode="numeric" aria-label="' + esc(m.away.short) + ' goals" value="' + (bet ? bet.pickAway : "") + '"></div>' +
      '<label class="field">Stake<select name="stake">' + opts + "</select></label>" +
      '<button class="btn" type="submit">' + (bet ? "Update bet" : "Place bet") + "</button>" +
      (bet ? '<button type="button" class="btn ghost" data-action="cancel-bet" data-bet="' + esc(bet.id) + '">Cancel bet</button>' : "") +
      '<p class="hint" style="flex-basis:100%">Exact score pays ' + mult(high ? R.multExactHigh : R.multExact) + ", one goal off " + mult(R.multOff1) +
      ", two off " + mult(R.multOff2) + ", further off loses the stake.</p></form>";
  }

  function betSummary(bet, m) {
    var line = 'Your pick: <strong>' + bet.pickHome + "–" + bet.pickAway + "</strong> · stake " + tok(bet.stake) +
      (bet.high ? ' <span class="badge high">' + mult(R.multExactHigh) + " on exact</span>" : "");
    if (bet.status === "settled") {
      var good = bet.net > 0;
      line += ' <span class="badge ' + (good ? "win" : bet.net < 0 ? "loss" : "") + '">' + signed(bet.net) + " tokens (" + mult(bet.multiplier) + ")</span>";
    } else if (bet.status === "refunded") {
      line += ' <span class="badge">Refunded</span>';
    }
    return '<p class="yourbet">' + line + "</p>";
  }

  function matchCard(u, comp, m, rank) {
    var bet = findBet(u, comp.code, m.id);
    var finished = m.status === "FINISHED" && m.score;
    var reason = (!finished) ? Scoring.highStakesReason(m, comp, rank, R) : null;
    var high = bet ? bet.high : !!reason;
    var tags = '<span>' + esc(fmtDate(m.utcDate)) + "</span>";
    var rl = roundLabel(m);
    if (rl) tags += '<span class="badge">' + esc(rl) + "</span>";
    if (high) tags += '<span class="badge high" title="Exact score pays ' + mult(R.multExactHigh) + '">★ High stakes' +
      ((bet && bet.highReason) || reason ? ": " + esc((bet && bet.highReason) || reason) : "") + "</span>";
    if (m.status === "POSTPONED") tags += '<span class="badge loss">Postponed</span>';
    if (m.status === "CANCELLED") tags += '<span class="badge loss">Cancelled</span>';

    var mid = finished ? '<span class="score">' + m.score.home + " – " + m.score.away + "</span>" : '<span class="vs">v</span>';
    var body = "";
    if (bet) body += betSummary(bet, m);
    if (Game.canBet(m, Date.now())) body += betForm(u, comp, m, bet && bet.status === "open" ? bet : null, high);
    else if (!finished && !bet && (m.home.id == null || m.away.id == null)) body += '<p class="hint">Teams not decided yet.</p>';
    else if (!finished && !bet && m.status !== "POSTPONED" && m.status !== "CANCELLED") body += '<p class="hint">Betting closed (kickoff has passed).</p>';

    return '<article class="card match"><div class="meta">' + tags + "</div>" +
      '<div class="teams"><div class="team">' + crest(m.home) + "<span>" + esc(m.home.name || "TBD") + "</span></div>" + mid +
      '<div class="team right"><span>' + esc(m.away.name || "TBD") + "</span>" + crest(m.away) + "</div></div>" + body + "</article>";
  }

  function renderMatches(u) {
    var leagues = u.leagues.filter(function (c) { return S.data.competitions[c]; });
    if (!leagues.length) {
      return '<div class="empty">No fixtures to show yet for your leagues. They will appear after the next score update.</div>';
    }
    if (!S.comp || leagues.indexOf(S.comp) === -1) S.comp = leagues[0];
    var comp = S.data.competitions[S.comp];
    var now = Date.now();
    var rank = Scoring.rankMap(comp);
    var chips = '<div class="chips">' + leagues.map(function (c) {
      return '<button class="chip" aria-pressed="' + (c === S.comp) + '" data-action="comp" data-comp="' + esc(c) + '">' + esc(compName(c)) + "</button>";
    }).join("") + "</div>";

    var live = [], upcoming = [], results = [];
    comp.matches.forEach(function (m) {
      var future = new Date(m.utcDate).getTime() > now;
      if (LIVE.indexOf(m.status) !== -1 || ((m.status === "SCHEDULED" || m.status === "TIMED") && !future)) live.push(m);
      else if (m.status === "SCHEDULED" || m.status === "TIMED") upcoming.push(m);
      else if (m.status === "FINISHED") results.push(m);
    });
    results.sort(function (a, b) { return new Date(b.utcDate) - new Date(a.utcDate); });

    var html = chips;
    if (live.length) {
      html += '<h2 class="section-title">In progress or awaiting result</h2>' +
        live.map(function (m) { return matchCard(u, comp, m, rank); }).join("");
    }
    var limit = S.more[S.comp] || STEP;
    html += '<h2 class="section-title">Upcoming</h2>';
    if (!upcoming.length) html += '<div class="empty">No upcoming fixtures.</div>';
    else {
      html += upcoming.slice(0, limit).map(function (m) { return matchCard(u, comp, m, rank); }).join("");
      if (upcoming.length > limit) html += '<p><button class="btn ghost" data-action="more">Show more fixtures (' + (upcoming.length - limit) + " left)</button></p>";
    }
    html += '<h2 class="section-title">Recent results</h2>';
    if (!results.length) html += '<div class="empty">No results yet.</div>';
    else html += results.slice(0, 8).map(function (m) { return matchCard(u, comp, m, rank); }).join("");
    return html;
  }

  function renderWinner(u) {
    var leagues = u.leagues.filter(function (c) { return S.data.competitions[c]; });
    if (!leagues.length) return '<div class="empty">No leagues available yet.</div>';
    var html = '<p class="muted">Pick the champion before the season is far along. Your stake and the payout multiplier lock when you place the bet. ' +
      "Earlier picks and less likely winners pay more. Tokens stay staked until the season ends.</p>";
    leagues.forEach(function (code) {
      var comp = S.data.competitions[code];
      var progress = Scoring.seasonProgress(comp);
      var status = Game.winnerStatus(comp, u);
      var bet = Game.winnerBetFor(u, comp);
      html += '<section class="card"><h2>' + esc(comp.name) + "</h2>" +
        '<div class="muted">Season progress: ' + Math.round(progress * 100) + '%</div><div class="progress"><div style="width:' + Math.round(progress * 100) + '%"></div></div>';
      if (bet) {
        html += '<p>Your pick: <strong>' + esc(bet.teamName) + "</strong> · stake " + tok(bet.stake) + " · locked " + mult(bet.multiplier) +
          " · potential payout " + Math.round(bet.stake * bet.multiplier);
        if (bet.status === "settled") html += ' <span class="badge ' + (bet.won ? "win" : "loss") + '">' + (bet.won ? "Won " : "Lost ") + signed(bet.net) + "</span>";
        else if (bet.status === "refunded") html += ' <span class="badge">Refunded</span>';
        html += "</p>";
      }
      if (status.open) {
        var opts = Game.winnerOptions(comp).map(function (o) {
          return '<option value="' + o.team.id + '">' + (o.rank ? o.rank + ". " : "") + esc(o.team.name) + " (" + mult(o.multiplier) + ")</option>";
        }).join("");
        var maxStake = Math.floor(u.tokens);
        html += '<form class="betform" data-form="winner" data-comp="' + esc(code) + '" style="border-top:0;margin-top:0;padding-top:0">' +
          '<label class="field">Champion<select name="team">' + opts + "</select></label>" +
          '<label class="field">Stake<input type="number" name="stake" min="1" max="' + maxStake + '" value="' + Math.max(1, Math.min(10, maxStake)) + '" inputmode="numeric"></label>' +
          '<button class="btn" type="submit"' + (maxStake < 1 ? " disabled" : "") + ">Lock in pick</button></form>" +
          '<p class="hint">Multiplier shown is what you would lock in today.</p>';
      } else if (!bet || status.reason.indexOf("already picked") === -1) {
        html += '<p class="hint">' + esc(status.reason) + "</p>";
      }
      html += "</section>";
    });
    return html;
  }

  function renderBets(u) {
    function byKick(a, b) { return new Date(a.kickoff) - new Date(b.kickoff); }
    var open = u.bets.filter(function (b) { return b.status === "open"; }).sort(byKick);
    var done = u.bets.filter(function (b) { return b.status !== "open"; }).sort(function (a, b) { return byKick(b, a); });
    function card(b) {
      var right = "";
      if (b.status === "settled") {
        right = "Final " + b.result.home + "–" + b.result.away + " · " + mult(b.multiplier) + ' <span class="badge ' + (b.net > 0 ? "win" : b.net < 0 ? "loss" : "") + '">' + signed(b.net) + "</span>";
      } else if (b.status === "refunded") right = '<span class="badge">Refunded</span>';
      else right = "Open";
      return '<div class="card"><strong>' + esc(b.home) + " v " + esc(b.away) + '</strong> <span class="muted">· ' + esc(compName(b.comp)) + " · " + esc(fmtDate(b.kickoff)) + "</span>" +
        "<div>Pick " + b.pickHome + "–" + b.pickAway + " · stake " + tok(b.stake) + (b.high ? ' <span class="badge high">★ ' + esc(b.highReason || "High stakes") + "</span>" : "") + "</div>" +
        '<div class="muted">' + right + "</div></div>";
    }
    function wcard(b) {
      var right = b.status === "settled" ? '<span class="badge ' + (b.won ? "win" : "loss") + '">' + (b.won ? "Won " : "Lost ") + signed(b.net) + "</span>"
        : b.status === "refunded" ? '<span class="badge">Refunded</span>' : "Waiting for the season to finish";
      return '<div class="card"><strong>Season winner: ' + esc(b.teamName) + '</strong> <span class="muted">· ' + esc(compName(b.comp)) + "</span>" +
        "<div>Stake " + tok(b.stake) + " · locked " + mult(b.multiplier) + '</div><div class="muted">' + right + "</div></div>";
    }
    if (!u.bets.length && !u.winnerBets.length) return '<div class="empty">No bets yet. Head to Matches or Season winner to place one.</div>';
    var html = "";
    if (open.length || u.winnerBets.some(function (b) { return b.status === "open"; })) {
      html += '<h2 class="section-title">Open</h2>' +
        u.winnerBets.filter(function (b) { return b.status === "open"; }).map(wcard).join("") + open.map(card).join("");
    }
    if (done.length || u.winnerBets.some(function (b) { return b.status !== "open"; })) {
      html += '<h2 class="section-title">Settled</h2>' +
        u.winnerBets.filter(function (b) { return b.status !== "open"; }).map(wcard).join("") + done.map(card).join("");
    }
    return html;
  }

  function renderStats(u) {
    var s = Game.stats(u);
    function m(label, value, c) { return '<div class="metric"><b class="' + (c || "") + '">' + value + "</b><span>" + label + "</span></div>"; }
    var html = '<div class="metrics">' +
      m("Balance", tok(s.balance)) + m("Staked in open bets", tok(s.openStake)) + m("Bets settled", s.settled) +
      m("Bets in profit", s.hitRate == null ? "–" : s.hitRate + "%") + m("Exact scores", s.exact) +
      m("Net from matches", signed(s.netMatch), cls(s.netMatch)) + m("Net from season picks", signed(s.netWinner), cls(s.netWinner)) + "</div>";

    var codes = Object.keys(s.byLeague);
    if (codes.length) {
      html += '<h2 class="section-title">By league</h2><div class="card table-wrap"><table><thead><tr><th>League</th><th class="num">Bets</th><th class="num">Settled</th><th class="num">In profit</th><th class="num">Exact</th><th class="num">Net</th></tr></thead><tbody>' +
        codes.map(function (c) {
          var l = s.byLeague[c];
          return "<tr><td>" + esc(compName(c)) + '</td><td class="num">' + l.bets + '</td><td class="num">' + l.settled + '</td><td class="num">' + l.wins + '</td><td class="num">' + l.exact + '</td><td class="num ' + cls(l.net) + '">' + signed(l.net) + "</td></tr>";
        }).join("") + "</tbody></table></div>";
    }

    html += '<h2 class="section-title">Your leagues</h2><div class="card"><div class="checks">' +
      availableLeagues().map(function (c) {
        return '<label class="check"><input type="checkbox" data-action="toggle-league" data-comp="' + esc(c) + '" ' + (u.leagues.indexOf(c) !== -1 ? "checked" : "") + "> " + esc(compName(c)) + "</label>";
      }).join("") + '</div><p class="hint">You can leave a league only when you have no open bets in it.</p></div>';

    var ledger = u.ledger.slice(-25).reverse();
    html += '<h2 class="section-title">Recent token history</h2><div class="card table-wrap"><table><thead><tr><th>When</th><th>What</th><th class="num">Tokens</th><th class="num">Balance</th></tr></thead><tbody>' +
      ledger.map(function (e) {
        return "<tr><td>" + esc(fmtDay(e.ts)) + "</td><td>" + esc(e.note) + '</td><td class="num ' + cls(e.amount) + '">' + signed(e.amount) + '</td><td class="num">' + tok(e.balance) + "</td></tr>";
      }).join("") + "</tbody></table></div>";

    html += '<h2 class="section-title">Backup</h2><div class="card"><p>Progress lives only in this browser. Download a backup to keep it safe or move it to another device.</p>' +
      '<div class="row"><button class="btn" data-action="export">Download backup</button>' +
      '<label class="btn ghost" style="cursor:pointer">Restore backup<input type="file" accept=".json,application/json" data-action="import" hidden></label>' +
      '<button class="btn danger" data-action="delete-player">Delete this player</button></div></div>';
    return html;
  }

  function renderGame(u) {
    var body = S.tab === "winner" ? renderWinner(u) : S.tab === "bets" ? renderBets(u) : S.tab === "stats" ? renderStats(u) : renderMatches(u);
    var updated = S.data.fetchedAt ? "Scores last changed " + fmtDay(S.data.fetchedAt) + "." : "";
    return '<div class="shell">' + renderHeader(u) + notices() + body +
      '<p class="footer">Game tokens only: no real money is involved. ' + updated + " Football data from football-data.org. Scores can be delayed.</p></div>";
  }

  function render() {
    var u = U();
    $app.innerHTML = u ? renderGame(u) : renderLogin();
  }

  // ---------- actions ----------
  function afterLogin() { S.tab = "matches"; S.comp = null; save(); sync(); render(); window.scrollTo(0, 0); }

  function guarded(fn) {
    try { fn(); } catch (err) { toast(err.message, "error"); }
  }

  $app.addEventListener("click", function (e) {
    var el = e.target.closest("[data-action]");
    if (!el || el.tagName === "INPUT") return;
    var a = el.dataset.action, u = U();
    if (a === "login-as") { S.nick = el.dataset.nick; afterLogin(); }
    else if (a === "signup-back") { S.signup = null; render(); }
    else if (a === "switch") { S.nick = null; save(); render(); }
    else if (a === "tab") { S.tab = el.dataset.tab; render(); window.scrollTo(0, 0); }
    else if (a === "comp") { S.comp = el.dataset.comp; render(); }
    else if (a === "more") { S.more[S.comp] = (S.more[S.comp] || STEP) + STEP; render(); }
    else if (a === "cancel-bet") {
      guarded(function () { Game.cancelMatchBet(u, S.data, el.dataset.bet, Date.now()); save(); render(); toast("Bet cancelled and stake refunded."); });
    } else if (a === "export") {
      var blob = new Blob([Game.exportAll(S.users)], { type: "application/json" });
      var link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = "football-game-backup-" + new Date().toISOString().slice(0, 10) + ".json";
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(function () { URL.revokeObjectURL(link.href); }, 1000);
    } else if (a === "delete-player") {
      if (window.confirm("Delete " + u.nick + " and all their bets from this device? This cannot be undone.")) {
        delete S.users[S.nick]; S.nick = null; save(); render();
      }
    }
  });

  $app.addEventListener("change", function (e) {
    var el = e.target, u = U();
    if (el.dataset.action === "toggle-league" && u) {
      var code = el.dataset.comp, idx = u.leagues.indexOf(code);
      if (el.checked && idx === -1) u.leagues.push(code);
      else if (!el.checked && idx !== -1) {
        var busy = u.bets.some(function (b) { return b.comp === code && b.status === "open"; }) ||
          u.winnerBets.some(function (b) { return b.comp === code && b.status === "open"; });
        if (busy) { toast("You still have open bets in " + compName(code) + ".", "error"); render(); return; }
        u.leagues.splice(idx, 1);
      }
      if (!u.leagues.length) { u.leagues.push(code); toast("Keep at least one league.", "error"); }
      save(); render();
    } else if (el.dataset.action === "import" && el.files && el.files[0]) {
      el.files[0].text().then(function (text) {
        guarded(function () {
          var res = Game.importAll(text, S.users);
          S.users = res.users; save(); render();
          toast("Restored " + res.count + " player" + (res.count === 1 ? "" : "s") + " from the backup.");
        });
      });
    }
  });

  $app.addEventListener("submit", function (e) {
    var f = e.target.closest("form[data-form]");
    if (!f) return;
    e.preventDefault();
    var kind = f.dataset.form, u = U();

    if (kind === "login") {
      var nick = f.elements.nick.value.trim().replace(/\s+/g, " ");
      if (!/^[\p{L}\p{N} _.-]{2,20}$/u.test(nick)) { toast("Use 2 to 20 letters, numbers, spaces, dots, dashes or underscores.", "error"); return; }
      if (S.users[keyOf(nick)]) { S.nick = keyOf(nick); afterLogin(); }
      else { S.signup = nick; render(); }
    } else if (kind === "signup") {
      var picked = Array.prototype.slice.call(f.querySelectorAll('input[name="league"]:checked')).map(function (i) { return i.value; });
      if (!picked.length) { toast("Pick at least one league.", "error"); return; }
      var nk = keyOf(S.signup);
      S.users[nk] = Game.newUser(S.signup, picked, Date.now());
      S.nick = nk; S.signup = null; afterLogin();
    } else if (kind === "bet" && u) {
      guarded(function () {
        var hv = f.elements.h.value.trim(), av = f.elements.a.value.trim();
        if (hv === "" || av === "") throw new Error("Enter a score for both teams.");
        var bet = Game.placeMatchBet(u, S.data, {
          comp: f.dataset.comp, matchId: Number(f.dataset.match), pickHome: Number(hv), pickAway: Number(av), stake: Number(f.elements.stake.value)
        }, Date.now());
        save(); render();
        toast("Bet placed: " + bet.home + " " + bet.pickHome + "–" + bet.pickAway + " " + bet.away + ", stake " + bet.stake + (bet.high ? " (high stakes)." : "."));
      });
    } else if (kind === "winner" && u) {
      guarded(function () {
        var bet = Game.placeWinnerBet(u, S.data, { comp: f.dataset.comp, teamId: Number(f.elements.team.value), stake: Number(f.elements.stake.value) }, Date.now());
        save(); render();
        toast("Locked in " + bet.teamName + " at " + mult(bet.multiplier) + ".");
      });
    }
  });

  // ---------- startup ----------
  function refresh() {
    return loadData().then(function () { sync(); var a = document.activeElement; if (!a || !$app.contains(a) || !/^(INPUT|SELECT)$/.test(a.tagName)) render(); });
  }

  checkStorage();
  S.users = loadUsers();
  try { var cur = localStorage.getItem(LS_CUR); if (cur && S.users[cur]) S.nick = cur; } catch (e) { /* ignore */ }
  render();
  loadData().then(function () { sync(); render(); });

  setInterval(function () { if (!document.hidden) refresh(); }, REFRESH_MS);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && Date.now() - S.lastLoad > 5 * 60 * 1000) refresh();
  });
})();
