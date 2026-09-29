// Quick Node smoke test for providers/dola.js (run: node test-dola.js).
// Not shipped.
//
// Fresh-provider contract pins: identity, vision flag, mode-chip click
// guard, native-tool drift rules, disabled-send wait, and the single
// send-button click path. Stub DOM only - live-DOM validation on dola.com is
// still required (see LIVE-DOM notes in providers/dola.js). No jsdom,
// no npm install.
const fs = require("fs");

global.window = {};
global.location = { pathname: "/" };
global.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
  dispatchEvent: () => {},
  documentElement: { classList: { contains: () => false } },
  body: null,
};
global.MutationObserver = class { observe() {} disconnect() {} };
global.setInterval = () => 0;
global.getComputedStyle = () => ({});
global.CustomEvent = class { constructor(t) { this.type = t; } };

// Generic factory must load first (dola.js consumes window.makeGenericProvider).
new Function(fs.readFileSync(__dirname + "/providers/generic.js", "utf8"))();
const P = new Function(
  fs.readFileSync(__dirname + "/providers/dola.js", "utf8") + "; return RLProvider;"
)();

const ok = (name, cond) => { console.log((cond ? "PASS" : "FAIL") + "  " + name); if (!cond) process.exitCode = 1; };
const src = fs.readFileSync(__dirname + "/providers/dola.js", "utf8");

ok("provider id is dola", P.id === "dola");
ok("display name names Dola", /^dola$/i.test(P.displayName || ""));
ok("vision off until validated", P.supportsVision === false);
ok("streaming chrome excluded", /progressbar|aria-busy/i.test(P.volatileSel || ""));
ok("promptExtra requires login note", /log ?in/i.test(P.promptExtra || ""));
ok("promptExtra bans native tools", /never.*native|skills|scheduled tasks/i.test(P.promptExtra || ""));
ok("promptExtra leaves mode chips alone", /mode chip/i.test(P.promptExtra || ""));
ok("image calls refuse cleanly", /image input is off|describe with text/i.test(src));
ok("send finder skips mode chips", /Create Videos|homework|translate/i.test(src));
ok("send finder skips disabled", /aria-disabled|greyed|isDisabled/i.test(src));
// Single click path (send only) - mode chips (+, Fast, ...) must never click.
const clicks = src.match(/\.click\(\)/g) || [];
ok("single click path (send only)", clicks.length === 1);
ok("no vote-gate hook", typeof P.voteGateActive === "undefined");
ok("no orchestration hook", typeof P.isComparisonTurn === "undefined");
ok("no in-flow mount (anchored card)", P.barMount() === null);
ok("core skips inflow for Dola", P.noInflow === true);
ok("unstable pill set", /unstableWarning/.test(src));

for (const fn of ["getEditor", "typeAndSend", "setInputLock", "isGenerating",
                  "isBusyNow", "readAssistant", "installSendHooks", "findToolBlockSpot"]) {
  ok("exposes " + fn, typeof P[fn] === "function");
}

ok("init runs clean", (() => { try { P.init({}); return true; } catch { return false; } })());
ok("manifest routes dola.com", (() => {
  try {
    const m = JSON.parse(fs.readFileSync(__dirname + "/manifest.json", "utf8"));
    return m.content_scripts.some((c) =>
      (c.matches || []).some((u) => u.includes("dola.com")) &&
      (c.js || []).includes("providers/dola.js"));
  } catch { return false; }
})());
ok("manifest routes www.dola.com too (apex pattern does not cover www)", (() => {
  try {
    const m = JSON.parse(fs.readFileSync(__dirname + "/manifest.json", "utf8"));
    const bundle = m.content_scripts.find((c) => (c.js || []).includes("providers/dola.js"));
    const matches = bundle ? bundle.matches || [] : [];
    const perms = m.host_permissions || [];
    return matches.some((u) => u.includes("www.dola.com")) &&
      perms.some((u) => u.includes("www.dola.com"));
  } catch { return false; }
})());
// Cross-provider audit: every matches entry must have a host permission.
// (A bundle without one silently never injects - the www.dola.com outage.)
ok("every bundle host is permitted", (() => {
  try {
    const m = JSON.parse(fs.readFileSync(__dirname + "/manifest.json", "utf8"));
    const perms = m.host_permissions || [];
    const hostOf = (u) => (u.match(/^https?:\/\/([^/]+)/) || [])[1] || "";
    return m.content_scripts.every((c) =>
      (c.matches || []).every((u) => perms.some((p) => hostOf(p) === hostOf(u))));
  } catch { return false; }
})());
ok("background covers dola.com", (() => {
  try {
    const bg = fs.readFileSync(__dirname + "/background.js", "utf8");
    return bg.includes("https://dola.com/*") && bg.includes("www.dola.com");
  } catch { return false; }
})());
ok("popup lists dola.com", (() => {
  try {
    return fs.readFileSync(__dirname + "/popup.js", "utf8").includes("dola.com");
  } catch { return false; }
})());
ok("switcher lists Dola URL", (() => {
  try {
    return fs.readFileSync(__dirname + "/core/main.js", "utf8").includes("dola.com/");
  } catch { return false; }
})());

// ── Bar placement (HF lesson: never in-flow on a flex-row composer) ──────
{
  const fakeEl = (o) => Object.assign({
    isConnected: true, tagName: "DIV", innerText: "", textContent: "",
    parentElement: null, children: [],
    contains(x) {
      return x === this ||
        (this.children || []).some((c) => c === x || (c.contains && c.contains(x)));
    },
    getBoundingClientRect() { return this._rect || { width: 0, height: 0, left: 0, top: 0 }; },
    getClientRects() { return this.isConnected ? [this.getBoundingClientRect()] : []; },
    getAttribute() { return null; },
    closest() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  }, o);
  const sendBtn = fakeEl({ tagName: "BUTTON" });
  const editor = fakeEl({ tagName: "TEXTAREA" });
  const row = fakeEl({ children: [editor, sendBtn] });
  row._rect = { width: 480, height: 52, left: 0, top: 0 };
  row._cs = { borderRadius: "0px", flexDirection: "row" };
  const card = fakeEl({ children: [row] });
  card._rect = { width: 480, height: 150, left: 0, top: 0 };
  card._cs = { borderRadius: "24px", flexDirection: "column" };
  const main = fakeEl({ children: [card] });
  editor.parentElement = row;
  sendBtn.parentElement = row;
  row.parentElement = card;
  card.parentElement = main;
  main.parentElement = null;
  global.document = {
    body: fakeEl({}),
    querySelector: (s) => {
      const all = global.document.querySelectorAll(s);
      return all.length ? all[0] : null;
    },
    querySelectorAll: (s) => {
      if (/textarea/i.test(s)) return [editor];
      if (/button/i.test(s)) return [sendBtn];
      return [];
    },
    addEventListener: () => {},
  };
  global.getComputedStyle = (el) => (el && el._cs) || { borderRadius: "0px", flexDirection: "" };
  ok("anchor hugs the card, not the inner row", P.barAnchor() === card);
  card.isConnected = false;
  ok("detached card degrades gracefully",
    (() => { try { return P.barAnchor() === null; } catch { return false; } })());

// ── Input budget + acceptance ──────────────────────────────────────────
ok("capResult passes small text through",
  P.capResult("hello") === "hello");
{
  const big = P.capResult(new Array(5001).join("x"));
  ok("capResult caps oversize results", big.length <= 3500);
  ok("capResult marks the gap", /omitted|budget/i.test(big));
}
ok("acceptance probe fails fast", /accepted only/.test(src));

// ── Sent-but-invisible turns (blank-page mute spinner) ───────────────────
// A cleared composer is not proof: the turn must render, else one bounded
// extra wait, then an honest banner - never a mute 300s hang.
{
  const fs = require("fs");
  const mainSrc = fs.readFileSync(__dirname + "/core/main.js", "utf8");
  ok("no-turn branch exists", /send\.noTurn/.test(mainSrc));
  ok("no-turn banner copy", /Message sent but not showing/.test(mainSrc));
}
}
