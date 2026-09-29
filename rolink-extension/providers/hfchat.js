// SPDX-License-Identifier: GPL-3.0-or-later
// providers/hfchat.js - HF Chat (huggingface.co/chat) provider.
//
// Hugging Face's open-source chat-ui (SvelteKit): conventional chat layout
// with a textarea composer, submit button, and a flat message list, so this
// rides the generic factory with layered discovery. Status: fresh support,
// NOT yet live-validated - every selector below has fallbacks and fails open
// (degrade to waiting, never a wrong action). A live-DOM validation pass is
// required before dropping the unstable pill (see the LIVE-DOM notes inline).
//
// Known HF Chat surface (to verify live): routes /chat (new) and /chat/<id>,
// textarea composer ("Ask anything"), model-picker dropdown up top, login
// REQUIRED (HF account), markdown code fences in replies, stop button while
// streaming. Model behavior varies per selected model: small models mangle
// the JSON protocol, so the prompt recommends a capable default WITHOUT
// force-switching (same policy as Qwen).
// eslint-disable-next-line no-unused-vars
const RLProvider = (() => {
  "use strict";

  const isShown = (e) => { try { return e.getClientRects().length > 0; } catch { return false; } };
  const inOwnUi = (e) => { try { return !!(e.closest && e.closest("#rl-root")); } catch { return false; } };

  // Why the last lookup missed (same contract as agent.js / claude.js).
  let lastMiss = "";
  // Layered: visible textarea first (chat-ui has exactly one), then any
  // connected textarea, then rich-text / textbox fallbacks (plaintext-only,
  // ProseMirror/Tiptap/Lexical reskins).
  function getEditor() {
    try {
      const counts = { hidden: 0, ownUi: 0, detached: 0, total: 0 };
      const cands = [];
      const push = (list) => { try { for (const e of list) { counts.total++; cands.push(e); } } catch {} };
      push([...document.querySelectorAll("textarea")].filter((e) => !inOwnUi(e)));
      push([...document.querySelectorAll('[contenteditable], [role="textbox"], .ProseMirror, .tiptap, [data-lexical-editor]')].filter((e) => {
        try {
          if (inOwnUi(e)) return false;
          const v = e.getAttribute && e.getAttribute("contenteditable");
          if (v === "false" && !(e.hasAttribute && e.hasAttribute("data-rl-locked"))) return false;
          return true;
        } catch { return false; }
      }));
      const seen = new Set();
      const vis = [];
      for (const e of cands) {
        if (!e || seen.has(e)) continue;
        seen.add(e);
        if (inOwnUi(e)) { counts.ownUi++; continue; }
        if (!e.isConnected) { counts.detached++; continue; }
        if (!isShown(e)) { counts.hidden++; continue; }
        vis.push(e);
      }
      // Prefer a real textarea composer, then any rich-text composer.
      const pick = vis.find((e) => e.tagName === "TEXTAREA") || vis.find((e) => e.isContentEditable) || vis[0] || null;
      if (!pick) {
        const parts = [];
        if (!counts.total) parts.push("no editable candidates");
        else {
          if (counts.hidden) parts.push(counts.hidden + " hidden");
          if (counts.ownUi) parts.push(counts.ownUi + " own UI");
          if (counts.detached) parts.push(counts.detached + " detached");
        }
        lastMiss = parts.length ? "seen: " + parts.join(", ") : "no editable candidates";
      } else lastMiss = "";
      return pick;
    } catch { return null; }
  }

  // LIVE-DOM NOTE: confirm the submit control shape (arrow icon button?
  // data-testid? plain submit?) and extend the layers if this misses.
  // Never matches stop/cancel controls, never matches disabled sends.
  function findSend() {
    try {
      const sels = [
        'button[type="submit"]', 'button[aria-label*="Send" i]',
        'button[data-testid*="send" i]', 'form button:not([type="button"])',
      ];
      for (const s of sels) {
        for (const b of document.querySelectorAll(s)) {
          if (inOwnUi(b)) continue;
          if (!isShown(b) || b.disabled || b.getAttribute("aria-disabled") === "true") continue;
          if (/stop|halt|cancel/i.test(b.getAttribute("aria-label") || "")) continue;
          return b;
        }
      }
      const ed = getEditor();
      const scope = (ed && ed.closest && ed.closest("form")) || document;
      for (const b of scope.querySelectorAll("button")) {
        if (inOwnUi(b) || !isShown(b) || b.disabled) continue;
        if (b.getAttribute("aria-disabled") === "true") continue;
        const t = (b.getAttribute("aria-label") || "") + " " + (b.innerText || "");
        if (/send|submit|↑|→/i.test(t) && !/stop|halt|cancel/i.test(t)) return b;
      }
    } catch {}
    return null;
  }

  // Lowest-common-ancestor composer card, with a step-out of inner flex
  // rows. LCA(editor, send) is the box holding both; on chat-ui that box is
  // the horizontal input row, NOT the card. So after the LCA we keep climbing
  // while the candidate still looks like an inner row (flex-direction:row, or
  // short + square corners) and the send control stays inside the parent.
  // Live layout reading, not class names: reskins move classes, not geometry.
  // Cached (this runs every animation frame via placeBar): the cache is only
  // trusted while connected AND still containing a live editor.
  let _card = null;
  function _cs(el, prop) {
    try {
      if (typeof getComputedStyle !== "function") return "";
      const cs = getComputedStyle(el);
      return (cs && cs[prop]) || "";
    } catch { return ""; }
  }
  function _rect(el) {
    try { return el.getBoundingClientRect() || { width: 0, height: 0 }; }
    catch { return { width: 0, height: 0 }; }
  }
  function composerCard() {
    try {
      const ed = getEditor();
      if (ed && _card && _card.isConnected) {
        try { if (_card.contains(ed)) return _card; } catch {}
        _card = null;
      }
      if (!ed) return null;
      const btn = findSend();
      let card = null;
      if (btn && btn.isConnected) {
        const chain = new Set();
        let n = ed;
        while (n) { chain.add(n); n = n.parentElement || null; }
        n = btn;
        while (n) { if (chain.has(n)) { card = n; break; } n = n.parentElement || null; }
      }
      card = card || (ed.parentElement || null);
      // Without a send button the layout is degraded anyway; don't wander.
      const budget = btn ? 4 : 1;
      for (let i = 0; i < budget && card && card !== document.body; i++) {
        const r = _rect(card);
        const dir = String(_cs(card, "flexDirection") || "").toLowerCase();
        const radius = parseFloat(_cs(card, "borderRadius")) || 0;
        const isRow = dir === "row" || (r.height > 0 && r.height < 110 && radius < 12);
        if (!isRow) break;
        const up = card.parentElement;
        if (!up || up === document.body) break;
        try { if (btn && up.contains && !up.contains(btn)) break; } catch { break; }
        card = up;
      }
      if (!card || card === document.body || !card.isConnected) return null;
      if (!(_rect(card).width > 200)) return null;
      _card = card;
      return _card;
    } catch { return null; }
  }

  const P = window.makeGenericProvider({
    id: "hfchat",
    displayName: "HF Chat",
    // Text-only until validated: chat-ui takes images only on multimodal
    // models and the picker varies per user. Flip after a live image pass.
    supportsVision: false,
    selectors: {
      chatItem: "[data-message-id], [data-testid*='message' i], [data-testid*='turn' i], main [class*='message' i], main article",
      editor: "textarea, [contenteditable='true'], [role='textbox']",
    },
    timings: {
      GEN_IDLE_MS: 1000, REASON_IDLE_MS: 15000, WARMUP_MS: 30000,
      REASON_NOREPLY_MS: 60000, STABLE_MS: 7000, RESPONSE_TIMEOUT_MS: 300000,
    },
    // Streaming chrome excluded from reads. LIVE-DOM: confirm the stop/
    // progress markers on a real streaming turn.
    volatileSel: '[aria-busy="true"], [role="progressbar"], [role="status"], button[aria-label*="Stop" i], [class*="streaming" i]',
    getEditor,
    isGeneratingExtra: () => {
      try {
        const b = [...document.querySelectorAll('button[aria-label*="Stop" i]')]
          .find((x) => !inOwnUi(x) && isShown(x));
        if (b) return true;
      } catch {}
      return false;
    },
    augment(P) {
      P.unstableWarning = "New provider: HF Chat support is fresh and unvalidated - please report issues on Discord.";
      // Bar placement: NEVER in-flow. chat-ui (SvelteKit) lays the composer
      // out as a horizontal flex row (textarea + buttons side by side), so the
      // generic barMount mounted #rl-bar as the row's first child and it
      // rendered as a strip on the LEFT of the input (seen live). Worse,
      // inserting nodes into Svelte-reconciled subtrees risks Kimi-style
      // breakage on re-render. Instead we expose barAnchor() returning the
      // rounded composer CARD and let the core seat a fixed bar above it
      // (padding strip reserved on the card) - the integrated look with zero
      // framework-DOM writes. P.noInflow makes the core skip computeBarMount
      // entirely (same pair as providers/agent.js).
      P.barMount = () => null;
      P.noInflow = true;
      P.barAnchor = () => composerCard();
      P.typeAndSend = async (text, images) => {
        if (images && images.length) {
          throw new Error("HF Chat image input is off until validated - describe with text instead.");
        }
        const SEND_CHUNK = 8000;
        const want = String(text);
        async function waitEditor(ms) {
          const t0 = Date.now();
          while (Date.now() - t0 < ms) {
            try { const e = getEditor(); if (e) return e; } catch {}
            try { await new Promise((r) => setTimeout(r, 150)); } catch {}
          }
          try { return getEditor(); } catch { return null; }
        }
        let ed = getEditor();
        if (!ed) ed = await waitEditor(3000);
        if (!ed) throw new Error("HF Chat input box not found (are you logged in?)" + (lastMiss ? " (" + lastMiss + ")" : ""));
        ed.focus();
        if (ed.tagName === "TEXTAREA") {
          const proto = window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype;
          const setter = proto && Object.getOwnPropertyDescriptor(proto, "value");
          if (setter && setter.set) setter.set.call(ed, want);
          else ed.value = want;
          try { ed.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: want.slice(-32) })); } catch {
            ed.dispatchEvent(new Event("input", { bubbles: true }));
          }
          const probe = ed.value != null ? ed.value : (ed.innerText || ed.textContent || "");
          if ((probe || "").length < want.length * 0.9) {
            throw new Error(`HF Chat accepted only ${(probe || "").length} of ${want.length} chars`);
          }
        } else {
          for (let at = 0; at < want.length; at += SEND_CHUNK) {
            try { document.execCommand("insertText", false, want.slice(at, at + SEND_CHUNK)); } catch {}
            try { const cur = getEditor(); if (cur && cur !== ed) ed = cur; ed.focus(); } catch {}
          }
          try { ed.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: want.slice(-32) })); } catch {
            try { ed.dispatchEvent(new Event("input", { bubbles: true })); } catch {}
          }
          const probe = ((ed.innerText || ed.textContent) || "");
          if (probe.length < want.length * 0.9) {
            try {
              ed = getEditor() || ed;
              const sel = window.getSelection();
              sel.selectAllChildren(ed);
              document.execCommand("insertText", false, want);
              ed.dispatchEvent(new Event("input", { bubbles: true }));
            } catch {}
            const probe2 = ((ed.innerText || ed.textContent) || "");
            if (probe2.length < want.length * 0.9) {
              throw new Error(`HF Chat accepted only ${probe2.length} of ${want.length} chars`);
            }
          }
        }
        const btn = findSend();
        if (btn) { try { btn.click(); } catch {} return; }
        try {
          const o = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
          ed.dispatchEvent(new KeyboardEvent("keydown", o));
          ed.dispatchEvent(new KeyboardEvent("keyup", o));
          return;
        } catch {}
        throw new Error("HF Chat send control not found");
      };
      P.setInputLock = (on) => {
        const ed = getEditor();
        if (!ed || ed.tagName !== "TEXTAREA") return;
        if (on) ed.setAttribute("readonly", "");
        else ed.removeAttribute("readonly");
      };
      // Site-specific system-prompt rules.
      P.promptExtra = [
        "HF CHAT: you need a Hugging Face login for this page - if there is no input box, tell the user to log in instead of emitting commands. Write RoLink commands as plain-text JSON in the chat. Model choice is the user's: if replies mangle the JSON format, ask them to switch to a capable model rather than shrinking the commands.",
        "HF CHAT ETIQUETTE: keep prose short and never re-read what a previous tool result already gave you; batch independent reads with batch_queue (max 10). Never type the instruction example as a command - command_name is a placeholder, not a tool; always use a REAL name from list_commands.",
      ].join("\n");
      P.describeMiss = () => lastMiss;
    },
  });

  return P;
})();
