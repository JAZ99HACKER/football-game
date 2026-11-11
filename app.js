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
    modal: null,   // { comp, matchId } while the bet popup is open
    stats: null,   // { comp, matchId } while the Know Stats page is open
    statsFull: false, // show the whole table on the stats page
    statsHist: false, // the stats page has its own browser-history entry
    scrollBack: 0,    // scroll position to return to from the stats page
    bf: { comp: "all", status: "all" }, // My bets filters
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
  function ball(extra) {
    return '<img class="ball' + (extra ? " " + extra : "") + '" src="img/ball.svg" alt="" aria-hidden="true">';
  }
  function fmtShort(iso) {
    return new Date(iso).toLocaleDateString([], { day: "numeric", month: "short" });
  }
  function kickText(ms) {
    return ms > 0 ? "⏱ Kicks off in " + Game.countdownText(ms) : "⏱ Kick-off!";
  }
  function countBadge(m) {
    var ms = new Date(m.utcDate).getTime() - Date.now();
    if ((m.status !== "SCHEDULED" && m.status !== "TIMED") || !(ms > 0)) return "";
    return '<span class="badge count" data-kick="' + esc(m.utcDate) + '">' + kickText(ms) + "</span>";
  }
  function badgeNote(list) {
    return "🏅 New badge" + (list.length > 1 ? "s" : "") + ": " + list.map(function (b) { return b.name; }).join(", ");
  }
  function groupLabel(g) {
    var s = String(g).replace(/_/g, " ").toLowerCase();
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

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
    var fresh = Game.updateBadges(u, now);
    if (fresh.length) notes.push(badgeNote(fresh));
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
      return '<main class="login card"><div class="hero">' + ball("hero-ball") + '<div class="hero-shadow"></div></div><h1>Welcome, ' + esc(S.signup) + "!</h1>" +
        "<p>Pick the leagues you want to play. You can change this later.</p>" +
        '<form data-form="signup"><div class="checks">' + boxes + "</div>" +
        '<p class="hint">The World Cup appears here automatically when its fixtures are about to start.</p>' +
        '<div class="row"><button type="button" class="btn ghost" data-action="signup-back">Back</button>' +
        '<button class="btn" type="submit">Start with ' + R.startTokens + " tokens</button></div></form></main>";
    }
    var existing = Object.keys(S.users).map(function (k) {
      return '<button class="chip" data-action="login-as" data-nick="' + esc(k) + '">' + esc(S.users[k].nick) + "</button>";
    }).join("");
    return '<main class="login card"><div class="hero">' + ball("hero-ball") + '<div class="hero-shadow"></div></div><h1>Football Prediction Game</h1>' +
      "<p>Predict scores, stake game tokens and see how sharp you are. Tokens are for fun only: no real money.</p>" +
      '<form data-form="login"><label class="field" for="nick">Choose a nickname (2 to 20 letters or numbers)</label>' +
      '<input id="nick" name="nick" type="text" maxlength="20" autocomplete="off" required>' +
      '<button class="btn" type="submit">Continue</button></form>' +
      (existing ? '<h3 style="margin-top:1.2rem">Players on this device</h3><div class="chips">' + existing + "</div>" : "") +
      '<p class="hint">No password: anyone using this browser can open any nickname here. Your progress is saved only on this device. ' +
      "Use Stats → Backup to keep a copy.</p></main>";
  }

  function renderHeader(u) {
    var tabs = [["matches", "⚽", "Matches"], ["winner", "🏆", "Season winner"], ["bets", "🎟️", "My bets"], ["stats", "📊", "Stats"]];
    return '<header class="topbar"><div class="brand">' + ball() + "<span>Football Prediction Game</span></div>" +
      '<div class="me"><span class="balance" title="Your tokens">🪙 ' + tok(u.tokens) + '</span><span class="who">' + esc(u.nick) +
      '</span><button class="btn ghost" data-action="switch">Switch player</button></div></header>' +
      '<nav class="tabs" role="tablist">' + tabs.map(function (t) {
        return '<button class="tab" role="tab" aria-selected="' + (S.tab === t[0]) + '" data-action="tab" data-tab="' + t[0] + '"><span class="ti" aria-hidden="true">' + t[1] + '</span> <span class="tl">' + t[2] + "</span></button>";
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
    if (t.crest) return '<img class="crest" src="' + esc(t.crest) + '" alt="" loading="lazy" width="30" height="30">';
    var ini = esc(String(t.tla || t.short || "?").slice(0, 3).toUpperCase());
    return '<span class="crest ph" aria-hidden="true">' + ini + "</span>";
  }

  function findBet(u, comp, matchId) {
    for (var i = 0; i < u.bets.length; i++) if (u.bets[i].comp === comp && u.bets[i].matchId === matchId) return u.bets[i];
    return null;
  }

  function betSummary(bet) {
    var line = 'Your pick: <strong>' + bet.pickHome + "–" + bet.pickAway + "</strong> · stake " + tok(bet.stake) +
      (bet.high ? ' <span class="badge high">' + mult(R.multExactHigh) + " on exact</span>" : "");
    if (bet.status === "settled") {
      line += ' <span class="badge ' + (bet.net > 0 ? "win" : bet.net < 0 ? "loss" : "") + '">' + signed(bet.net) + " tokens (" + mult(bet.multiplier) + ")</span>";
    } else if (bet.status === "refunded") {
      line += ' <span class="badge">Refunded</span>';
    }
    return '<p class="yourbet">' + line + "</p>";
  }

  function matchCard(u, comp, m, rank) {
    var bet = findBet(u, comp.code, m.id);
    var openBet = bet && bet.status === "open" ? bet : null;
    var finished = m.status === "FINISHED" && m.score;
    var reason = finished ? null : Scoring.highStakesReason(m, comp, rank, R);
    var high = bet ? bet.high : !!reason;
    var tags = '<span>' + esc(fmtDate(m.utcDate)) + "</span>" + countBadge(m);
    var rl = roundLabel(m);
    if (rl) tags += '<span class="badge">' + esc(rl) + "</span>";
    if (high) tags += '<span class="badge high" title="Exact score pays ' + mult(R.multExactHigh) + '">★ High stakes' +
      ((bet && bet.highReason) || reason ? ": " + esc((bet && bet.highReason) || reason) : "") + "</span>";
    if (m.status === "POSTPONED") tags += '<span class="badge loss">Postponed</span>';
    if (m.status === "CANCELLED") tags += '<span class="badge loss">Cancelled</span>';

    var mid = finished ? '<span class="score">' + m.score.home + " – " + m.score.away + "</span>" : '<span class="vs">' + ball() + "</span>";

    var foot = "";
    if (bet) foot += betSummary(bet);
    var btns = "";
    if (m.home.id != null && m.away.id != null) {
      // Know Stats comes first, just left of Bet Now
      btns += '<button class="btn ghost stats-btn" data-action="know-stats" data-comp="' + esc(comp.code) + '" data-match="' + m.id + '"><span aria-hidden="true">📊</span> Know Stats</button>';
    }
    if (Game.canBet(m, Date.now())) {
      var affordable = u.tokens + (openBet ? openBet.stake : 0) >= R.stakes[0];
      if (!affordable) btns += '<button class="btn bet-btn" disabled>Not enough tokens</button>';
      else btns += '<button class="btn bet-btn" data-action="open-bet" data-comp="' + esc(comp.code) + '" data-match="' + m.id + '">' +
        ball("btn-ball") + (openBet ? "Change bet" : "Bet Now") + "</button>";
    } else if (!finished && (m.home.id == null || m.away.id == null)) {
      foot += '<p class="hint">Teams not decided yet.</p>';
    } else if (!finished && m.status !== "POSTPONED" && m.status !== "CANCELLED") {
      btns += '<button class="btn bet-btn" disabled>Betting closed</button>';
    }
    if (btns) foot += '<div class="actions">' + btns + "</div>";

    return '<article class="card match' + (high ? " high" : "") + '"><div class="meta">' + tags + "</div>" +
      '<div class="teams"><div class="team">' + crest(m.home) + "<span>" + esc(m.home.name || "TBD") + "</span></div>" + mid +
      '<div class="team right"><span>' + esc(m.away.name || "TBD") + "</span>" + crest(m.away) + "</div></div>" +
      (foot ? '<div class="match-foot">' + foot + "</div>" : "") + "</article>";
  }

  // The popup where a player enters a score and a stake.
  function betModal(u) {
    var ref = S.modal;
    var comp = S.data.competitions[ref.comp];
    var m = comp ? Game.findMatch(S.data, ref.comp, ref.matchId) : null;
    var open = '<div class="modal"><div class="backdrop" data-action="close-modal"></div>' +
      '<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="bet-title" tabindex="-1">' +
      '<button class="x" data-action="close-modal" aria-label="Close">×</button>';
    if (!m || !Game.canBet(m, Date.now())) {
      return open + '<h2 id="bet-title">Betting closed</h2><p class="muted">This match is no longer open for bets.</p>' +
        '<button class="btn" data-action="close-modal">Close</button></div></div>';
    }
    var bet = findBet(u, ref.comp, m.id);
    var openBet = bet && bet.status === "open" ? bet : null;
    var reason = Scoring.highStakesReason(m, comp, Scoring.rankMap(comp), R);
    var high = openBet ? openBet.high : !!reason;
    var avail = u.tokens + (openBet ? openBet.stake : 0);
    var def = openBet ? openBet.stake : (avail >= 10 ? 10 : R.stakes[0]);

    function stepper(name, label, val) {
      return '<div class="stepper"><button type="button" class="step" data-action="step" data-target="' + name + '" data-delta="-1" aria-label="One less goal for ' + esc(label) + '">−</button>' +
        '<input class="goal" type="number" name="' + name + '" min="0" max="' + R.maxGoals + '" inputmode="numeric" aria-label="' + esc(label) + ' goals" value="' + val + '">' +
        '<button type="button" class="step" data-action="step" data-target="' + name + '" data-delta="1" aria-label="One more goal for ' + esc(label) + '">+</button></div>';
    }
    var chips = R.stakes.map(function (s) {
      return '<label class="stakechip"><input type="radio" name="stake" value="' + s + '"' + (s === def ? " checked" : "") + (s > avail ? " disabled" : "") + "><span>" + s + "</span></label>";
    }).join("");

    var meta = "<span>" + esc(fmtDate(m.utcDate)) + "</span>";
    var rl = roundLabel(m);
    if (rl) meta += '<span class="badge">' + esc(rl) + "</span>";
    if (high) meta += '<span class="badge high">★ High stakes' + ((openBet && openBet.highReason) || reason ? ": " + esc((openBet && openBet.highReason) || reason) : "") + "</span>";

    return open + '<h2 id="bet-title">' + (openBet ? "Change your bet" : "Place your bet") + "</h2>" +
      '<div class="dlg-meta">' + meta + "<span>You have " + tok(u.tokens) + " tokens</span></div>" +
      '<form data-form="bet" data-comp="' + esc(ref.comp) + '" data-match="' + m.id + '">' +
      '<div class="sb"><div class="sb-col"><div class="sb-team">' + crest(m.home) + "<span>" + esc(m.home.name) + "</span></div>" + stepper("h", m.home.short || m.home.name, openBet ? openBet.pickHome : 0) + "</div>" +
      '<div class="sb-dash">–</div>' +
      '<div class="sb-col"><div class="sb-team">' + crest(m.away) + "<span>" + esc(m.away.name) + "</span></div>" + stepper("a", m.away.short || m.away.name, openBet ? openBet.pickAway : 0) + "</div></div>" +
      '<p class="stakes-label">Choose your stake (tokens)</p><div class="stakes">' + chips + "</div>" +
      (Game.dailyClaimed(u, Date.now()) ? "" : '<p class="hint">🎁 Your first bet today earns +' + R.dailyBonus + " bonus tokens.</p>") +
      '<div class="payouts"><span class="badge">Exact score <b>' + mult(high ? R.multExactHigh : R.multExact) + '</b></span><span class="badge">1 goal off <b>' + mult(R.multOff1) +
      '</b></span><span class="badge">2 goals off <b>' + mult(R.multOff2) + '</b></span><span class="badge">Further off <b>lose stake</b></span></div>' +
      '<div class="row"><button class="btn" type="submit">' + ball("btn-ball") + (openBet ? "Update bet" : "Place bet") + "</button>" +
      (openBet ? '<button type="button" class="btn danger" data-action="cancel-bet" data-bet="' + esc(openBet.id) + '">Cancel bet</button>' : "") +
      '<button type="button" class="btn ghost" data-action="close-modal">Close</button></div></form></div></div>';
  }

  // ---------- Know Stats page ----------
  function formDot(r, small, latest) {
    var word = r.res === "W" ? "Win" : r.res === "D" ? "Draw" : "Loss";
    var label = word + ", " + r.gf + "–" + r.ga + (r.home ? " at home to " : " away at ") + (r.opp.short || r.opp.name || "?");
    return '<span class="dot ' + r.res.toLowerCase() + (small ? " sm" : "") + (latest ? " latest" : "") + '" title="' + esc(label) + '" aria-label="' + esc(label) + '">' + r.res + "</span>";
  }
  function formDots(list, small) {
    if (!list.length) return '<span class="muted">–</span>';
    return '<span class="form">' + list.map(function (r, i) { return formDot(r, small, i === list.length - 1); }).join("") + "</span>";
  }

  function teamCard(v, side) {
    var rank = v.position != null
      ? '<div class="rankbig">#' + v.position + ' <span class="muted">' + (v.groupName ? "in " + esc(groupLabel(v.groupName)) : "of " + v.tableSize) + "</span></div>"
      : '<div class="muted">Not in the table yet</div>';
    var cells = [["Pts", v.points], ["P", v.played], ["W", v.w], ["D", v.d], ["L", v.l], ["GF", v.gf], ["GA", v.ga], ["GD", signed(v.gd)]];
    var grid = '<div class="sgrid">' + cells.map(function (c) { return "<div><b>" + esc(c[1]) + "</b><span>" + c[0] + "</span></div>"; }).join("") + "</div>";

    var recent = v.form.slice().reverse();
    var last = !v.form.length
      ? '<p class="muted">No matches played yet in this competition.</p>'
      : '<p class="formline"><span class="muted">Form, oldest → latest</span>' + formDots(v.form) + "</p>" +
        '<p class="hint" style="margin:.1rem 0 .5rem">Last ' + v.form.length + ": " + v.form.filter(function (r) { return r.res === "W"; }).length + "W " +
        v.form.filter(function (r) { return r.res === "D"; }).length + "D " + v.form.filter(function (r) { return r.res === "L"; }).length + "L · " +
        v.formPts + " of " + v.form.length * 3 + " points</p>" +
        '<ul class="last5" aria-label="Last matches, latest first">' + recent.map(function (r) {
          return "<li>" + formDot(r, true) + '<span class="when muted">' + esc(fmtShort(r.date)) + " · " + (r.home ? "H" : "A") + "</span>" +
            '<span class="opp">vs <strong>' + esc(r.opp.short || r.opp.name || "?") + '</strong></span><span class="sc">' + r.gf + "–" + r.ga + "</span></li>";
        }).join("") + "</ul>";

    return '<section class="card tcard"><div class="tname">' + crest(v.team) + "<span>" + esc(v.team.name) + '</span><span class="badge">' + side + "</span></div>" +
      rank + grid + last + "</section>";
  }

  function miniTable(t) {
    var body = t.rows.map(function (r) {
      if (r.gap) return '<tr class="gap"><td colspan="9" aria-hidden="true">⋯</td></tr>';
      var tag = r.side ? ' <span class="badge" title="' + (r.side === "home" ? "Home team" : "Away team") + '">' + (r.side === "home" ? "H" : "A") + "</span>" : "";
      return '<tr class="' + (r.side ? "hl " + r.side : "") + '"><td>' + r.position + '</td><td class="tm">' + crest(r.team) + "<span>" + esc(r.team.short || r.team.name) + "</span>" + tag + "</td>" +
        '<td class="num">' + r.played + '</td><td class="num">' + r.w + '</td><td class="num">' + r.d + '</td><td class="num">' + r.l + '</td><td class="num">' + signed(r.gd) +
        '</td><td class="num"><b>' + r.points + "</b></td><td>" + formDots(r.form, true) + "</td></tr>";
    }).join("");
    return (t.group ? '<h3 class="tgroup">' + esc(groupLabel(t.group)) + "</h3>" : "") +
      '<div class="card table-wrap"><table class="minitable"><thead><tr><th>#</th><th>Team</th><th class="num">P</th><th class="num">W</th><th class="num">D</th><th class="num">L</th>' +
      '<th class="num">GD</th><th class="num">Pts</th><th>Form</th></tr></thead><tbody>' + body + "</tbody></table></div>";
  }

  // The page behind the "Know Stats" button. Returns null when the match is no longer available.
  function renderStatsPage(u) {
    var ref = S.stats;
    var comp = S.data.competitions[ref.comp];
    var m = comp ? Game.findMatch(S.data, ref.comp, ref.matchId) : null;
    if (!m || m.home.id == null || m.away.id == null) { S.stats = null; return null; }
    var pv = Game.matchPreview(comp, m, S.statsFull);
    var finished = m.status === "FINISHED" && m.score;
    var bet = findBet(u, comp.code, m.id);
    var reason = finished ? null : Scoring.highStakesReason(m, comp, Scoring.rankMap(comp), R);
    var high = bet ? bet.high : !!reason;

    var tags = "<span>" + esc(fmtDate(m.utcDate)) + "</span>" + countBadge(m) + '<span class="badge">' + esc(comp.name) + "</span>";
    var rl = roundLabel(m);
    if (rl) tags += '<span class="badge">' + esc(rl) + "</span>";
    if (high) tags += '<span class="badge high">★ High stakes' + ((bet && bet.highReason) || reason ? ": " + esc((bet && bet.highReason) || reason) : "") + "</span>";
    var mid = finished ? '<span class="score">' + m.score.home + " – " + m.score.away + "</span>" : '<span class="vs">' + ball() + "</span>";

    var html = '<div class="backrow"><button class="btn ghost" data-action="close-stats">← Back to matches</button></div>' +
      '<article class="card match' + (high ? " high" : "") + '"><div class="meta">' + tags + "</div>" +
      '<div class="teams"><div class="team">' + crest(m.home) + "<span>" + esc(m.home.name) + "</span></div>" + mid +
      '<div class="team right"><span>' + esc(m.away.name) + "</span>" + crest(m.away) + "</div></div>" +
      (bet ? '<div class="match-foot">' + betSummary(bet) + "</div>" : "") + "</article>" +
      '<h2 class="section-title">Know Stats</h2><div class="vs-grid">' + teamCard(pv.home, "Home") + teamCard(pv.away, "Away") + "</div>" +
      '<h2 class="section-title">League table</h2>';

    if (!pv.tables.length) html += '<div class="empty">The table is not available yet.</div>';
    else {
      html += pv.tables.map(miniTable).join("");
      var shown = pv.tables.reduce(function (n, t) { return n + t.rows.filter(function (r) { return !r.gap; }).length; }, 0);
      var total = pv.tables.reduce(function (n, t) { return n + t.size; }, 0);
      if (S.statsFull || shown < total) {
        html += '<p><button class="btn ghost" data-action="stats-full">' + (S.statsFull ? "Show fewer teams" : "Show full table (" + total + " teams)") + "</button></p>";
      }
    }
    html += '<p class="hint">Stats use ' + esc(comp.name) + " matches only (no other leagues or cups). Scores show the team's own goals first." +
      (comp.kind === "cup" ? " Points, W/D/L and goals cover the league or group phase; the form dots include every round." : "") + "</p>" +
      '<div class="backrow" style="margin-top:1rem"><button class="btn ghost" data-action="close-stats">← Back to matches</button></div>';
    return html;
  }

  function openStats(comp, matchId) {
    S.scrollBack = window.pageYOffset || 0;
    S.stats = { comp: comp, matchId: matchId };
    S.statsFull = false;
    try {
      if (window.history && window.history.pushState) { window.history.pushState({ fpgStats: 1 }, ""); S.statsHist = true; }
    } catch (e) { S.statsHist = false; }
    render(); window.scrollTo(0, 0);
  }
  function closeStats() { S.stats = null; S.statsHist = false; render(); window.scrollTo(0, S.scrollBack || 0); }
  // The Back button uses the browser history, so the phone's own back button does the same thing.
  function backFromStats() {
    if (S.statsHist && window.history && window.history.back) window.history.back();
    else closeStats();
  }
  // Leaving the page some other way (another tab, switching player).
  function leaveStats() {
    if (!S.stats) return;
    S.stats = null;
    if (S.statsHist) { S.statsHist = false; try { window.history.back(); } catch (e) { /* ignore */ } }
  }

  // ---------- badges ----------
  function badgesSection(u) {
    var list = Game.badgeStatus(u);
    var earned = list.filter(function (b) { return b.earned; });
    var locked = list.filter(function (b) { return !b.earned; });
    function card(b) {
      var note = b.earned
        ? '<div class="b-note">Earned' + (b.earnedAt ? " " + esc(fmtShort(b.earnedAt)) : "") + "</div>"
        : (b.need > 1 ? '<div class="b-note">' + b.have + " / " + b.need + '</div><div class="progress thin"><div style="width:' + Math.round(b.have / b.need * 100) + '%"></div></div>' : "");
      return '<div class="bcard ' + (b.earned ? "earned" : "locked") + '"><div class="b-icon" aria-hidden="true">' + b.icon + '</div><div class="b-text"><strong>' +
        esc(b.name) + '</strong><div class="b-desc">' + esc(b.desc) + "</div>" + note + "</div></div>";
    }
    return '<h2 class="section-title">Badges <span class="muted" style="text-transform:none;letter-spacing:0">' + earned.length + " of " + list.length + " earned</span></h2>" +
      '<div class="badges">' + earned.concat(locked).map(card).join("") + "</div>";
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
    function mCard(b) {
      var right = "";
      if (b.status === "settled") {
        right = "Final " + b.result.home + "–" + b.result.away + " · " + mult(b.multiplier) + ' <span class="badge ' + (b.net > 0 ? "win" : b.net < 0 ? "loss" : "") + '">' + signed(b.net) + "</span>";
      } else if (b.status === "refunded") right = '<span class="badge">Refunded</span>';
      else right = "Open";
      return '<div class="card"><strong>' + esc(b.home) + " v " + esc(b.away) + '</strong> <span class="muted">· ' + esc(compName(b.comp)) + " · " + esc(fmtDate(b.kickoff)) + "</span>" +
        "<div>Pick " + b.pickHome + "–" + b.pickAway + " · stake " + tok(b.stake) + (b.high ? ' <span class="badge high">★ ' + esc(b.highReason || "High stakes") + "</span>" : "") + "</div>" +
        '<div class="muted">' + right + "</div></div>";
    }
    function wCard(b) {
      var right = b.status === "settled" ? '<span class="badge ' + (b.won ? "win" : "loss") + '">' + (b.won ? "Won " : "Lost ") + signed(b.net) + "</span>"
        : b.status === "refunded" ? '<span class="badge">Refunded</span>' : "Waiting for the season to finish";
      return '<div class="card"><strong>Season winner: ' + esc(b.teamName) + '</strong> <span class="muted">· ' + esc(compName(b.comp)) + "</span>" +
        "<div>Stake " + tok(b.stake) + " · locked " + mult(b.multiplier) + '</div><div class="muted">' + right + "</div></div>";
    }
    if (!u.bets.length && !u.winnerBets.length) return '<div class="empty">No bets yet. Head to Matches or Season winner to place one.</div>';

    // filters: league and result
    var codes = [];
    u.bets.concat(u.winnerBets).forEach(function (b) { if (codes.indexOf(b.comp) === -1) codes.push(b.comp); });
    codes.sort(function (a, b) {
      var ia = COMP_ORDER.indexOf(a), ib = COMP_ORDER.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
    if (S.bf.comp !== "all" && codes.indexOf(S.bf.comp) === -1) S.bf.comp = "all";
    function chip(action, val, label, on) {
      return '<button class="chip" aria-pressed="' + on + '" data-action="' + action + '" data-val="' + esc(val) + '">' + esc(label) + "</button>";
    }
    var filters = '<div class="chips">' + chip("bet-comp", "all", "All leagues", S.bf.comp === "all") +
      codes.map(function (c) { return chip("bet-comp", c, compName(c), S.bf.comp === c); }).join("") + "</div>" +
      '<div class="chips">' + [["all", "All"], ["open", "Open"], ["won", "Won"], ["lost", "Lost"]].map(function (s) {
        return chip("bet-status", s[0], s[1], S.bf.status === s[0]);
      }).join("") + "</div>";

    function okComp(b) { return S.bf.comp === "all" || b.comp === S.bf.comp; }
    function okMatch(b) {
      var st = S.bf.status;
      return st === "all" || (st === "open" && b.status === "open") || (st === "won" && b.status === "settled" && b.net > 0) || (st === "lost" && b.status === "settled" && b.net < 0);
    }
    function okWinner(b) {
      var st = S.bf.status;
      return st === "all" || (st === "open" && b.status === "open") || (st === "won" && b.status === "settled" && b.won) || (st === "lost" && b.status === "settled" && !b.won);
    }
    var mine = u.bets.filter(function (b) { return okComp(b) && okMatch(b); });
    var wins = u.winnerBets.filter(function (b) { return okComp(b) && okWinner(b); });
    var open = mine.filter(function (b) { return b.status === "open"; }).sort(byKick);
    var done = mine.filter(function (b) { return b.status !== "open"; }).sort(function (a, b) { return byKick(b, a); });
    var wOpen = wins.filter(function (b) { return b.status === "open"; });
    var wDone = wins.filter(function (b) { return b.status !== "open"; });

    var html = filters;
    if (!mine.length && !wins.length) return html + '<div class="empty">No bets match these filters.</div>';
    html += '<p class="hint" style="margin:0 0 .5rem">Showing ' + (mine.length + wins.length) + " of " + (u.bets.length + u.winnerBets.length) + " bets.</p>";
    if (open.length || wOpen.length) html += '<h2 class="section-title">Open</h2>' + wOpen.map(wCard).join("") + open.map(mCard).join("");
    if (done.length || wDone.length) html += '<h2 class="section-title">Settled</h2>' + wDone.map(wCard).join("") + done.map(mCard).join("");
    return html;
  }

  function renderStats(u) {
    var s = Game.stats(u), st = Game.streaks(u);
    function m(label, value, c) { return '<div class="metric"><b class="' + (c || "") + '">' + value + "</b><span>" + label + "</span></div>"; }
    var html = '<div class="metrics">' +
      m("Balance", tok(s.balance)) + m("Staked in open bets", tok(s.openStake)) + m("Bets settled", s.settled) +
      m("Bets in profit", s.hitRate == null ? "–" : s.hitRate + "%") + m("Exact scores", s.exact) +
      m("Net from matches", signed(s.netMatch), cls(s.netMatch)) + m("Net from season picks", signed(s.netWinner), cls(s.netWinner)) +
      m("Right-result streak", st.right.current) + m("Best streak", st.right.best) + "</div>" +
      '<p class="hint" style="margin:-.4rem 0 0">A streak counts settled bets in a row where you called the win, draw or loss correctly.</p>' +
      badgesSection(u);

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
    var body = S.stats ? renderStatsPage(u) : null;
    if (body === null) body = S.tab === "winner" ? renderWinner(u) : S.tab === "bets" ? renderBets(u) : S.tab === "stats" ? renderStats(u) : renderMatches(u);
    var updated = S.data.fetchedAt ? "Scores last changed " + fmtDay(S.data.fetchedAt) + "." : "";
    return '<div class="shell">' + renderHeader(u) + notices() + body +
      '<p class="footer">Game tokens only: no real money is involved. ' + updated + " Football data from football-data.org. Scores can be delayed.</p></div>";
  }

  function render() {
    var u = U();
    $app.innerHTML = u ? renderGame(u) + (S.modal ? betModal(u) : "") : renderLogin();
    if (S.modal && $app.querySelector) {
      // focus the popup itself (not a score box), so phones don't pop the keyboard up over it
      var dlg = $app.querySelector(".dialog");
      if (dlg && dlg.focus) dlg.focus();
    }
  }

  // ---------- actions ----------
  function afterLogin() { leaveStats(); S.tab = "matches"; S.comp = null; S.modal = null; save(); sync(); render(); window.scrollTo(0, 0); }

  function guarded(fn) {
    try { fn(); } catch (err) { toast(err.message, "error"); }
  }

  $app.addEventListener("click", function (e) {
    var el = e.target.closest("[data-action]");
    if (!el || el.tagName === "INPUT") return;
    var a = el.dataset.action, u = U();
    if (a === "open-bet") { S.modal = { comp: el.dataset.comp, matchId: Number(el.dataset.match) }; render(); }
    else if (a === "close-modal") { S.modal = null; render(); }
    else if (a === "step") {
      var form = el.closest("form");
      var input = form && form.elements[el.dataset.target];
      if (input) {
        var cur = parseInt(input.value, 10);
        if (isNaN(cur)) cur = 0;
        input.value = Math.max(0, Math.min(R.maxGoals, cur + Number(el.dataset.delta)));
      }
    }
    else if (a === "know-stats") { openStats(el.dataset.comp, Number(el.dataset.match)); }
    else if (a === "close-stats") { backFromStats(); }
    else if (a === "stats-full") { S.statsFull = !S.statsFull; render(); }
    else if (a === "bet-comp") { S.bf.comp = el.dataset.val; render(); }
    else if (a === "bet-status") { S.bf.status = el.dataset.val; render(); }
    else if (a === "login-as") { S.nick = el.dataset.nick; afterLogin(); }
    else if (a === "signup-back") { S.signup = null; render(); }
    else if (a === "switch") { leaveStats(); S.nick = null; S.modal = null; save(); render(); }
    else if (a === "tab") { leaveStats(); S.tab = el.dataset.tab; render(); window.scrollTo(0, 0); }
    else if (a === "comp") { S.comp = el.dataset.comp; render(); }
    else if (a === "more") { S.more[S.comp] = (S.more[S.comp] || STEP) + STEP; render(); }
    else if (a === "cancel-bet") {
      guarded(function () {
        var had = Game.dailyClaimed(u, Date.now());
        Game.cancelMatchBet(u, S.data, el.dataset.bet, Date.now());
        var lost = had && !Game.dailyClaimed(u, Date.now());
        S.modal = null; save(); render();
        toast("Bet cancelled and stake refunded." + (lost ? " The daily bonus was taken back because you have no other bet today." : ""));
      });
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
        var had = Game.dailyClaimed(u, Date.now());
        var bet = Game.placeMatchBet(u, S.data, {
          comp: f.dataset.comp, matchId: Number(f.dataset.match), pickHome: Number(hv), pickAway: Number(av), stake: Number(f.elements.stake.value)
        }, Date.now());
        var got = !had && Game.dailyClaimed(u, Date.now());
        var fresh = Game.updateBadges(u, Date.now());
        S.modal = null; save(); render();
        toast("Bet placed: " + bet.home + " " + bet.pickHome + "–" + bet.pickAway + " " + bet.away + ", stake " + bet.stake + (bet.high ? " (high stakes)." : ".") +
          (got ? " 🎁 +" + R.dailyBonus + " daily bonus!" : "") + (fresh.length ? " " + badgeNote(fresh) : ""));
      });
    } else if (kind === "winner" && u) {
      guarded(function () {
        var had = Game.dailyClaimed(u, Date.now());
        var bet = Game.placeWinnerBet(u, S.data, { comp: f.dataset.comp, teamId: Number(f.elements.team.value), stake: Number(f.elements.stake.value) }, Date.now());
        var got = !had && Game.dailyClaimed(u, Date.now());
        var fresh = Game.updateBadges(u, Date.now());
        save(); render();
        toast("Locked in " + bet.teamName + " at " + mult(bet.multiplier) + "." + (got ? " 🎁 +" + R.dailyBonus + " daily bonus!" : "") + (fresh.length ? " " + badgeNote(fresh) : ""));
      });
    }
  });

  // ---------- startup ----------
  function refresh() {
    return loadData().then(function () { sync(); if (S.modal) return; var a = document.activeElement; if (!a || !$app.contains(a) || !/^(INPUT|SELECT)$/.test(a.tagName)) render(); });
  }

  checkStorage();
  S.users = loadUsers();
  Object.keys(S.users).forEach(function (k) { Game.normalizeUser(S.users[k]); });
  try { var cur = localStorage.getItem(LS_CUR); if (cur && S.users[cur]) S.nick = cur; } catch (e) { /* ignore */ }
  render();
  loadData().then(function () { sync(); render(); });

  setInterval(function () { if (!document.hidden) refresh(); }, REFRESH_MS);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && S.modal) { S.modal = null; render(); }
    else if (e.key === "Escape" && S.stats) backFromStats();
  });
  // The phone's own back button closes the stats page.
  if (window.addEventListener) window.addEventListener("popstate", function () { if (S.stats) closeStats(); });

  // Kickoff countdowns: update the text in place every second (no full re-draw).
  function tickCountdowns() {
    if (!$app.querySelectorAll) return;
    var els = $app.querySelectorAll("[data-kick]"), now = Date.now(), started = false;
    for (var i = 0; i < els.length; i++) {
      var ms = new Date(els[i].getAttribute("data-kick")).getTime() - now;
      var text = kickText(ms);
      if (els[i].textContent !== text) els[i].textContent = text;
      if (ms <= 0) started = true;
    }
    if (started && !S.modal) { // a match just kicked off: redraw so its Bet button closes
      var a = document.activeElement;
      if (!a || !$app.contains(a) || !/^(INPUT|SELECT)$/.test(a.tagName)) render();
    }
  }
  setInterval(function () { if (!document.hidden) tickCountdowns(); }, 1000);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && Date.now() - S.lastLoad > 5 * 60 * 1000) refresh();
  });
})();
