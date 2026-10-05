// Quick Node smoke test for providers/hfchat.js (run: node test-hfchat.js).
// Not shipped.
//
// Fresh-provider contract pins: identity, vision flag, login/model rules,
// and the single send-button click path. Stub DOM only - live-DOM validation
// on huggingface.co/chat is still required (see LIVE-DOM notes in
// providers/hfchat.js). No jsdom, no npm install.
const fs = require("fs");

global.window = {};
global.location = { pathname: "/chat" };
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

// Generic factory must load first (hfchat.js consumes window.makeGenericProvider).
new Function(fs.readFileSync(__dirname + "/providers/generic.js", "utf8"))();
const P = new Function(
  fs.readFileSync(__dirname + "/providers/hfchat.js", "utf8") + "; return RLProvider;"
)();

const ok = (name, cond) => { console.log((cond ? "PASS" : "FAIL") + "  " + name); if (!cond) process.exitCode = 1; };
const src = fs.readFileSync(__dirname + "/providers/hfchat.js", "utf8");

ok("provider id is hfchat", P.id === "hfchat");
ok("display name names HF Chat", /hf chat/i.test(P.displayName || ""));
ok("vision off until validated", P.supportsVision === false);
ok("streaming chrome excluded", /progressbar|aria-busy/i.test(P.volatileSel || ""));
ok("promptExtra requires login note", /log ?in/i.test(P.promptExtra || ""));
ok("promptExtra warns on model variance", /model/i.test(P.promptExtra || ""));
ok("promptExtra bans the literal placeholder", /command_name is a placeholder|never.*command_name/i.test(P.promptExtra || ""));
ok("image calls refuse cleanly", /image input is off|describe with text/i.test(src));
// Single click path (send only) - never a vote/model-picker click.
const clicks = src.match(/\.click\(\)/g) || [];
ok("single click path (send only)", clicks.length === 1);
ok("no vote-gate hook", typeof P.voteGateActive === "undefined");
ok("no orchestration hook", typeof P.isComparisonTurn === "undefined");
ok("unstable pill set", /unstableWarning/.test(src));

for (const fn of ["getEditor", "typeAndSend", "setInputLock", "isGenerating",
                  "isBusyNow", "readAssistant", "installSendHooks", "findToolBlockSpot"]) {
  ok("exposes " + fn, typeof P[fn] === "function");
}

ok("init runs clean", (() => { try { P.init({}); return true; } catch { return false; } })());
ok("manifest routes huggingface.co/chat", (() => {
  try {
    const m = JSON.parse(fs.readFileSync(__dirname + "/manifest.json", "utf8"));
    return m.content_scripts.some((c) =>
      (c.matches || []).some((u) => u.includes("huggingface.co/chat")) &&
      (c.js || []).includes("providers/hfchat.js"));
  } catch { return false; }
})());
ok("background covers huggingface.co", (() => {
  try {
    return fs.readFileSync(__dirname + "/background.js", "utf8").includes("https://huggingface.co/chat*");
  } catch { return false; }
})());
ok("popup lists huggingface.co", (() => {
  try {
    return fs.readFileSync(__dirname + "/popup.js", "utf8").includes("huggingface.co");
  } catch { return false; }
})());
ok("switcher lists HF Chat", (() => {
  try {
    return fs.readFileSync(__dirname + "/core/main.js", "utf8").includes("huggingface.co/chat");
  } catch { return false; }
})());

// ── Bar placement (the "bar on the left" bug) ────────────────────────────
// chat-ui lays the composer out as a horizontal flex row, so the generic
// in-flow mount landed #rl-bar beside the input. HF must never in-flow
// mount (Svelte-reconciled DOM) and must hug the composer CARD instead.
ok("no in-flow mount on HF (bar lives in #rl-root)", P.barMount() === null);
ok("core skips inflow for HF", P.noInflow === true);
{
  // Fake composer: editor + send inside a short square row inside a tall
  // rounded card. barAnchor must return the CARD, never the row.
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
  row._rect = { width: 500, height: 56, left: 0, top: 0 };
  row._cs = { borderRadius: "0px", flexDirection: "row" };
  const card = fakeEl({ children: [row] });
  card._rect = { width: 500, height: 140, left: 0, top: 0 };
  card._cs = { borderRadius: "20px", flexDirection: "column" };
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
  // Teardown: detached card degrades to null (core falls back), never throws.
  card.isConnected = false;
  ok("detached card degrades gracefully",
    (() => { try { return P.barAnchor() === null; } catch { return false; } })());

// Loop wiring (static pins - the turn itself needs a live page).
{
  const mainSrc = fs.readFileSync(__dirname + "/core/main.js", "utf8");
  ok("core detects placeholder attempts", /placeholderCall/.test(mainSrc));
  ok("core fires placeholder parse_error", /reason: "placeholder"/.test(mainSrc));
  ok("placeholder chip detail named", /placeholder name/.test(mainSrc));
  const cfgSrc = fs.readFileSync(__dirname + "/core/config.js", "utf8");
  ok("placeholder feedback teaches", /EXAMPLE name from the instructions|example name/i.test(cfgSrc));
}
}
