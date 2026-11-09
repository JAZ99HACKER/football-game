// UI smoke test: runs js/app.js against a minimal fake browser and drives it through a full session.
// Run with: node --test tests/smoke.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();
const T = (id, name, short) => ({ id, name, short: short || name, tla: null, crest: id === 86 ? "https://c/86.png" : null });
const RM = T(86, "Real Madrid CF", "Real Madrid");
const FCB = T(81, "FC Barcelona", "Barça");
const GIR = T(298, "Girona FC", "Girona");
const SEV = T(559, "Sevilla FC", "Sevilla");
const MUN = T(66, "Manchester United FC", "Man United");
const MCI = T(65, "Manchester City FC", "Man City");

function buildData(now) {
  const rows = (teams) => [{ group: null, stage: "REGULAR_SEASON", table: teams.map((t, i) => ({ position: i + 1, team: t, played: 10, points: 20 - i, gd: 5 - i })) }];
  const mk = (id, ms, status, home, away, score, stage) => ({ id, utcDate: iso(ms), status, matchday: 11, stage: stage || "REGULAR_SEASON", home, away, score: score || null, winner: null });
  return {
    fetchedAt: iso(now),
    competitions: {
      PD: {
        code: "PD", name: "La Liga", kind: "league", seasonId: "PD-2026", totalCount: 380, finishedCount: 100, totalMatchdays: 38, champion: null,
        standings: rows([FCB, RM, GIR, SEV]),
        matches: [
          mk(1, now + 2 * DAY, "SCHEDULED", RM, FCB),
          mk(2, now + 3 * DAY, "TIMED", GIR, SEV),
          mk(3, now - 2 * DAY, "FINISHED", SEV, GIR, { home: 1, away: 1 }),
          mk(4, now + 9 * DAY, "SCHEDULED", { id: null, name: null, short: null }, SEV)
        ]
      },
      PL: {
        code: "PL", name: "Premier League", kind: "league", seasonId: "PL-2026", totalCount: 380, finishedCount: 100, totalMatchdays: 38, champion: null,
        standings: rows([MCI, MUN]),
        matches: [mk(11, now + DAY, "SCHEDULED", MUN, MCI)]
      },
      CL: {
        code: "CL", name: "Champions League", kind: "cup", seasonId: "CL-2026", totalCount: 189, finishedCount: 100, totalMatchdays: 8, champion: null,
        standings: rows([RM, MCI]),
        matches: [mk(21, now + 4 * DAY, "TIMED", RM, MCI, null, "LAST_16")]
      }
    }
  };
}

test("full session through the UI", async () => {
  const now = Date.now();
  const data = buildData(now);

  // ---- fake browser ----
  const store = {};
  const handlers = {};
  const docHandlers = {};
  const app ={ innerHTML: "", addEventListener: (t, fn) => { handlers[t] = fn; }, contains: () => false };
  const toastEl = { hidden: true, className: "", textContent: "" };
  global.document = {
    getElementById: (id) => (id === "app" ? app : toastEl),
    addEventListener: (t, fn) => { docHandlers[t] = fn; }, hidden: false, activeElement: null,
    createElement: () => ({ click() {}, remove() {} }), body: { appendChild() {} }
  };
  global.window = { scrollTo() {}, confirm: () => true };
  global.location = { protocol: "https:" };
  global.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  };
  global.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(JSON.parse(JSON.stringify(data))) });
  global.setInterval = () => 0;
  global.Scoring = require("../js/scoring.js");
  global.Game = require("../js/game.js");
  require("../js/app.js");
  const tick = () => new Promise((r) => setTimeout(r, 15));

  const click = (dataset, tag, form) => {
    const el = { tagName: tag || "BUTTON", dataset, closest: () => form || null };
    handlers.click({ target: { closest: (sel) => (sel === "[data-action]" ? el : null) } });
  };
  const submit = (dataset, extra) => {
    const form = Object.assign({ dataset }, extra);
    handlers.submit({ target: { closest: () => form }, preventDefault() {} });
  };
  const change = (dataset, extra) => handlers.change({ target: Object.assign({ dataset }, extra) });
  const user = () => JSON.parse(store["fpg.users.v1"]).sam;

  // login screen
  await tick();
  assert.match(app.innerHTML, /Football Prediction Game/);
  assert.match(app.innerHTML, /name="nick"/);

  // bad nickname rejected, good one goes to league step
  submit({ form: "login" }, { elements: { nick: { value: "x" } } });
  assert.equal(toastEl.className, "toast error");
  submit({ form: "login" }, { elements: { nick: { value: "  Sam  " } } });
  assert.match(app.innerHTML, /Welcome, Sam!/);
  assert.match(app.innerHTML, /La Liga/);
  assert.match(app.innerHTML, /Champions League/);

  // sign up with two leagues
  submit({ form: "signup" }, { querySelectorAll: () => [{ value: "PD" }, { value: "PL" }] });
  assert.match(app.innerHTML, /Matches/);
  assert.match(app.innerHTML, /Real Madrid CF/);
  assert.match(app.innerHTML, /High stakes: El Clasico/);
  assert.match(app.innerHTML, /Teams not decided yet/);
  assert.match(app.innerHTML, /🪙 100/);
  assert.equal(user().tokens, 100);

  // the match list has Bet Now buttons, no score boxes and no popup
  assert.match(app.innerHTML, /Bet Now/);
  assert.doesNotMatch(app.innerHTML, /name="h"/);
  assert.doesNotMatch(app.innerHTML, /role="dialog"/);
  assert.match(app.innerHTML, /class="crest ph"/); // teams without a crest get a badge

  // Bet Now opens the popup for the Clasico (match 1)
  click({ action: "open-bet", comp: "PD", match: "1" });
  assert.match(app.innerHTML, /role="dialog"/);
  assert.match(app.innerHTML, /Place your bet/);
  assert.match(app.innerHTML, /High stakes: El Clasico/);
  assert.match(app.innerHTML, /name="stake" value="10" checked/);

  // the + and - buttons change the goal box, never below 0
  const stepForm = { elements: { h: { value: "0" } } };
  click({ action: "step", target: "h", delta: "1" }, "BUTTON", stepForm);
  assert.equal(stepForm.elements.h.value, 1);
  click({ action: "step", target: "h", delta: "-1" }, "BUTTON", stepForm);
  click({ action: "step", target: "h", delta: "-1" }, "BUTTON", stepForm);
  assert.equal(stepForm.elements.h.value, 0);

  // the popup closes with the Close button and with Escape
  click({ action: "close-modal" });
  assert.doesNotMatch(app.innerHTML, /role="dialog"/);
  click({ action: "open-bet", comp: "PD", match: "1" });
  docHandlers.keydown({ key: "Escape" });
  assert.doesNotMatch(app.innerHTML, /role="dialog"/);

  // place the bet from the popup
  click({ action: "open-bet", comp: "PD", match: "1" });
  submit({ form: "bet", comp: "PD", match: "1" }, { elements: { h: { value: "2" }, a: { value: "1" }, stake: { value: "20" } } });
  assert.equal(user().tokens, 80);
  assert.doesNotMatch(app.innerHTML, /role="dialog"/); // popup closes after placing
  assert.match(app.innerHTML, /Your pick: <strong>2–1<\/strong>/);
  assert.match(app.innerHTML, /Change bet/);

  // opening it again shows the existing pick and a cancel button
  click({ action: "open-bet", comp: "PD", match: "1" });
  assert.match(app.innerHTML, /Change your bet/);
  assert.match(app.innerHTML, /Cancel bet/);
  assert.match(app.innerHTML, /name="h"[^>]*value="2"/);
  assert.match(app.innerHTML, /name="a"[^>]*value="1"/);
  click({ action: "close-modal" });

  // blank score is refused, nothing changes
  submit({ form: "bet", comp: "PD", match: "2" }, { elements: { h: { value: "" }, a: { value: "1" }, stake: { value: "5" } } });
  assert.equal(toastEl.className, "toast error");
  assert.equal(user().tokens, 80);

  // winner tab: place a pick
  click({ action: "tab", tab: "winner" });
  assert.match(app.innerHTML, /Season progress/);
  assert.match(app.innerHTML, /Champion<select/);
  submit({ form: "winner", comp: "PD" }, { elements: { team: { value: "86" }, stake: { value: "30" } } });
  assert.equal(user().tokens, 50);
  assert.match(app.innerHTML, /Your pick: <strong>Real Madrid CF<\/strong>/);

  // bets tab, stats tab, switch league chip
  click({ action: "tab", tab: "bets" });
  assert.match(app.innerHTML, /Season winner: Real Madrid CF/);
  assert.match(app.innerHTML, /Real Madrid v Barça/);
  click({ action: "tab", tab: "stats" });
  assert.match(app.innerHTML, /Recent token history/);
  assert.match(app.innerHTML, /Download backup/);
  click({ action: "tab", tab: "matches" });
  click({ action: "comp", comp: "PL" });
  assert.match(app.innerHTML, /Manchester United FC/);
  assert.match(app.innerHTML, /Manchester derby/);

  // cannot leave a league with an open bet; can join CL
  change({ action: "toggle-league", comp: "PD" }, { checked: false });
  assert.equal(toastEl.className, "toast error");
  assert.ok(user().leagues.includes("PD"));
  change({ action: "toggle-league", comp: "CL" }, { checked: true });
  assert.ok(user().leagues.includes("CL"));
  click({ action: "tab", tab: "matches" });
  click({ action: "comp", comp: "CL" });
  assert.match(app.innerHTML, /Round of 16/);
  assert.match(app.innerHTML, /High stakes/);

  // cancel the bet: stake comes back
  click({ action: "comp", comp: "PD" });
  const betId = user().bets[0].id;
  click({ action: "cancel-bet", bet: betId });
  assert.equal(user().tokens, 70); // 50 after the winner pick + 20 refunded

  // switching player returns to the login screen with the player listed
  click({ action: "switch" });
  assert.match(app.innerHTML, /Players on this device/);
  submit({ form: "login" }, { elements: { nick: { value: "Sam" } } });
  assert.match(app.innerHTML, /Matches/);

  // restore the right user for the settlement check
  click({ action: "tab", tab: "matches" });
  click({ action: "comp", comp: "PD" });
  submit({ form: "bet", comp: "PD", match: "2" }, { elements: { h: { value: "1" }, a: { value: "0" }, stake: { value: "10" } } });
  assert.equal(user().tokens, 60);

  // the match finishes; settle with the new data (Girona v Sevilla is a top-6 clash, so an exact pick pays 3x)
  data.competitions.PD.matches[1].status = "FINISHED";
  data.competitions.PD.matches[1].score = { home: 1, away: 0 };
  document.hidden = false;
  // trigger refresh through visibility handler path by calling the stored login flow again
  click({ action: "switch" });
  await new Promise((r) => setTimeout(r, 5));
  // reloading data happens on startup/refresh; emulate by re-requiring the Game settle with new data
  const u = user();
  const events = Game.settleAll(u, JSON.parse(JSON.stringify(data)), Date.now());
  assert.equal(events.length, 1);
  assert.equal(u.tokens, 90); // 60 + 30 payout

  // a backup containing a hostile nickname must be escaped everywhere it is shown
  const evil = Game.newUser("<script>alert(1)</script>", ["PD"], Date.now());
  evil.bets.push({ id: "x", matchId: 1, comp: "PD", home: "<b>H</b>", away: "<i>A</i>", kickoff: iso(Date.now() + DAY), pickHome: 1, pickAway: 0, stake: 5, high: true, highReason: "<img src=x onerror=alert(1)>", status: "open" });
  const backup = Game.exportAll({ evil });
  change({ action: "import" }, { files: [{ text: () => Promise.resolve(backup) }] });
  await tick();
  assert.match(app.innerHTML, /&lt;script&gt;/);
  assert.doesNotMatch(app.innerHTML, /<script/i);
  click({ action: "login-as", nick: "evil" });
  click({ action: "tab", tab: "bets" });
  assert.doesNotMatch(app.innerHTML, /<script|<img src=x|<b>H|<i>A/i);
  assert.match(app.innerHTML, /&lt;b&gt;H&lt;\/b&gt;/);
});
