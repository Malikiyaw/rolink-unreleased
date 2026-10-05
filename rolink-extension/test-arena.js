// Quick Node smoke test for providers/arena.js editor discovery
// (run: node test-arena.js). Not shipped.
//
// Why this exists: Direct mode died with zero errors when the composer
// stopped being a `form textarea` - a single-selector lookup. getEditor() is
// now a layered chain (form textarea → textarea → contenteditable → textbox
// → frames/shadow), and these pins hold every layer plus the cached-card
// anchor fallback. Minimal stub DOM, no dependencies.
const fs = require("fs");

function mkel(tag, o) {
  o = o || {};
  const el = {
    nodeType: 1, tagName: String(tag).toUpperCase(),
    attrs: o.attrs || {}, kids: [], parent: null,
    hidden: !!o.hidden, ownText: o.text || "",
    dataset: {},
    get className() { return this.classes.join(" "); },
    getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; },
    hasAttribute(n) { return n in this.attrs; },
    setAttribute(n, v) { this.attrs[n] = String(v); },
    removeAttribute(n) { delete this.attrs[n]; },
    get isConnected() { return !this.hidden && this.alive !== false; },
    get textContent() {
      let s = this.ownText;
      for (const k of this.kids) s += (k.nodeType === 1 ? k.textContent : (k.nodeValue || ""));
      return s;
    },
    get innerText() { return this.textContent; },
    getClientRects() { return this.isConnected ? [{}] : []; },
    // Real-DOM alias: providers/arena.js walks parentElement (barAnchor's
    // rounded-card walk, rememberCard's width probe). The stub only had
    // `parent`, so every parent-walk silently terminated at the starting
    // node and all three anchor pins failed. `parent` is reassigned during
    // tree assembly, so a live getter stays correct.
    get parentElement() { return this.parent; },
    getBoundingClientRect() { return this.isConnected
      ? { width: 700, height: 120, left: 10, right: 710, top: 10, bottom: 130 }
      : { width: 0, height: 0, left: 0, right: 0, top: 0, bottom: 0 }; },
    contains(o2) { let n = o2; while (n) { if (n === this) return true; n = n.parent; } return false; },
    closest(sel) {
      if (/rl-root/.test(sel)) {
        let n = this;
        while (n) { if (n.attrs && n.attrs.id === "rl-root") return n; n = n.parent; }
        return null;
      }
      let n = this;
      while (n) {
        if (sel === "form" && n.tagName === "FORM") return n;
        n = n.parent;
      }
      return null;
    },
    querySelectorAll(sel) {
      if (sel === "textarea, [contenteditable], [role='textbox']") {
        const out = [];
        const walk = (n) => { for (const k of n.kids || []) {
          if (k.nodeType !== 1) continue;
          if (k.tagName === "TEXTAREA" || k.attrs.contenteditable != null || k.attrs.role === "textbox") out.push(k);
          walk(k);
        } };
        walk(this);
        return out;
      }
      const out = [];
      const walk = (n) => { for (const k of n.kids || []) {
        if (k.nodeType !== 1) continue;
        if (matchSimple(k, sel)) out.push(k);
        walk(k);
      } };
      walk(this);
      return out;
    },
  };
  const cls = o.cls || [];
  cls.contains = (c) => cls.includes(c);
  el.classes = cls;
  el.classList = cls;
  (o.kids || []).forEach((k) => {
    if (typeof k === "string") { el.ownText += k; return; }
    k.parent = el; el.kids.push(k);
  });
  return el;
}
// Enough selector support for the discovery chain: tag, "form textarea",
// [contenteditable], [role="textbox"], "*", "iframe".
function matchSimple(el, sel) {
  for (const alt of sel.split(",")) {
    const toks = alt.trim().split(/\s+/).filter(Boolean);
    if (!toks.length) continue;
    if (!matchTok(el, toks[toks.length - 1])) continue;
    let n = el.parent, ti = toks.length - 2, found = true;
    while (ti >= 0) {
      while (n && !matchTok(n, toks[ti])) n = n.parent;
      if (!n) { found = false; break; }
      n = n.parent; ti--;
    }
    if (found) return true;
  }
  return false;
}
function matchTok(el, tok) {
  if (tok === "*") return true;
  const tm = tok.match(/^([a-zA-Z][\w-]*)?/);
  if (tm && tm[1] && el.tagName !== tm[1].toUpperCase()) return false;
  for (const cm of tok.match(/\.([\w-]+)/g) || []) {
    if (!el.classList.contains(cm.slice(1))) return false;
  }
  for (const am of tok.match(/\[[^\]]+\]/g) || []) {
    // Value form too ([role="textbox"], [attr*="v" i]): the providers' layer
    // chains query value selectors, and the bare-name-only matcher silently
    // rejected every one of them (seen: role=textbox layer never matching).
    const spec = am.slice(1, -1);
    const bare = spec.match(/^\s*([\w-]+)\s*$/);
    if (bare) { if (el.getAttribute(bare[1]) == null) return false; continue; }
    const m = spec.match(/^\s*([\w-]+)\s*(?:(\*?=)\s*(.+?))\s*$/);
    if (!m) return false;
    const v = m[1] === "class" ? (el.classes || []).join(" ") : el.getAttribute(m[1]);
    if (v == null) return false;
    let val = m[3] || "", ci = false;
    const q = val.match(/^(['"])(.*)\1\s*(i)?$/);
    if (q) { val = q[2]; ci = !!q[3]; }
    else { const qi = val.match(/^(.*?)\s+i$/); if (qi) { val = qi[1]; ci = true; } }
    const sv = String(v);
    const hit = m[2] === "="
      ? (ci ? sv.toLowerCase() === val.toLowerCase() : sv === val)
      : (ci ? sv.toLowerCase().includes(val.toLowerCase()) : sv.includes(val));
    if (!hit) return false;
  }
  return true;
}

let docRoot = null;
global.window = { location: { pathname: "/text/direct" }, addEventListener: () => {} };
global.location = global.window.location;
global.document = {
  querySelectorAll: (sel) => (docRoot ? docRoot.querySelectorAll(sel) : []),
  querySelector: (sel) => (docRoot ? docRoot.querySelectorAll(sel)[0] || null : null),
  addEventListener: () => {},
  dispatchEvent: () => {},
  documentElement: { classList: { contains: () => false } },
  body: null,
  execCommand: () => true,
};
global.MutationObserver = class { observe() {} disconnect() {} };
global.getComputedStyle = () => ({});
global.CustomEvent = class { constructor(t) { this.type = t; } };
const P = new Function(
  fs.readFileSync(__dirname + "/providers/arena.js", "utf8") + "; return RLProvider;"
)();
const diagLog = [];
const ok = (name, cond) => { console.log((cond ? "PASS" : "FAIL") + "  " + name); if (!cond) process.exitCode = 1; };
function withDoc(root, fn) {
  docRoot = root;
  try { return fn(); } finally { docRoot = null; }
}
// init() kicks restoreDirectOnce: give it a Direct combo so it returns
// immediately instead of polling an empty page for ~15s.
const initDoc = mkel("div", { kids: [
  mkel("button", { attrs: { role: "combobox" }, text: "Direct chat with 1 model" }),
] });
withDoc(initDoc, () => { P.init({ diag: (e, d) => diagLog.push([e, d]) }); });

ok("provider id is arena", P.id === "arena");

// Layer 1 still wins when the legacy DOM exists (zero regression).
const legacyDoc = mkel("div", { kids: [
  mkel("form", { kids: [ mkel("textarea", { attrs: { placeholder: "Ask" } }) ] }),
  mkel("div", { attrs: { contenteditable: "true" }, text: "decoy" }),
] });
withDoc(legacyDoc, () => {
  const ed = P.getEditor();
  ok("form textarea preferred", !!ed && ed.tagName === "TEXTAREA");
  ok("layer logged", diagLog.some(([e, d]) => e === "arena.editor" && d.layer === "form-textarea"));
});

// Reskin: contenteditable composer, no form anywhere.
const reskinDoc = mkel("div", { kids: [
  mkel("div", { cls: ["composer-card"], kids: [
    mkel("div", { cls: ["ProseMirror"], attrs: { contenteditable: "true" }, text: "hello" }),
    mkel("button", { attrs: { "aria-label": "Send" }, text: "↑" }),
  ] }),
] });
withDoc(reskinDoc, () => {
  const ed = P.getEditor();
  ok("contenteditable composer found after reskin", !!ed && ed.attrs.contenteditable === "true");
  const card = ed && ed.parent;
  ok("anchor hugs the card", card && P.barAnchor() !== null);
});

// role=textbox fallback.
const tbDoc = mkel("div", { kids: [
  mkel("div", { attrs: { role: "textbox" }, text: "hi" }),
] });
withDoc(tbDoc, () => {
  ok("role=textbox composer found", P.getEditor() !== null);
});

// Cached card survives a composer teardown mid-run (editor subtree swapped,
// card element itself still mounted).
withDoc(reskinDoc, () => {
  const ed = P.getEditor();
  ok("anchor live while mounted", P.barAnchor() !== null);
  ed.alive = false; // only the editor goes away
  ok("editor gone after teardown", P.getEditor() === null);
  ok("cached card anchors through teardown", P.barAnchor() !== null);
  ed.alive = true;
});

// Input lock branches by element kind.
withDoc(legacyDoc, () => {
  const ed = P.getEditor();
  P.setInputLock(true);
  ok("textarea locks via readonly", ed.getAttribute("readonly") === "");
  P.setInputLock(false);
  ok("textarea unlocks", ed.getAttribute("readonly") == null);
});
withDoc(reskinDoc, () => {
  const ed = P.getEditor();
  P.setInputLock(true);
  ok("contenteditable locks via attribute flip",
    ed.getAttribute("contenteditable") === "false" && ed.getAttribute("data-rl-locked") === "1");
  P.setInputLock(false);
  ok("contenteditable unlocks", ed.getAttribute("contenteditable") === "true");
});

// Own UI is never mistaken for the composer.
const ownDoc = mkel("div", { kids: [
  mkel("div", { attrs: { id: "rl-root" }, kids: [
    mkel("textarea", { attrs: { id: "rl-set-text" } }),
  ] }),
] });
ownDoc.kids[0].attrs.id = "rl-root";
withDoc(ownDoc, () => {
  // closest("#rl-root") must fire: give the stub a matching ancestor.
  ok("own textarea ignored", P.getEditor() === null);
});
