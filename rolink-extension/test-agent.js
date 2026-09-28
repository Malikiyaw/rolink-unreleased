// Quick Node smoke test for providers/agent.js (run: node test-agent.js).
// Not shipped.
//
// Why this exists: Agent Mode (/agent route) is a different app from /text
// chat - ProseMirror composer, orchestration phases, and a human vote gate.
// This pins the supervised-only contract: the provider reads settled output,
// parks (never times out) at human gates, and never exposes a way to click
// the vote buttons.
//
// The provider is a browser IIFE built on providers/generic.js, so both are
// evaluated here against a minimal stub DOM. No jsdom, no npm install.
const fs = require("fs");

global.window = {};
global.location = { pathname: "/agent" };
global.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
  dispatchEvent: () => {},
  documentElement: { classList: { contains: () => false } },
  body: null,
};
global.MutationObserver = class { observe() {} disconnect() {} };
// init() starts a rescan interval (browser-only concern); no-op it here so the
// process exits instead of hanging on a live timer.
global.setInterval = () => 0;
global.getComputedStyle = () => ({});
global.CustomEvent = class { constructor(t) { this.type = t; } };
// The provider's discovery caches are time-keyed (marker scan cooldown 3s,
// shadow-scope rescan 5s, marker turn cache 10s). The whole suite runs in
// well under one wall-clock second, so the FIRST (inevitably failed) scan of
// an early fixture used to poison every later fixture: cooldown never
// expired, shadow roots found later were never rescanned. Each withDoc
// fixture advances this clock by 10s - one fixture = one later moment -
// while staying constant INSIDE a fixture so intra-call deltas are untouched.
const realNow = Date.now.bind(Date);
let clockSkew = 0;
Date.now = () => realNow() + clockSkew;

// Generic factory must load first (agent.js consumes window.makeGenericProvider).
new Function(fs.readFileSync(__dirname + "/providers/generic.js", "utf8"))();
// Real command parser (same file the extension ships): read-path tests exercise
// true signature/parse behavior (test-parser.js proves this file loads clean).
global.RLParse = new Function(
  fs.readFileSync(__dirname + "/core/parser.js", "utf8") + "; return RLParse;"
)();
const P = new Function(
  fs.readFileSync(__dirname + "/providers/agent.js", "utf8") + "; return RLProvider;"
)();

const ok = (name, cond) => { console.log((cond ? "PASS" : "FAIL") + "  " + name); if (!cond) process.exitCode = 1; };

ok("provider id is agent", P.id === "agent");
ok("display name names Arena Agent", /arena agent/i.test(P.displayName || ""));
ok("vision off until the /agent upload path is validated", P.supportsVision === false);

ok("voteGateActive hook exists", typeof P.voteGateActive === "function");
ok("no in-flow mount on agent (bar lives in #rl-root)", P.barMount() === null);
const agentSrc = fs.readFileSync(__dirname + "/providers/agent.js", "utf8");
// Supervised-only contract: exactly ONE .click() exists in the whole provider
// (the send button). There must never be a click path reaching the human vote
// buttons (Yes / No / Keep working are leaderboard votes).
const clicks = agentSrc.match(/\.click\(\)/g) || [];
ok("single click path (send only), never a vote button", clicks.length === 1);

// Quiet DOM: no vote UI present, so the gate reads inactive (fail-open would
// also pass, but we assert the negative explicitly).
ok("gate inactive on empty DOM", P.voteGateActive() === false);

// System-prompt rules: verbatim JSON for Studio, hands off human prompts.
ok("promptExtra demands verbatim commands", /verbatim/i.test(P.promptExtra || ""));
ok("promptExtra leaves human prompts alone", /wait|user clicks/i.test(P.promptExtra || ""));
ok("unstable pill warns supervised-only", /supervised/i.test(P.unstableWarning || ""));

// Core interface the loop depends on.
for (const fn of ["getEditor", "typeAndSend", "setInputLock", "isGenerating",
                  "isBusyNow", "readAssistant", "installSendHooks", "findToolBlockSpot",
                  "barAnchor"]) {
  ok("exposes " + fn, typeof P[fn] === "function");
}

// Run-visibility contract (core/main.js): while a run is live but the composer
// is gone, the bar holds last-known geometry instead of hiding - a vanished
// bar mid-run reads as "Start did nothing".
const mainSrc = fs.readFileSync(__dirname + "/core/main.js", "utf8");
ok("core holds bar visible mid-run", /function holdLastGeom/.test(mainSrc) && /lastBarGeom/.test(mainSrc));
ok("in-flow placements record geometry too", /noteBarVis\("shown:inflow"\)/.test(mainSrc) &&
   (mainSrc.match(/lastBarGeom = \{/g) || []).length >= 3);
ok("hold has a live-rect fallback when nothing was recorded",
   /Last-chance capture/.test(mainSrc));
ok("hide/hold paths are traced", /noteBarVis\("hide:/.test(mainSrc) && /noteBarVis\("hold"\)/.test(mainSrc));
ok("core honors noInflow opt-out", /P\.noInflow \? null : computeBarMount/.test(mainSrc));
ok("bar clicks never bubble to the site", /stopPropagation/.test(mainSrc));
ok("chunked ProseMirror send with remount wait",
   /SEND_CHUNK/.test(agentSrc) && /waitEditor\(3000\)/.test(agentSrc));

// init() must start DOM watching without throwing on the stub.
ok("init runs clean", (() => { try { P.init({}); return true; } catch { return false; } })());

// ── Composer discovery shapes ─────────────────────────────────────────────
// The "input box not found" failure: the strict selector set missed the real
// composer, or an over-broad dialog exclusion rejected it. Fake editables with
// just enough surface (closest/isConnected/rects/classList) to run getEditor.
function fakeEditable(o) {
  o = o || {};
  return {
    isConnected: o.connected !== false,
    isContentEditable: o.editable !== false,
    tagName: o.tag || "DIV",
    classList: { contains: (c) => (o.cls || []).includes(c) },
    getAttribute: (n) => (o.attrs && n in o.attrs ? o.attrs[n] : null),
    hasAttribute: (n) => !!(o.attrs && n in o.attrs),
    closest: (sel) => {
      if (/rl-root/.test(sel)) return null;
      if (/role="dialog"/.test(sel)) return o.inVoteDialog
        ? { textContent: "Was this task successful? Yes No Keep working" }
        : (o.inPlainDialog ? { textContent: "Some app panel" } : null);
      return null;
    },
    getClientRects: () => (o.hidden ? [] : [{}]),
    parentElement: null,
    dataset: {},
  };
}
const realQSA = global.document.querySelectorAll;
// Captured HERE, before any helper's first call: withEdits and withDoc both
// restore these in `finally`. The originals lived next to withDoc (line ~287)
// but withDoc is first CALLED at line 138, so the `const` was still in its
// temporal dead zone - the finally threw ReferenceError and killed the whole
// suite before the turn-discovery pins ever ran.
const realQS = global.document.querySelector;
// Selector-engine constant, declared BEFORE the first withDoc fixture runs:
// matchTok's helpers are function declarations (hoisted), but this const would
// be a TDZ ReferenceError inside getEditor's try - swallowed as a silent null
// ("vote dialog" pins failing with no candidate ever collected). Same trap as
// the old stubQSA crash, one level down.
const TOK_SPLIT = /(?:[^\s\[\]]|\[[^\]]*\])+/g;
function withEdits(edits, fn) {
  global.document.querySelectorAll = (sel) => {
    if (/contenteditable|textbox|tiptap|ProseMirror/i.test(sel)) return edits;
    return [];
  };
  try { return fn(); } finally { global.document.querySelectorAll = realQSA; }
}

const pm = fakeEditable({ cls: ["ProseMirror"], attrs: { contenteditable: "plaintext-only" } });
ok("plaintext-only ProseMirror composer is found",
  withEdits([pm], () => P.getEditor() === pm));

const tb = fakeEditable({ attrs: { role: "textbox" } });
ok("role=textbox composer is found",
  withEdits([tb], () => P.getEditor() === tb));

const inVote = mkel("main", { kids: [
  mkel("div", { attrs: { role: "dialog" }, text: "Was this task successful?", kids: [
    mkel("div", { attrs: { contenteditable: "true" } }),
  ] }),
]});
withDoc(inVote, () => {
  ok("editor inside the vote dialog stays excluded", P.getEditor() === null);
  ok("miss summary names the vote-dialog rejection", /vote dialog/.test(P.describeMiss()));
});

const inPlain = mkel("main", { kids: [
  mkel("div", { attrs: { role: "dialog" }, text: "Some app panel", kids: [
    mkel("div", { attrs: { contenteditable: "true" } }),
  ] }),
]});
withDoc(inPlain, () => {
  ok("editor in a plain (non-vote) dialog is accepted", P.getEditor() !== null);
});

ok("empty DOM reports no candidates",
  P.getEditor() === null && /no editable candidates/.test(P.describeMiss()));
ok("miss names tried layers", /tried strict\+wide/.test(P.describeMiss()));

// ── Turn-discovery fixtures (agent trace DOM) ─────────────────────────────
// The "naked system prompt + ignored list_commands" failure: allItems() found
// no turns, so nothing was hidden, parsed, or run. These fixtures prove the
// layered discovery against trace-shaped DOM with a small selector engine
// (tag, .class, #id, [attr], [attr='v'], [attr*='v' i], descendant, commas).
function matchAttr(el, spec) {
  const m = spec.match(/^\s*([\w-]+)\s*(?:(\*?=)\s*(.+?))?\s*$/);
  if (!m) return false;
  // classList lives outside attrs on the stub (as on real Elements).
  const v = m[1] === "class" ? (el.classes || []).join(" ") : el.getAttribute(m[1]);
  if (m[2] == null) return v != null;
  if (v == null) return false;
  let val = m[3] || "", ci = false;
  const q = val.match(/^(['"])(.*)\1\s*(i)?$/);
  if (q) { val = q[2]; ci = !!q[3]; }
  else { const qi = val.match(/^(.*?)\s+i$/); if (qi) { val = qi[1]; ci = true; } }
  const sv = String(v);
  if (m[2] === "=") return ci ? sv.toLowerCase() === val.toLowerCase() : sv === val;
  return ci ? sv.toLowerCase().includes(val.toLowerCase()) : sv.includes(val);
}
function matchTok(el, tok) {
  const tm = tok.match(/^([a-zA-Z][\w-]*)?/);
  if (tm && tm[1] && el.tagName !== tm[1].toUpperCase()) return false;
  for (const cm of tok.match(/\.([\w-]+)/g) || []) {
    if (!el.classList.contains(cm.slice(1))) return false;
  }
  const im = tok.match(/#([\w-]+)/);
  if (im && el.getAttribute("id") !== im[1]) return false;
  for (const am of tok.match(/\[[^\]]+\]/g) || []) {
    if (!matchAttr(el, am.slice(1, -1))) return false;
  }
  return true;
}
// Token split must ignore whitespace INSIDE brackets: the ` i]` case-
// insensitive flag contains a space, and a naive /\s+/ split tore
// `[class*='artifact' i]` into `[class*='artifact'` + `i]`, whose second
// token matched tag "I" - so EVERY case-insensitive attribute selector
// silently matched nothing (SEL_TRACE missed artifacts, THOUGHT_SEL and
// CODE_CHROME_SEL never stripped, VOLATILE_SEL fast-path never fired).
// (TOK_SPLIT itself is declared before the first fixture - see above.)
function matchSel(el, sel) {
  for (const alt of sel.split(",")) {
    const toks = alt.trim().match(TOK_SPLIT) || [];
    if (!toks.length || toks[toks.length - 1] === ">") continue;
    if (!matchTok(el, toks[toks.length - 1])) continue;
    let n = el.parent, ti = toks.length - 2, found = true;
    while (ti >= 0) {
      if (toks[ti] === ">") {
        ti--;
        if (ti < 0 || !n || !matchTok(n, toks[ti])) { found = false; break; }
        n = n.parent; ti--;
      } else {
        while (n && !matchTok(n, toks[ti])) n = n.parent;
        if (!n) { found = false; break; }
        n = n.parent; ti--;
      }
    }
    if (found) return true;
  }
  return false;
}
function mkel(tag, o) {
  o = o || {};
  const el = {
    nodeType: 1, tagName: String(tag).toUpperCase(),
    attrs: o.attrs || {}, classes: o.cls || [], kids: [], parent: null,
    hidden: !!o.hidden, ownText: o.text || "",
    collapsed: !!o.collapsed, // site-collapsed turn: innerText reads "", textContent intact
    dataset: {}, style: {},
    get className() { return this.classes.join(" "); },
    getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; },
    hasAttribute(n) { return n in this.attrs; },
    get isConnected() { return !this.hidden; },
    // Real-DOM aliases: climbTurn/turnForCodeBlock walk parentElement (code +
    // marker turn anchoring) and getEditor's ProseMirror pick reads
    // classList.contains - the stub only had `parent`/`classes`, so every
    // climb returned null and the wide-net selector (.tiptap, .ProseMirror)
    // threw inside matchTok, which the outer catch turned into a silent null.
    get parentElement() { return this.parent; },
    get isContentEditable() {
      const v = this.attrs.contenteditable;
      return v != null && v !== "false";
    },
    get textContent() {
      let s = this.ownText;
      for (const k of this.kids) s += (k.nodeType === 1 ? k.textContent : (k.nodeValue || ""));
      return s;
    },
    // innerText (not textContent): an element's own text sits on its own line
    // before child content. The viewer fixture's container carries ownText
    // "12" plus a child holding the JSON - without the break reads glue to
    // `12{...}` (gutter-chrome pollution pin); with it they read `12\n{...}`.
    // Collapsed turns still read "" while textContent stays intact.
    get innerText() {
      if (this.collapsed) return "";
      let s = this.ownText;
      if (s && this.kids.length) s += "\n";
      for (const k of this.kids) s += (k.nodeType === 1 ? k.innerText : (k.nodeValue || ""));
      return s;
    },
    // DOM-faithful child list (elements + text), for marker own-text scans.
    get childNodes() {
      const out = [];
      if (this.ownText) out.push({ nodeType: 3, nodeValue: this.ownText });
      for (const k of this.kids) out.push(k);
      return out;
    },
    getClientRects() { return this.hidden ? [] : [{}]; },
    remove() { if (this.parent) {
      this.parent.kids = this.parent.kids.filter((k) => k !== this);
      this.parent = null;
    } },
    cloneNode(deep) {
      const c = mkel(this.tagName, {
        attrs: Object.assign({}, this.attrs),
        cls: this.classes.slice(),
        text: this.ownText,
        hidden: this.hidden,
      });
      if (deep) for (const k of this.kids) {
        if (k.nodeType !== 1) { c.ownText += (k.nodeValue || ""); continue; }
        const kc = k.cloneNode(true);
        kc.parent = c; c.kids.push(kc);
      }
      return c;
    },
    getBoundingClientRect() { return this.hidden
      ? { width: 0, height: 0, left: 0, right: 0, top: 0, bottom: 0 }
      : { width: 800, height: 100, left: 10, right: 810, top: 10, bottom: 110 }; },
    contains(o2) { let n = o2; while (n) { if (n === this) return true; n = n.parent; } return false; },
    compareDocumentPosition(o2) {
      const ids = []; let n = o2;
      const order = [];
      const walk = (x) => { order.push(x); for (const k of x.kids || []) if (k.nodeType === 1) walk(k); };
      return 0;
    },
    closest(sel) { let n = this; while (n) { if (matchSel(n, sel)) return n; n = n.parent; } return null; },
    querySelectorAll(sel) {
      const out = [];
      const walk = (n) => { for (const k of n.kids || []) {
        if (k.nodeType !== 1) continue;
        if (matchSel(k, sel)) out.push(k);
        walk(k);
      } };
      walk(this);
      return out;
    },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
  };
  const cls = o.cls || [];
  if (!cls.contains) cls.contains = (c) => cls.includes(c);
  el.classes = cls;
  el.classList = cls;
  (o.kids || []).forEach((k) => {
    if (typeof k === "string") { el.ownText += k; return; }
    k.parent = el; el.kids.push(k);
  });
  return el;
}
function withDoc(root, fn) {
  global.document.querySelectorAll = (sel) => (root ? root.querySelectorAll(sel) : []);
  // document.querySelector can return the tree's TOP element (real documents
  // match any element in the tree); root.querySelector only walks descendants,
  // so `document.querySelector("main")` missed a main-rooted fixture and
  // markerTurns lost its scope (body is null on the stub).
  global.document.querySelector = (sel) => {
    if (!root) return null;
    try { if (matchSel(root, sel)) return root; } catch {}
    return root.querySelector(sel);
  };
  try { return fn(); } finally {
    clockSkew += 10000; // next fixture happens later; provider caches expire
    global.document.querySelectorAll = realQSA;
    global.document.querySelector = realQS;
  }
}
const CMD_JSON = '{"command": "list_commands"}';
const diagLog = [];
P.init({ diag: (e, d) => diagLog.push([e, d]) });

// Strategy A: role-based turn holding the command block.
const roleDoc = mkel("main", { kids: [
  mkel("section", { attrs: { "data-message-author-role": "assistant" }, kids: [
    mkel("div", { cls: ["prose"], kids: [
      mkel("p", { text: "Running it now:" }),
      mkel("pre", { text: CMD_JSON }),
    ] }),
  ] }),
]});
withDoc(roleDoc, () => {
  ok("role turn discovered", P.allItems().length === 1);
  ok("counts derive from the same discovery", P.assistantCount() === 1);
  ok("command JSON read back whole", (P.readAssistant().reply || "").includes(CMD_JSON));
  ok("assistant turn not misread as user", P.isUserItem(P.allItems()[0]) === false);
  ok("strategy logged as role", diagLog.some(([e, d]) => e === "agent.items" && d.strategy === "role"));
});

// Strategy C: role-less trace div, command only reachable via code anchor.
const traceDoc = mkel("main", { kids: [
  mkel("div", { cls: ["taskstep"], kids: [
    mkel("div", { cls: ["body"], kids: [
      mkel("p", { text: "Verifying all modules against the live place:" }),
      mkel("pre", { text: CMD_JSON }),
    ] }),
  ] }),
]});
withDoc(traceDoc, () => {
  ok("code-anchored turn discovered", P.allItems().length >= 1);
  ok("code-anchored JSON read back", (P.readAssistant().reply || "").includes(CMD_JSON));
  ok("strategy logged as code", diagLog.some(([e, d]) => e === "agent.items" && d.strategy === "code"));
});

// Marker-first classification: the bootstrap sample command stays user-side
// even when the host roles the turn as assistant.
const bootDoc = mkel("main", { kids: [
  mkel("div", { cls: ["turn"], attrs: { "data-message-author-role": "assistant" },
    text: "⟦RL-SYS⟧ write " + CMD_JSON + " to start" }),
]});
withDoc(bootDoc, () => {
  const items = P.allItems();
  ok("bootstrap turn found", items.length >= 1);
  ok("bootstrap sample never parses as assistant", items.every((it) => P.isUserItem(it)));
});

// Typed-but-unsent code inside the live editor is never a command turn.
const edDoc = mkel("main", { kids: [
  mkel("div", { cls: ["ProseMirror"], attrs: { contenteditable: "true" }, kids: [
    mkel("pre", { text: CMD_JSON }),
  ] }),
]});
withDoc(edDoc, () => {
  ok("editor is found", P.getEditor() !== null);
  ok("unsent editor code is not a turn", P.allItems().length === 0);
});

// Bare command block with no surrounding prose still anchors a turn.
const bareDoc = mkel("main", { kids: [
  mkel("div", { cls: ["wrap"], kids: [
    mkel("pre", { text: CMD_JSON }),
  ] }),
]});
withDoc(bareDoc, () => {
  ok("bare command block anchors a turn", P.allItems().length === 1);
  ok("bare JSON read back", (P.readAssistant().reply || "").includes(CMD_JSON));
});

// Gutter digits inside a code viewer must not corrupt the JSON read.
const gutterDoc = mkel("main", { kids: [
  mkel("div", { cls: ["answer"], kids: [
    mkel("pre", { kids: [
      mkel("span", { cls: ["line-number"], text: "12" }),
      mkel("span", { cls: ["codeline"], text: CMD_JSON }),
    ] }),
  ] }),
]});
withDoc(gutterDoc, () => {
  const r = P.readAssistant().reply || "";
  ok("gutter digits stripped from reads", r.includes(CMD_JSON) && !/12\{/.test(r));
});

// Marker shell + live command cohabitation: the collapsed bootstrap header
// and the command turn must coexist on opposite sides (user proof + runnable
// assistant), never merged into one user turn that silences execution.
const cohabDoc = mkel("main", { kids: [
  mkel("div", { cls: ["thread"], kids: [
    mkel("button", { cls: ["collapser"], text: "⟦RL-SYS⟧ bootstrap context for this Roblox session" }),
    mkel("div", { cls: ["cmd"], kids: [ mkel("pre", { text: CMD_JSON }) ] }),
  ] }),
]});
withDoc(cohabDoc, () => {
  const items = P.allItems();
  const users = items.filter((it) => P.isUserItem(it));
  const assists = items.filter((it) => !P.isUserItem(it));
  ok("marker button and command turn coexist",
    users.length >= 1 && assists.length >= 1);
  ok("command side stays executable",
    assists.some((it) => (it.textContent || "").includes(CMD_JSON)));
  ok("cohabitation logged as marker", diagLog.some(([e, d]) => e === "agent.items" && d.strategy === "marker"));
});

// Prompt-sample bootstrap (placeholder tells, never live names) stays
// user-side even with a fenced code block inside.
const sampleDoc = mkel("main", { kids: [
  mkel("div", { cls: ["boot"], text: "⟦RL-SYS⟧ read this first: ", kids: [
    mkel("pre", { text: '{"command": "command_name", "params": {}}' }),
  ] }),
]});
withDoc(sampleDoc, () => {
  const items = P.allItems();
  ok("sample bootstrap found", items.length >= 1);
  ok("sample bootstrap stays user-side", items.every((it) => P.isUserItem(it)));
});

// Collapsed bootstrap header: marker lives in textContent while innerText is
// empty - the same-chat proof must still find it.
const collapsedDoc = mkel("main", { kids: [
  mkel("div", { cls: ["turn"], collapsed: true,
    attrs: { "data-message-author-role": "assistant" },
    text: "⟦RL-SYS⟧ write " + CMD_JSON + " to start" }),
]});
withDoc(collapsedDoc, () => {
  const items = P.allItems();
  ok("collapsed marker turn found", items.length >= 1);
  ok("collapsed marker still classifies user-side",
    items.every((it) => P.isUserItem(it)));
});

// Strategy D: flat trace - bare text turns (no roles/classes/code). Short
// static chrome (greeting) stays excluded; fresh or long prose qualifies.
const flatDoc = mkel("main", { kids: [
  mkel("div", { cls: ["greet"], text: "What would you like to do?" }),
  mkel("div", { cls: ["reply"], text: "Done. The Part is now anchored in Workspace and its Color is set, verified against the live place tree." }),
]});
withDoc(flatDoc, () => {
  const items = P.allItems();
  ok("flat prose turn discovered, greeting excluded",
    items.length === 1 && (items[0].textContent || "").includes("Done."));
  ok("strategy logged as flat", diagLog.some(([e, d]) => e === "agent.items" && d.strategy === "flat"));
});

// Shadow DOM: code block one level under an open shadow root still anchors.
const shadowPre = mkel("pre", { text: CMD_JSON });
const shadowHost = mkel("div", { cls: ["host"] });
const shadowRootFake = {
  host: shadowHost,
  parentElement: null,
  get textContent() {
    let s = "";
    for (const k of [shadowPre]) s += k.textContent;
    return s;
  },
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => { for (const k of n.kids || []) {
      if (k.nodeType !== 1) continue;
      if (matchSel(k, sel)) out.push(k);
      walk(k);
    } };
    walk({ kids: [shadowPre] });
    return out;
  },
};
shadowPre.parent = shadowRootFake;
shadowHost.shadowRoot = shadowRootFake;
const shadowDoc = mkel("main", { kids: [shadowHost] });
withDoc(shadowDoc, () => {
  ok("shadow code block anchors a turn", P.allItems().length >= 1);
  ok("shadow JSON read back", (P.readAssistant().reply || "").includes(CMD_JSON));
});

// Inline code words ("use `list_commands`") must not become phantom turns.
const inlineDoc = mkel("main", { kids: [
  mkel("div", { cls: ["note"], kids: [
    mkel("p", { text: "Use list_commands first please" }),
    mkel("code", { text: "list_commands" }),
  ] }),
]});
withDoc(inlineDoc, () => {
  ok("inline code words anchor no turns", P.allItems().length === 0);
});

// Line-based viewer (Monaco pattern): container text is polluted ("12" line
// chrome), but joining the view lines yields parseable JSON.
const viewerDoc = mkel("main", { kids: [
  mkel("div", { cls: ["artifact"], kids: [
    mkel("div", { cls: ["viewer"], text: "12", kids: [
      mkel("div", { cls: ["view-lines"], kids: [
        mkel("div", { cls: ["view-line"], text: "{" }),
        mkel("div", { cls: ["view-line"], text: '"command": "list_commands"' }),
        mkel("div", { cls: ["view-line"], text: "}" }),
      ] }),
    ] }),
  ] }),
]});
withDoc(viewerDoc, () => {
  const turn = P.allItems()[0];
  ok("viewer turn discovered", !!turn);
  ok("view lines join with newlines",
    P.viewLinesText(turn) === '{\n"command": "list_commands"\n}');
  const r = P.readAssistant().reply || "";
  ok("polluted container read recovers via lines",
    r.includes(CMD_JSON) && !/12\{/.test(r));
});

// A/B comparison: twin candidates under an A/B header collapse to ONE turn
// reading candidate A only (concatenating both trips multi-command).
const abDoc = mkel("main", { kids: [
  mkel("div", { cls: ["ab"], text: "A:1221 >>> B:1179 Δ=42", kids: [
    mkel("div", { attrs: { "data-candidate": "a" }, kids: [
      mkel("pre", { text: CMD_JSON }),
    ] }),
    mkel("div", { attrs: { "data-candidate": "b" }, kids: [
      mkel("pre", { text: CMD_JSON }),
    ] }),
  ] }),
]});
withDoc(abDoc, () => {
  ok("comparison collapses to one turn", P.allItems().length === 1);
  const r = P.readAssistant().reply || "";
  ok("only candidate A is read", r.includes(CMD_JSON) &&
    (r.match(/"command"/g) || []).length === 1);
  ok("settled comparison proceeds", P.replyUnsettled(P.allItems()[0]) === false);
});

// Streaming comparison: candidate A still partial -> bounded hold, not a verdict.
const abLiveDoc = mkel("main", { kids: [
  mkel("div", { cls: ["ab"], text: "A:1221 >>> B:1179 comparing candidate outputs", kids: [
    mkel("div", { attrs: { "data-candidate": "a" }, kids: [
      mkel("pre", { text: '{"command": "list_com' }),
    ] }),
  ] }),
]});
withDoc(abLiveDoc, () => {
  ok("streaming comparison holds verdict", P.replyUnsettled(P.allItems()[0]) === true);
});

// Thought block quoting a command must not parse or flap: stripped from reads.
const thinkDoc = mkel("main", { kids: [
  mkel("div", { cls: ["answer"], kids: [
    mkel("div", { cls: ["thought"], text: "Thought for 4 seconds wondering about " + CMD_JSON }),
    mkel("pre", { text: CMD_JSON }),
  ] }),
]});
withDoc(thinkDoc, () => {
  const r = P.readAssistant().reply || "";
  ok("reasoning quotes excluded from reads", !/Thought for/.test(r) && r.includes(CMD_JSON));
});
ok("thinking hook exported for core probes", /thought/.test(P.thinkingSel || ""));

// Adoption contract (core/main.js static pins): an orphaned runnable command
// in a marked conversation offers one-click recovery instead of a dead end.
const mainSrc2 = fs.readFileSync(__dirname + "/core/main.js", "utf8");
ok("orphan adoption offered", /Adopt this chat/.test(mainSrc2) && /kind === "adopt"/.test(mainSrc2));
{
  const ai = mainSrc2.indexOf("function adoptChat");
  const seg = ai >= 0 ? mainSrc2.slice(ai, ai + 1500) : "";
  ok("adoption re-verifies at click", /findAdoptable\(\)/.test(seg));
  ok("adoption binds session + live intent", /A\.started = true/.test(seg) && /A\.lastGenAt = Date\.now\(\)/.test(seg));
  ok("adoption leaves the leak-guard baseline alone", !/bootBaselineId\s*=/.test(seg));
  const fi = mainSrc2.indexOf("function findAdoptable");
  const fseg = fi >= 0 ? mainSrc2.slice(fi, fi + 1500) : "";
  ok("adoption requires the bootstrap marker", /SYS_MARKER/.test(fseg));
}

// Build beacon: screenshots must prove which code runs (ends stale-build
// ambiguity). Stamped on <html>, the brand tooltip, and failure banners.
ok("build beacon declared", /const RL_BUILD = "agent-9"/.test(mainSrc2));
ok("beacon stamped on page", /dataset\.rlBuild = RL_BUILD/.test(mainSrc2));
ok("beacon in failure banners", /\[build \$\{RL_BUILD\}\]/.test(mainSrc2));

// Refusal codes: a missing Adopt offer names its gate (R1..R6) on the bar.
for (const code of ["R1-no-turns", "R2-no-signature", "R3-unparseable",
                    "R4-no-proof", "R5-has-result", "R6-halted"]) {
  ok("refusal code present: " + code, mainSrc2.includes(code));
}
ok("refusal shown on bar", /A\._adoptWhy/.test(mainSrc2));

// Sweep fault isolation: one hostile turn must not abort later turns.
ok("sweep classifies per-turn isolated", /sweep\.itemErr/.test(mainSrc2));

// Adopt-first voting order surfaced when the gate is open.
ok("adoption names vote order at open gates", /adopt this chat first, then vote/.test(mainSrc2));

// Merge-leftover guard: a duplicated top-level const (twice now: `let sites`,
// `const VOLATILE_SEL`) is a parse-time SyntaxError that kills the whole route
// with zero UI. Pin the known case plus the loader banner that makes any
// future instance loud instead of a ghost.
ok("VOLATILE_SEL declared exactly once",
  (agentSrc.match(/const VOLATILE_SEL =/g) || []).length === 1);
ok("core fails loud on a dead provider",
  /typeof RLProvider === "undefined"/.test(mainSrc2) && /provider failed to load/.test(mainSrc2));
ok("documented aliases are canonicalized before dispatch",
  /search_assets:\s*"search_asset"/.test(mainSrc2) && /canonicalToolName/.test(mainSrc2));
