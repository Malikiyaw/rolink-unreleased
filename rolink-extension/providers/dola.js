// SPDX-License-Identifier: GPL-3.0-or-later
// providers/dola.js - Dola (dola.com) provider.
//
// Dola's web app is a conventional chat surface (sidebar history, "How can I
// assist you today?" landing, bottom composer card with a mode-chip row).
// This rides the generic factory with layered discovery. Status: fresh
// support, NOT yet live-validated - every selector below has fallbacks and
// fails open (degrade to waiting, never a wrong action). A live-DOM
// validation pass is required before dropping the unstable pill (see the
// LIVE-DOM notes inline).
//
// Known Dola surface (from a live screenshot, to verify in code): composer
// card with a "Message..." input row on top, chip row below (+, Fast, Create
// Videos, Create Images, Writing, Homework, Translate), send-arrow button at
// bottom-right (greyed while disabled), sidebar Recents/Pinned threads,
// light theme. Mode chips are hands-off (a media mode will not speak the
// JSON protocol). Skills/Scheduled Tasks surface means native-tool drift is
// the main model risk - pinned by prompt rules, not selectors.
// eslint-disable-next-line no-unused-vars
const RLProvider = (() => {
  "use strict";

  const isShown = (e) => { try { return e.getClientRects().length > 0; } catch { return false; } };
  const inOwnUi = (e) => { try { return !!(e.closest && e.closest("#rl-root")); } catch { return false; } };
  const isDisabled = (b) => {
    try {
      return !!(b.disabled || (b.getAttribute && b.getAttribute("aria-disabled") === "true"));
    } catch { return false; }
  };

  // Layered: visible textarea first, then any connected textarea, then
  // contenteditable/textbox fallbacks. Never the mode chips or sidebar search.
  function getEditor() {
    try {
      let list = [...document.querySelectorAll("textarea")].filter((e) => !inOwnUi(e));
      let hit = list.find((e) => e.isConnected && isShown(e));
      if (hit) return hit;
      hit = list.find((e) => e.isConnected);
      if (hit) return hit;
      hit = [...document.querySelectorAll("[contenteditable='true'], [role='textbox']")]
        .find((e) => !inOwnUi(e) && e.isConnected && isShown(e));
      if (hit) return hit;
    } catch {}
    return null;
  }

  // LIVE-DOM NOTE: confirm the send-arrow shape (aria-label? title? plain
  // icon button?) and extend the layers if this misses. Never click a
  // disabled (greyed) send - the message isn't ready; the caller waits.
  // Never click mode chips (+, Fast, Create Videos, ...) as a send fallback.
  function findSend() {
    try {
      const sels = [
        'button[aria-label*="Send" i]', 'button[title*="Send" i]',
        'button[data-testid*="send" i]', 'button[type="submit"]',
      ];
      for (const s of sels) {
        for (const b of document.querySelectorAll(s)) {
          if (inOwnUi(b) || !isShown(b) || isDisabled(b)) continue;
          return b;
        }
      }
      const ed = getEditor();
      const scope = (ed && ed.parentElement && ed.parentElement.parentElement) || document;
      for (const b of scope.querySelectorAll("button")) {
        if (inOwnUi(b) || !isShown(b) || isDisabled(b)) continue;
        const t = (b.getAttribute("aria-label") || "") + " " + (b.getAttribute("title") || "") +
          " " + (b.innerText || "");
        if (/send|submit|↑|→/i.test(t) &&
            !/stop|halt|plus|add|fast|video|image|writing|homework|translate|mic/i.test(t)) return b;
      }
    } catch {}
    return null;
  }

  // Lowest-common-ancestor composer card, stepping out of inner rows.
  // Same geometry-read shape as providers/hfchat.js (HF lesson: never mount
  // in-flow into a framework-reconciled composer). Cached; trusted only
  // while connected and still containing a live editor.
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
    id: "dola",
    displayName: "Dola",
    // No image affordance on the composer: text only until a live pass
    // proves uploads work.
    supportsVision: false,
    // Dola's ceiling is unmeasured, but its send arrow greys out on trouble
    // and a stuck "Starting..." is worse than a marked truncation: same
    // conservative budget as Pi until a live pass measures the real limit.
    capResult: (t) => {
      const s = String(t == null ? "" : t);
      const LIM = 3500;
      if (s.length <= LIM) return s;
      const head = 2500, tail = 800;
      return s.slice(0, head) +
        "\n[…Dola input budget: " + (s.length - head - tail) +
        " chars omitted - call narrower tools for the rest instead of re-reading…]\n" +
        s.slice(-tail);
    },
    selectors: {
      chatItem: "[data-message-id], [data-testid*='message' i], [data-testid*='turn' i], main article, main [class*='message' i]",
      editor: "textarea, [contenteditable='true'], [role='textbox']",
    },
    timings: {
      GEN_IDLE_MS: 1000, REASON_IDLE_MS: 15000, WARMUP_MS: 30000,
      REASON_NOREPLY_MS: 60000, STABLE_MS: 7000, RESPONSE_TIMEOUT_MS: 300000,
    },
    // Streaming + agent-activity chrome excluded from reads. LIVE-DOM:
    // confirm stop/progress/task-card markers on a real streaming turn.
    volatileSel: '[aria-busy="true"], [role="progressbar"], [role="status"], button[aria-label*="Stop" i], [class*="streaming" i], [class*="task" i]',
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
      P.unstableWarning = "Work in progress: Dola is not usable yet - use DeepSeek, ChatGPT, or another supported chat for now.";
      // Anchored bar (HF precedent): never in-flow into the composer card,
      // hug it from above via the core's anchored mode.
      P.barMount = () => null;
      P.noInflow = true;
      P.barAnchor = () => composerCard();
      P.typeAndSend = async (text, images) => {
        if (images && images.length) {
          throw new Error("Dola image input is off until validated - describe with text instead.");
        }
        const ed = getEditor();
        if (!ed) throw new Error("Dola input box not found (are you logged in?)");
        ed.focus();
        if (ed.tagName === "TEXTAREA") {
          const proto = window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype;
          const setter = proto && Object.getOwnPropertyDescriptor(proto, "value");
          if (setter && setter.set) setter.set.call(ed, text);
          else ed.value = text;
          ed.dispatchEvent(new Event("input", { bubbles: true }));
        } else {
          document.execCommand("insertText", false, String(text));
          try { ed.dispatchEvent(new Event("input", { bubbles: true })); } catch {}
        }
        // Acceptance probe (Pi lesson): a greyed send means the composer
        // didn't take the message. Fail fast so the loop banners instead of
        // burning retries + a 60s wait on a reply that will never come.
        try {
          const probe = String(ed.value != null && ed.value !== undefined
            ? ed.value : ((ed.innerText || ed.textContent) || ""));
          if (probe.length < String(text).length * 0.9) {
            throw new Error(`Dola accepted only ${probe.length} of ${String(text).length} chars`);
          }
        } catch (e) {
          if (/accepted only/.test(e && e.message || "")) throw e;
        }
        // The send arrow greys out until the message is ready: wait for it
        // instead of clicking a dead button (or worse, a mode chip).
        let btn = findSend();
        for (let i = 0; i < 20 && !btn; i++) {
          await new Promise((r) => setTimeout(r, 250));
          btn = findSend();
        }
        if (btn) { try { btn.click(); } catch {} return; }
        try {
          const o = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
          ed.dispatchEvent(new KeyboardEvent("keydown", o));
          ed.dispatchEvent(new KeyboardEvent("keyup", o));
          return;
        } catch {}
        throw new Error("Dola send control not found");
      };
      P.setInputLock = (on) => {
        const ed = getEditor();
        if (!ed || ed.tagName !== "TEXTAREA") return;
        if (on) ed.setAttribute("readonly", "");
        else ed.removeAttribute("readonly");
      };
      // Site-specific system-prompt rules.
      P.promptExtra = [
        "DOLA: if there is no input box on this page, tell the user to log in instead of emitting commands. Write RoLink commands as plain-text JSON in the chat. Use ONLY exact tool names and params from the list_commands result - never Dola-native skills, scheduled tasks, or invented params. Mode chips (Fast, Create Videos, ...) are the user's choice: leave them alone, and if replies mangle the JSON format, ask for a plain chat mode rather than shrinking commands.",
        "DOLA ETIQUETTE: keep prose short, one command per reply, then wait for its result; batch independent reads with batch_queue (max 10).",
      ].join("\n");
      P.describeMiss = () => "";
    },
  });

  return P;
})();
