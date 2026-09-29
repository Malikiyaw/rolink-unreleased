// SPDX-License-Identifier: GPL-3.0-or-later
// providers/agent.js - Arena Agent Mode (/agent route) provider, SUPERVISED ONLY.
//
// Agent Mode is a SEPARATE app from /text chat: a ProseMirror contenteditable
// composer (no <form>), agent-trace output (orchestrating spinners, filler
// streams, rich artifacts) and a human vote gate ("Was this task
// successful? Yes / No / Keep working"). RoLink runs here supervised: it reads
// settled artifact text and executes Studio commands from it, parks (never
// times out) while the site waits on the human, and NEVER clicks the vote
// buttons (they cast leaderboard votes). See arena.js for Direct mode.
//
// Built on the generic factory (providers/generic.js must load BEFORE this
// file in manifest.json) plus an `augment` patch for the Agent-specific
// pieces. Every selector here is layered with fallbacks and fails open: an
// unseen reskin must degrade to waiting, never to a wrong action. A live-DOM
// validation pass is still required before calling this supported (see the
// LIVE-DOM notes inline).
// eslint-disable-next-line no-unused-vars
const RLProvider = (() => {
  "use strict";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const VOTE_RE = /was this task successful|keep working/i;
  const ORCH_RE = /orchestrat/i;

  // ── Live agent-state flags (MutationObserver-maintained) ───────────────────
  // isGeneratingExtra()/voteGateActive() run on hot paths (every watcher tick
  // and every bar sweep), so they read cached flags, not the DOM. The observer
  // refreshes them from mutations; a bounded rescan corrects drift.
  let seenOrchestrating = false, orchSeenAt = 0;
  let seenVoteGate = false, voteGateSeenAt = 0;
  let dirty = true, lastRescan = 0;
  // Recently-added nodes (bounded, 120s memory): separates fresh short replies
  // from static page chrome (greetings) in strategy D below.
  let freshNodes = [];
  function noteFresh(n) {
    try {
      freshNodes.push({ n, at: Date.now() });
      if (freshNodes.length > 200) freshNodes.splice(0, freshNodes.length - 200);
    } catch {}
  }
  function isFresh(n) {
    try {
      const now = Date.now();
      for (let i = freshNodes.length - 1; i >= 0; i--) {
        if (now - freshNodes[i].at > 120000) break;
        if (freshNodes[i].n === n) return true;
      }
    } catch {}
    return false;
  }
  // Open shadow roots, rescanned at most every 5s: turn containers and code
  // blocks can live one level under shadow DOM, which document queries never
  // pierce. Bounded (40 roots) so sweeps stay cheap.
  let shadowScopesCache = [], shadowScopesAt = 0;
  function shadowScopes() {
    try {
      const now = Date.now();
      if (now - shadowScopesAt < 5000) return shadowScopesCache;
      shadowScopesCache = [];
      const els = document.querySelectorAll("*");
      for (let i = 0; i < els.length && shadowScopesCache.length < 40 && i < 2000; i++) {
        let sr = null;
        try { sr = els[i].shadowRoot; } catch {}
        if (sr) shadowScopesCache.push(sr);
      }
      shadowScopesAt = now;
      return shadowScopesCache;
    } catch { return []; }
  }
  function queryScopes(sel) {
    let out = [];
    try { out = [...document.querySelectorAll(sel)]; } catch {}
    try {
      for (const sc of shadowScopes()) {
        try { out = out.concat([...sc.querySelectorAll(sel)]); } catch {}
      }
    } catch {}
    return out;
  }
  // Last-known composer card: agent UIs unmount/replace the input while a task
  // runs. The cached card feeds barAnchor() so the core keeps an anchored bar
  // instead of dropping to (and hiding in) the fallbacks mid-run.
  let lastCard = null, lastCardEd = null;
  function rememberCard(ed) {
    if (!ed || ed === lastCardEd) return;
    lastCardEd = ed;
    try {
      let n = ed, best = null;
      for (let i = 0; i < 10 && n && n.parentElement; i++) {
        n = n.parentElement;
        if (!n.getClientRects) continue;
        if (n.getClientRects().length && n.getBoundingClientRect().width >= 300) { best = n; break; }
      }
      lastCard = best && best.isConnected ? best : null;
    } catch { lastCard = null; }
  }
  const textOf = (n) => { try { return (n.textContent || ""); } catch { return ""; } };
  // Direct (own) text of an element, capped: status pills ("orchestrating...")
  // are short; matching whole subtrees would false-positive on artifact prose
  // that merely mentions the word and wedge the watcher indefinitely.
  function ownText(el, cap) {
    try {
      let s = "";
      for (const c of el.childNodes || []) {
        if (c.nodeType === 3) s += c.nodeValue || "";
        if (s.length >= (cap || 160)) break;
      }
      return s;
    } catch { return ""; }
  }
  // True only for live orchestration chrome (short status text or aria-busy),
  // never for settled artifact prose mentioning the word.
  function orchIn(root) {
    try {
      if (root.matches && root.matches('[aria-busy="true"]')) return true;
      if (root.querySelector && root.querySelector('[aria-busy="true"]')) return true;
      const els = root.tagName ? [root, ...root.querySelectorAll("*")] : [];
      for (const el of els.slice(0, 400)) {
        if (ORCH_RE.test(ownText(el))) return true;
      }
    } catch {}
    return false;
  }
  // True only for the actual gate UI: a dialog carrying the vote prompt, or a
  // button reading exactly "Keep working". Model prose mentioning the phrase
  // must never trip it (a stuck-true flag would hold the loop forever).
  function voteIn(root) {
    try {
      const dlgs = root.matches && root.matches('[role="dialog"], [role="alertdialog"]')
        ? [root] : [...(root.querySelectorAll ? root.querySelectorAll('[role="dialog"], [role="alertdialog"]') : [])];
      for (const d of dlgs) {
        if (!d.getClientRects().length) continue;
        if (VOTE_RE.test(textOf(d))) return true;
      }
      const btns = root.tagName === "BUTTON" ? [root] : [...(root.querySelectorAll ? root.querySelectorAll("button") : [])];
      for (const b of btns) {
        if (!/^\s*keep working\s*$/i.test(b.textContent || "")) continue;
        if (b.getClientRects().length) return true;
      }
    } catch {}
    return false;
  }
  function scanSubtree(root) {
    try {
      if (orchIn(root)) { seenOrchestrating = true; orchSeenAt = Date.now(); }
      if (voteIn(root)) { seenVoteGate = true; voteGateSeenAt = Date.now(); }
    } catch {}
  }
  function rescan() {
    // Bounded correction: exact gate UI first (cheap), then capped own-text
    // scan of the main content for orchestration markers. Early-exits.
    const vote = voteIn(document);
    let orch = false;
    try {
      if (!vote) {
        const scope = document.querySelector("main") || document.body;
        if (scope && scope.querySelectorAll) {
          const els = scope.querySelectorAll("*");
          for (let i = 0; i < els.length && i < 1200 && !orch; i++) {
            const el = els[i];
            if (el.id === "rl-root") continue;
            if (ORCH_RE.test(ownText(el))) orch = true;
          }
        }
      }
    } catch {}
    seenOrchestrating = orch; if (orch) orchSeenAt = Date.now();
    seenVoteGate = vote; if (vote) voteGateSeenAt = Date.now();
    dirty = false; lastRescan = Date.now();
  }
  function pump() {
    if (dirty || Date.now() - lastRescan > 5000) rescan();
  }
  function watchDom() {
    try {
      const mo = new MutationObserver((muts) => {
        for (const m of muts) {
          for (const n of m.addedNodes) {
            if (n.nodeType !== 1) continue;
            if (n.id === "rl-root" || (n.closest && n.closest("#rl-root"))) continue;
            noteFresh(n);
            scanSubtree(n);
          }
          for (const n of m.removedNodes) {
            if (n.nodeType !== 1) continue;
            const t = textOf(n);
            if (ORCH_RE.test(t) || VOTE_RE.test(t)) dirty = true;
          }
        }
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
    } catch {}
    setInterval(pump, 2500);
  }

  // ── Editor (ProseMirror contenteditable; no <form> on /agent) ──────────────
  const isShown = (e) => { try { return e.getClientRects().length > 0; } catch { return false; } };
  const inOwnUi = (e) => { try { return !!(e.closest && e.closest("#rl-root")); } catch { return false; } };
  // Only a vote-gate dialog disqualifies an editor: the app shell itself may
  // carry a dialog role, and excluding on role alone rejects the real composer
  // (the "input box not found" report with a visible composer on screen).
  const inVoteDialog = (e) => {
    try {
      const d = e.closest && e.closest('[role="dialog"], [role="alertdialog"]');
      if (!d) return false;
      return VOTE_RE.test(d.textContent || "");
    } catch { return false; }
  };
  // Why the last lookup missed (surfaced in the thrown error so a miss reads
  // as "seen: 2 hidden, 1 in vote dialog" instead of a bare "not found").
  let lastMiss = "";
  // Why the last SEND lookup missed (button absent vs disabled vs hidden).
  // Reported alongside lastMiss so a stuck Start names the real gate.
  let lastSendMiss = "";
  function getEditor() {
    try {
      const counts = { hidden: 0, voteDialog: 0, ownUi: 0, detached: 0, lockedOff: 0, total: 0 };
      const cands = [];
      const push = (list) => { try { for (const e of list) { counts.total++; cands.push(e); } } catch {} };
      // Strict shapes first (zero regression risk for anything already found).
      push(document.querySelectorAll('[contenteditable="true"], [contenteditable=""], textarea'));
      // Wider net for shapes the strict list misses: any contenteditable value
      // (covers plaintext-only), explicit textbox roles, editor classes.
      push(document.querySelectorAll('[contenteditable]:not([contenteditable="false"]), [role="textbox"], .tiptap, .ProseMirror'));
      const seen = new Set();
      const vis = [];
      const consider = (e) => {
        if (!e || seen.has(e)) return;
        seen.add(e);
        if (inOwnUi(e)) { counts.ownUi++; return; }
        if (!e.isConnected) { counts.detached++; return; }
        if (inVoteDialog(e)) { counts.voteDialog++; return; }
        if (e.getAttribute && e.getAttribute("contenteditable") === "false" &&
            !(e.hasAttribute && e.hasAttribute("data-rl-locked"))) { counts.lockedOff++; return; }
        if (!isShown(e)) { counts.hidden++; return; }
        vis.push(e);
      };
      for (const e of cands) consider(e);
      // Expensive piercing (frames, shadow roots) only when the cheap pass
      // found nothing visible.
      let ranDeep = false;
      if (!vis.length) {
        ranDeep = true;
        try {
          for (const f of document.querySelectorAll("iframe")) {
            try {
              const doc = f.contentDocument;
              if (doc) for (const e of doc.querySelectorAll('[contenteditable], textarea, [role="textbox"]')) consider(e);
            } catch {}
          }
        } catch {}
        try {
          for (const el of document.querySelectorAll("*")) {
            let sr = null;
            try { sr = el.shadowRoot; } catch {}
            if (!sr) continue;
            try { for (const e of sr.querySelectorAll('[contenteditable], textarea, [role="textbox"]')) consider(e); } catch {}
          }
        } catch {}
      }
      // LIVE-DOM NOTE: prefer the ProseMirror composer explicitly; fall back to
      // any visible editable. If Agent Mode ever mounts two editables (main +
      // follow-up), the VISIBLE one inside the composer region wins - verify live.
      const pick = vis.find((e) => e.isContentEditable && e.classList && e.classList.contains("ProseMirror"))
        || vis.find((e) => e.isContentEditable)
        || vis[0] || null;
      if (!pick) {
        const parts = [];
        if (!counts.total) parts.push("no editable candidates");
        else {
          if (counts.hidden) parts.push(counts.hidden + " hidden");
          if (counts.voteDialog) parts.push(counts.voteDialog + " in vote dialog");
          if (counts.lockedOff) parts.push(counts.lockedOff + " locked off");
          if (counts.ownUi) parts.push(counts.ownUi + " own UI");
          if (counts.detached) parts.push(counts.detached + " detached");
        }
        // Layer tags: which discovery passes actually ran, so a miss names the
        // search space, not just the rejections.
        lastMiss = (parts.length ? "seen: " + parts.join(", ") : "no editable candidates") +
          " (tried strict+wide" + (ranDeep ? "+deep" : "") + ")";
      } else lastMiss = "";
      if (pick) rememberCard(pick);
      return pick;
    } catch { return null; }
  }
  const editorText = () => {
    const e = getEditor();
    if (!e) return "";
    if (e.value != null && e.tagName === "TEXTAREA") return e.value;
    return (e.innerText || e.textContent || "");
  };
  const visibleTextLocal = (el) => { try { return (el ? ((el.innerText || el.textContent) || "") : ""); } catch { return ""; } };
  let diag = () => {};
  let lastStrategy = "";
  function noteStrategy(s, n) {
    if (s === lastStrategy) return;
    lastStrategy = s;
    try { diag("agent.items", { strategy: s, n }); } catch {}
  }
  // Marker of our own injected turns (config.js RL.SYS_MARKER). Marker check
  // runs before every role heuristic below - with one exception: a marker
  // shell hosting a LIVE command block is that command's turn (execution
  // wins). Samples stay user-side: prompt examples carry placeholder tells
  // ("command_name"), never live names - and any residual sample risk is
  // bounded (read-only list calls the bootstrap expects first, repeats
  // deduped by the executed map).
  const SYS_MARKER = (() => { try { return (typeof RL !== "undefined" && RL.SYS_MARKER) || "⟦RL-SYS⟧"; } catch (e) { return "⟦RL-SYS⟧"; } })();
  function cmdShapeText(s) {
    try {
      if (!s) return false;
      if (typeof RLParse !== "undefined" && RLParse.hasToolSignature) return !!RLParse.hasToolSignature(s);
      return /"(command|tool)"\s*:/.test(s);
    } catch { return false; }
  }
  const SAMPLE_RE = /command_name|placeholders/i;
  function hasLiveCommandBlock(it) {
    try {
      const blocks = it.querySelectorAll ? [...it.querySelectorAll("pre, code")] : [];
      for (const b of blocks) {
        let s = "";
        try { s = (b.textContent || ""); } catch {}
        if (s.length < 10 || SAMPLE_RE.test(s)) continue;
        if (cmdShapeText(s)) return true;
      }
    } catch {}
    return false;
  }
  function isUserItem(it) {
    try {
      if (!it) return false;
      if ((it.textContent || "").indexOf(SYS_MARKER) !== -1) {
        if (!hasLiveCommandBlock(it)) return true;
      }
      if (it.getAttribute) {
        const r = it.getAttribute("data-message-author-role") || it.getAttribute("data-author") || "";
        if (/user|human/i.test(r)) return true;
        if (/assistant|ai|agent|model|bot/i.test(r)) return false;
      }
      if (/user|human/i.test(String((it.className || "") + ""))) return true;
    } catch {}
    // Unknown on agent trace: assistant side. A misclassified user prompt ends
    // as a harmless text verdict; a misclassified assistant command would never
    // execute - so bias assistant.
    return false;
  }
  function visItem(it) {
    if (!it || inOwnUi(it) || inVoteDialog(it)) return false;
    if (visibleTextLocal(it).length <= 5) return false;
    try {
      return !!(it.querySelector("p, div, pre, code") || /^(ARTICLE|SECTION|DIV)$/.test(it.tagName || ""));
    } catch { return false; }
  }
  // Shared ancestor climb: nearest container holding a node plus context.
  // forMarker widens the net to collapsed headers (BUTTON/SUMMARY) that code
  // anchoring would never climb through.
  function climbTurn(n, edRoot, forMarker) {
    let depth = 0, fallback = null;
    while (n && depth < 12) {
      try {
        if (n === document.body || n === document.documentElement) break;
        if (inOwnUi(n) || inVoteDialog(n)) return null;
        if (edRoot && n === edRoot) return null;
        const tag = (n.tagName || "").toUpperCase();
        if (!fallback && /^(DIV|SECTION|ARTICLE|LI|PRE|BUTTON|SUMMARY|DETAILS)$/.test(tag)) fallback = n;
        const t = (n.textContent || "");
        if (/^(SECTION|ARTICLE|LI)$/.test(tag) && t.length > 20) return n;
        if (/^(DIV|DETAILS)$/.test(tag) && t.length > 60 && t.length < 6000) return n;
        if (forMarker && /^(BUTTON|SUMMARY)$/.test(tag)) return n;
      } catch {}
      try { n = n.parentElement || n.host || null; } catch { return fallback; }
      depth++;
    }
    return fallback;
  }
  // Turn owning a code block: nearest ancestor (≤10 up) that holds the block
  // plus context. Typed-but-unsent code inside the live editor is excluded so
  // it can never become a "command turn". A bare block with no surrounding
  // prose still yields its wrapper (fallback) - an uncontextualized turn beats
  // an invisible command.
  function turnForCodeBlock(code, edRoot) {
    let n = null;
    try { n = code.parentElement; } catch { return null; }
    return climbTurn(n, edRoot, false);
  }
  // Strategy E: marker-anchored turns. The bootstrap can live in a container
  // no structural selector catches (collapsed header rows, buttons, prompts
  // past strategy D's length cap). The marker is unambiguous, so it carries
  // no length cap - but the walk itself is bounded with early exit, throttled
  // while a marker turn is known.
  function markerTurns() {
    try {
      const now = Date.now();
      if (markerTurnCache && markerTurnCache.isConnected && now - markerKnownAt < 10000) {
        return [markerTurnCache];
      }
      if (now - markerScanAt < 3000) return markerTurnCache ? [markerTurnCache] : [];
      markerScanAt = now;
      const scope = document.querySelector("main") || document.body;
      if (!scope || !scope.querySelectorAll) return [];
      const els = scope.querySelectorAll("*");
      for (let i = 0; i < els.length && i < 1500; i++) {
        const el = els[i];
        if (el.id === "rl-root" || (el.closest && el.closest("#rl-root"))) continue;
        let t = "";
        try {
          for (const c of el.childNodes || []) {
            if (c.nodeType === 3) t += c.nodeValue || "";
            if (t.length > 64) break;
          }
        } catch {}
        if (t.indexOf(SYS_MARKER) === -1) continue;
        const turn = climbTurn(el, null, true);
        if (turn) {
          markerTurnCache = turn; markerKnownAt = now;
          return [turn];
        }
      }
    } catch {}
    return [];
  }
  let markerTurnCache = null, markerKnownAt = 0, markerScanAt = 0;
  const SEL_ROLE = "[data-message-author-role], article, [data-testid*='message' i]";
  const SEL_TRACE = "[class*='agent-turn' i], [class*='agent-message' i], [class*='artifact' i], main section";
  // A candidate slide of an A/B comparison is not its own turn: when it sits
  // under an ancestor carrying the A/B header, the comparison owns it and
  // strategy C anchors the container instead (candidate-A read, no dupes).
  function inComparison(n) {
    try {
      let a = n.parentElement, d = 0;
      while (a && d < 6) {
        const t = a.textContent || "";
        if (t.length < 8000 && AB_RE.test(t)) return true;
        a = a.parentElement; d++;
      }
    } catch {}
    return false;
  }
  function allItems() {
    try {
      let nodes = queryScopes(SEL_ROLE).filter(visItem);
      if (nodes.length) { noteStrategy("role", nodes.length); return nodes; }
      nodes = queryScopes(SEL_TRACE).filter(visItem).filter((n) => !inComparison(n));
      if (nodes.length) { noteStrategy("trace", nodes.length); return nodes; }
      // Strategy C: code-anchored. The command JSON lives in a viewer the
      // role selectors don't know; anchor a turn on each visible code block.
      let edRoot = null;
      try { edRoot = getEditor(); } catch {}
      const turns = [];
      const seen = new Set();
      let blocks = [];
      try { blocks = queryScopes("pre, code"); } catch {}
      for (const b of blocks) {
        try {
          if (inOwnUi(b) || inVoteDialog(b)) continue;
          if (!isShown(b)) continue;
          if (edRoot && (b === edRoot || edRoot.contains(b))) continue;
          // Skip inline code words ("use `list_commands`"): only blocks with a
          // command shape - or enough text to hold one - anchor turns, or every
          // prose code span becomes a phantom turn and poisons the counts.
          let bt = "";
          try { bt = (b.textContent || ""); } catch {}
          if (bt.length < 40) {
            let shaped = false;
            try {
              shaped = (typeof RLParse !== "undefined" && RLParse.hasToolSignature)
                ? !!RLParse.hasToolSignature(bt)
                : /###(LUA|MCP_TOOL)###|"(command|tool)"\s*:/.test(bt);
            } catch {}
            if (!shaped) continue;
          }
          const t = turnForCodeBlock(b, edRoot);
          if (t && !seen.has(t)) { seen.add(t); turns.push(t); }
        } catch {}
      }
      // Drop nested duplicates (keep outermost = most context), doc order.
      const top = turns.filter((t) => !turns.some((o) => o !== t && o.contains(t)));
      try {
        top.sort((a, b) => (a.compareDocumentPosition && b.compareDocumentPosition)
          ? (a.compareDocumentPosition(b) & 4 ? -1 : 1) : 0);
      } catch {}
      const codeTops = top;
      // Strategy D: flat trace - bare text turns with no roles, classes, or
      // code. Freshness separates new short replies from static chrome (the
      // greeting header is old, so a 40-char floor excludes it while fresh
      // nodes pass at any length); long prose passes regardless.
      const flats = [];
      try {
        const ed = getEditor();
        for (const d of queryScopes("main > div, [role='main'] > div")) {
          try {
            if (inOwnUi(d) || inVoteDialog(d)) continue;
            const t = (d.textContent || "");
            if (t.length > 6000) continue;
            if (t.length < 40 && !isFresh(d)) continue;
            if (!isShown(d)) continue;
            if (ed && (d === ed || d.contains(ed))) continue;
            // Bare prose only (the contract above: "no roles, classes, or
            // code"). A container holding a code block belongs to the code
            // strategy, shaped + length-gated there; letting flat claim it
            // too counts inline code words as phantom prose turns and
            // inflates the counts (pin: "inline code words anchor no turns").
            if (d.querySelector("pre, code")) continue;
            flats.push(d);
          } catch {}
        }
      } catch {}
      const flatTops = flats.filter((t) => !flats.some((o) => o !== t && o.contains(t)));
      // Strategy E: marker-anchored turns (bootstrap in unshaped containers).
      const marked = markerTurns();
      // Merge: proof anchors (E) always survive; a marker shell swallowing a
      // live command yields to it (execution beats nesting); code-anchored
      // turns beat flat containers (precise reads, no candidate
      // concatenation); otherwise the outermost container wins as before.
      // Set-deduped first: strategies overlap on the same node.
      const merged = [...new Set([...codeTops, ...flatTops, ...marked])];
      const eSet = new Set(marked);
      const codeSet = new Set(codeTops);
      const final = merged.filter((t) => {
        if (eSet.has(t)) return true;
        for (const o of merged) {
          if (o === t || !o.contains || !o.contains(t)) continue;
          if (eSet.has(o)) continue;
          if (codeSet.has(t) && !codeSet.has(o)) continue;
          if (codeSet.has(o) && !codeSet.has(t)) return false;
          try {
            const oM = (o.textContent || "").indexOf(SYS_MARKER) !== -1;
            if (oM && cmdShapeText(t.textContent || "")) continue;
          } catch {}
          return false;
        }
        return true;
      });
      try {
        final.sort((a, b) => (a.compareDocumentPosition && b.compareDocumentPosition)
          ? (a.compareDocumentPosition(b) & 4 ? -1 : 1) : 0);
      } catch {}
      // Dominant strategy for the diag (marker > code > flat > none).
      noteStrategy(marked.length ? "marker" : (codeTops.length ? "code" : (flatTops.length ? "flat" : "none")), final.length);
      return final;
    } catch { return []; }
  }

  // ── Send control (layered; never by position) ──────────────────────────────
  function findSend() {
    try {
      const sels = [
        'button[aria-label*="Send" i]', 'button[aria-label*="Submit" i]',
        'button[data-testid*="send" i]', 'button[type="submit"]',
      ];
      let seenTotal = 0, seenHidden = 0, seenDisabled = 0, seenVote = 0;
      for (const s of sels) {
        for (const b of document.querySelectorAll(s)) {
          seenTotal++;
          if (inOwnUi(b) || inVoteDialog(b)) { seenVote++; continue; }
          if (!isShown(b)) { seenHidden++; continue; }
          if (b.disabled) { seenDisabled++; continue; }
          if (b.getAttribute("aria-disabled") === "true") { seenDisabled++; continue; }
          lastSendMiss = "";
          return b;
        }
      }
      // Last resort: a visible icon-button hugging the composer (arrow glyph).
      // Matched by glyph + composer proximity, never bare position.
      const ed = getEditor();
      const scope = (ed && ed.parentElement && ed.parentElement.parentElement) || document;
      for (const b of scope.querySelectorAll("button")) {
        if (inOwnUi(b) || inVoteDialog(b) || !isShown(b)) continue;
        if (b.disabled || b.getAttribute("aria-disabled") === "true") { seenDisabled++; continue; }
        const t = (b.getAttribute("aria-label") || "") + " " + (b.innerText || "");
        if (/send|submit|↑|→/i.test(t) && !/stop|halt/i.test(t)) { lastSendMiss = ""; return b; }
      }
      // Nothing usable: name the gate so a stuck Start reads honestly.
      const parts = [];
      if (!seenTotal) parts.push("no send candidates");
      else {
        if (seenDisabled) parts.push(seenDisabled + " disabled");
        if (seenHidden) parts.push(seenHidden + " hidden");
        if (seenVote) parts.push(seenVote + " own/vote UI");
      }
      lastSendMiss = parts.length ? "send: " + parts.join(", ") : "no send control";
    } catch {}
    return null;
  }

  // ── Provider definition (generic factory + Agent augment) ──────────────────
  // Agent-trace comparison header ("A:1221 >>> B:1179 Δ=42"): twin candidates
  // may carry the SAME command, so reads must come from candidate A only -
  // concatenating both trips the multi-command guard on one intent.
  const AB_RE = /A:\s*\d+\s*>>>?\s*B:\s*\d+|Δ\s*=\s*\d+/;
  // Thought containers ("Thought for N seconds"): reasoning quotes must never
  // parse as commands or flap chips (DeepSeek thinkingSel precedent). Shared
  // by the volatile strip (reads) and thinkingSel (core probes).
  const THOUGHT_SEL = '[data-thought], [class*="thought" i], [class*="reasoning" i]';
  // Code-viewer chrome: line-number gutters and copy buttons whose text leaks
  // into reads and corrupts JSON ("12{..."). Stripped from reads only, never
  // from the live DOM (clone). Kept specific: a wrapper carrying code must
  // never match, or the strip would eat the command it protects.
  const CODE_CHROME_SEL = '[class*="line-number" i], [class*="line-numbers" i], [class*="gutter" i], [class*="copy-code" i], [class*="copy-button" i]';
  const VOLATILE_SEL = '[aria-busy="true"], [role="progressbar"], [role="status"], ' + THOUGHT_SEL + ', ' + CODE_CHROME_SEL;
  function candidateBlocks(item) {
    try { return [...item.querySelectorAll("[data-candidate], [class*='candidate' i]")]; } catch { return []; }
  }
  // Deliberately NOT exported as P.isComparisonTurn: the core's comparison
  // branch holds the verdict open until resolveComparison() collapses the UI,
  // and there is nothing safe to click here (agent votes are leaderboard
  // decisions). Reading candidate A directly settles normally instead.
  function isComparisonTurn(item) {
    try {
      if (!item || inOwnUi(item)) return false;
      if (AB_RE.test(item.textContent || "")) return true;
      return candidateBlocks(item).length >= 2;
    } catch { return false; }
  }
  function firstCandidate(item) {
    try {
      const c = candidateBlocks(item);
      if (c.length) return c[0];
    } catch {}
    return null;
  }
  function readText(item) {
    try {
      if (isComparisonTurn(item)) {
        const a = firstCandidate(item);
        if (a) {
          const t = visibleTextLocal(a);
          if (t && t.trim()) return codeClean(item, t);
        }
      }
    } catch {}
    return codeClean(item, withShadowText(item, visibleTextLocal(item)));
  }
  // Shadow content is invisible to light-DOM text reads (correct DOM
  // behavior, fatal for turns hosted under shadow roots). If the light read
  // is empty but open shadow subtrees hold text, use theirs.
  function withShadowText(item, t) {
    try {
      if (t && t.trim()) return t;
      let s = "";
      const grab = (root) => { try { s += "\n" + (root.textContent || ""); } catch {} };
      try { if (item.shadowRoot) grab(item.shadowRoot); } catch {}
      try {
        const els = item.querySelectorAll ? item.querySelectorAll("*") : [];
        for (const el of els) {
          let sr = null;
          try { sr = el.shadowRoot; } catch {}
          if (sr) grab(sr);
        }
      } catch {}
      if (s.trim()) return s;
    } catch {}
    return t;
  }
  // Code blocks including one shadow level (querySelectorAll never pierces).
  function codeBlocks(item) {
    let out = [];
    try { out = [...item.querySelectorAll("pre, code")]; } catch {}
    try {
      const els = item.querySelectorAll ? item.querySelectorAll("*") : [];
      for (const el of els) {
        let sr = null;
        try { sr = el.shadowRoot; } catch {}
        if (sr) { try { out = out.concat([...sr.querySelectorAll("pre, code")]); } catch {} }
      }
      if (item.shadowRoot) { try { out = out.concat([...item.shadowRoot.querySelectorAll("pre, code")]); } catch {} }
    } catch {}
    return out;
  }
  // Gutter/highlighter chrome can corrupt JSON reads ("12{..."): if the full
  // read looks command-shaped but won't parse, retry with code-element text
  // only (siblings like labels fall away, the payload stays).
  // Monaco-style viewers render one element per line and can expose partial
  // text at the container level. Join the line spans directly as another retry
  // source (Qwen precedent: rendered text truncates, line spans don't). Only
  // ever returned when it parses - otherwise ignored.
  function viewLinesText(item) {
    try {
      const lines = [...item.querySelectorAll(".view-lines [class*='view-line' i], .view-lines > div")];
      if (!lines.length) return null;
      return lines.map((l) => { try { return (l.textContent || ""); } catch { return ""; } }).join("\n");
    } catch { return null; }
  }
  function codeClean(item, t) {
    try {
      if (typeof RLParse === "undefined" || !RLParse.hasToolSignature || !RLParse.parseToolCalls) return t;
      if (!RLParse.hasToolSignature(t) || RLParse.parseToolCalls(t).length) return t;
      let blocks = [];
      try { blocks = codeBlocks(item); } catch {}
      const parts = [];
      for (const b of blocks) {
        let s = "";
        try { s = (b.textContent || ""); } catch {}
        if (s && (s.length > 40 || /"(command|tool)"\s*:/.test(s))) parts.push(s);
      }
      if (parts.length) {
        const c = parts.join("\n");
        if (RLParse.parseToolCalls(c).length) return c;
      }
      const v = viewLinesText(item);
      if (v && RLParse.parseToolCalls(v).length) return v;
    } catch {}
    return t;
  }
  const P = window.makeGenericProvider({
    id: "agent",
    displayName: "Arena Agent",
    // Conservative: the image-upload path on /agent is unverified, so
    // screen_capture stays blocked with a clear reason until validated live.
    supportsVision: false,
    selectors: {
      chatItem: "[data-message-author-role], article, [data-testid*='message' i], [class*='agent-turn' i], main section",
      editor: '[contenteditable="true"], [contenteditable=""], textarea',
    },
    timings: {
      GEN_IDLE_MS: 1500,
      REASON_IDLE_MS: 20000,
      // Orchestration can run minutes before the first token lands.
      WARMUP_MS: 120000,
      REASON_NOREPLY_MS: 120000,
      STABLE_MS: 12000,
      // Inactivity-based; orchestration + vote holds refresh it, so long agent
      // tasks survive while a truly dead page still ends.
      RESPONSE_TIMEOUT_MS: 600000,
    },
    // Strip live progress chrome from reads so ticking spinners don't defeat
    // the text-stability gate (plus thought containers, same mechanism).
    volatileSel: VOLATILE_SEL,
    // Settled artifact text (candidate-A-only inside comparisons).
    readText,
    // Custom editor accessor (used by the factory internals AND the core):
    // ProseMirror-aware, dialog-excluding. Must go via opts (not augment) so
    // installSendHooks and barMount see the same editor the core does.
    // (The factory builds editorText from getEditor itself; the local
    // editorText below is only this file's readback helper for typeAndSend.)
    getEditor,
    // Multi-strategy turn discovery + marker-first user classification (must
    // go via opts so counts, chatIsEmpty and itemKey stay consistent).
    allItems, isUser: isUserItem,
    // The generic stop-btn + stream sampling cannot see the orchestration
    // phase (static "orchestrating..." text, no growth). Report it here so the
    // watcher waits instead of finalizing an empty turn.
    isGeneratingExtra: () => {
      pump();
      if (seenOrchestrating && Date.now() - orchSeenAt < 20000) return true;
      try {
        const b = document.querySelector('[aria-busy="true"]');
        if (b && b.getClientRects().length) return true;
      } catch {}
      return false;
    },
    augment(P) {
      P.unstableWarning = "Work in progress (supervised): Agent Mode is not fully working yet - use Direct mode for now. RoLink reads settled output and pauses at human prompts - it never votes for you.";
      // Reasoning-area hook for the core's raw-command probes (DeepSeek
      // precedent): a command quoted inside thinking must not read as a still-
      // visible raw block (chip rebuild spam + done/run flapping).
      P.thinkingSel = THOUGHT_SEL;
      // Bounded hold only: settled comparisons proceed immediately; anything
      // earlier is still streaming (the core caps the hold at
      // UNSETTLED_GRACE_MS, so an odd comparison delays but never wedges).
      P.replyUnsettled = (item) => {
        try {
          if (!isComparisonTurn(item)) return false;
          const a = firstCandidate(item);
          const t = a ? visibleTextLocal(a) : "";
          if (/"command"\s*:\s*"[^"]+"\s*\}/.test(t)) return false;
          if (/###(LUA|MCP_TOOL)###[\s\S]*###END/.test(t)) return false;
          return true;
        } catch { return false; }
      };
      // NEVER in-flow on /agent: the host destroys/replaces the composer
      // subtree when a task starts, taking any in-flow bar with it (the
      // "click Start and the bar vanishes" report). Nulling barMount forces
      // the core onto barAnchor + fallbacks, where the bar lives in our own
      // #rl-root and no site teardown can touch it. P.noInflow makes the core
      // skip the in-flow branch outright (belt and braces).
      P.barMount = () => null;
      P.noInflow = true;
      // Cached-card anchor: survives composer swaps that would otherwise drop
      // the bar to the fallbacks mid-run. The core validates + clears padding.
      P.barAnchor = () => (lastCard && lastCard.isConnected ? lastCard : null);
      // Diagnostic: why the last getEditor() missed ("seen: 2 hidden, ...").
      // Surfaced in the thrown send error; pinned by test-agent.js.
      P.describeMiss = () => [lastMiss, lastSendMiss].filter(Boolean).join(" | ");
      // Test seam: Monaco-style line joining (pinned by test-agent.js).
      P.viewLinesText = (item) => viewLinesText(item);
      // Vote gate: the site waits on the HUMAN, not the model. The core parks
      // every deadline while held (no timeout) and shows "Waiting on you".
      // Fail-open: unknown DOM still allows progress; a stale flag only ever
      // extends a wait, and the live check below bounds it.
      let liveCacheAt = 0, liveCacheVal = false;
      function liveVoteGate() {
        const now = Date.now();
        if (now - liveCacheAt < 1500) return liveCacheVal;
        // Same exact-UI rule as voteIn (shared helper): dialog prompt or an
        // exact "Keep working" button. Never substring-match page prose.
        const hit = voteIn(document);
        liveCacheAt = now; liveCacheVal = hit;
        return hit;
      }
      P.voteGateActive = () => {
        if (liveVoteGate()) { seenVoteGate = true; voteGateSeenAt = Date.now(); return true; }
        // Trust the observer flag briefly to bridge removal races.
        if (seenVoteGate && Date.now() - voteGateSeenAt < 8000) return true;
        seenVoteGate = false;
        return false;
      };
      // ProseMirror has no .value: type via chunked execCommand inserts with
      // readback verification (one giant insert can fail silently), restore
      // the input lock afterwards (the lock flips contenteditable off, which
      // would block our own insert).
      const SEND_CHUNK = 8000;
      async function waitEditor(ms) {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) {
          const e = getEditor();
          if (e) return e;
          await sleep(150);
        }
        return getEditor();
      }
      P.typeAndSend = async (text, images) => {
        let ed = getEditor();
        if (!ed) {
          // Composer may be mid-remount (task-start transition): wait for it
          // to come back before failing the whole bootstrap on a transient.
          try { diag("agent.send.waitEditor", {}); } catch {}
          ed = await waitEditor(3000);
        }
        if (!ed) {
          try { diag("agent.send.noEditor", { miss: (lastMiss || "").slice(0, 120) }); } catch {}
          throw new Error("Arena Agent input box not found" + (lastMiss ? " (" + lastMiss + ")" : ""));
        }
        const isTa = ed.tagName === "TEXTAREA";
        const wasLocked = !isTa && ed.getAttribute("contenteditable") !== "true";
        try {
          ed.focus();
          if (wasLocked) ed.setAttribute("contenteditable", "true");
          const want = String(text);
          // Chunked insert: execCommand with a ~100k system prompt can silently
          // take nothing; sequential chunk inserts preserve order (cursor ends
          // each chunk) and each chunk is small enough to land reliably.
          for (let at = 0; at < want.length; at += SEND_CHUNK) {
            const piece = want.slice(at, at + SEND_CHUNK);
            try { document.execCommand("insertText", false, piece); } catch {}
            ed = getEditor() || ed; // survive a mid-inject remount
            try { ed.focus(); } catch {}
          }
          try { ed.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: want.slice(-32) })); } catch {
            try { ed.dispatchEvent(new Event("input", { bubbles: true })); } catch {}
          }
          const probe = (editorText() || "");
          try { diag("agent.send.probe", { got: probe.length, want: want.length }); } catch {}
          if (probe.length < want.length * 0.9) {
            // Second attempt: select-all + single insert (clears placeholder state).
            try {
              ed = getEditor() || ed;
              const sel = window.getSelection();
              sel.selectAllChildren(ed);
              document.execCommand("insertText", false, want);
              ed.dispatchEvent(new Event("input", { bubbles: true }));
            } catch {}
            const probe2 = (editorText() || "");
            if (probe2.length < want.length * 0.9) {
              throw new Error(`Arena Agent accepted only ${probe2.length} of ${want.length} chars`);
            }
          }
          if (images && images.length && P.attachImages) {
            try { await P.attachImages(images); } catch {}
          }
          const btn = findSend();
          if (btn) { try { diag("agent.send.click", {}); } catch {} try { btn.click(); } catch {} return; }
          // Last resort: many agent composers submit on Cmd/Ctrl+Enter.
          try { diag("agent.send.keyFallback", { miss: (lastSendMiss || "").slice(0, 120) }); } catch {}
          try {
            const o = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true, ctrlKey: true, metaKey: true };
            ed.dispatchEvent(new KeyboardEvent("keydown", o));
            ed.dispatchEvent(new KeyboardEvent("keyup", o));
            return;
          } catch {}
          throw new Error("Arena Agent send control not found" + (lastSendMiss ? " (" + lastSendMiss + ")" : ""));
        } finally {
          if (wasLocked) {
            try { ed.setAttribute("contenteditable", "false"); } catch {}
          }
        }
      };
      // contenteditable ignores readonly: flip the attribute itself (ChatGPT
      // precedent). The typing mask + input cover still apply on top.
      P.setInputLock = (on) => {
        const ed = getEditor();
        if (!ed || ed.tagName === "TEXTAREA") {
          if (ed && on) ed.setAttribute("readonly", "");
          if (ed && !on) ed.removeAttribute("readonly");
          return;
        }
        if (on) {
          if (!ed.dataset.rlPlaceholder) ed.dataset.rlPlaceholder = ed.getAttribute("placeholder") || "";
          ed.setAttribute("contenteditable", "false");
          ed.setAttribute("data-rl-locked", "1");
        } else {
          ed.setAttribute("contenteditable", "true");
          ed.removeAttribute("data-rl-locked");
          if (ed.dataset.rlPlaceholder != null) ed.setAttribute("placeholder", ed.dataset.rlPlaceholder);
        }
      };
      // Site-specific system-prompt rules: supervised-only contract.
      P.promptExtra = [
        "ARENA AGENT MODE (supervised): this page runs an autonomous site agent with its own sandbox tools. For anything involving the user's Roblox Studio project, still write RoLink commands as plain-text JSON - the site's tools cannot reach Studio. Emit command blocks VERBATIM (never rephrase or summarize them); the extension executes them locally.",
        "After emitting a Studio command, write one short line and STOP - do not continue site-side work that buries the command turn under new artifacts (a buried command can't be adopted and run).",
        "When the page shows a human decision prompt (e.g. task-success vote buttons), STOP writing commands and wait in plain text - the user clicks, not you. Never ask to click it twice.",
        "DEEP THINK FIRST (good practice): think in your own reasoning area before acting - state a 1-2 line plan, verify the target with one read (get_instances / get_script_content) before any edit, then do one command per reply and wait for its result.",
      ].join("\n");
    },
  });

  // Start DOM watching (flags back isGeneratingExtra/voteGateActive) and wire
  // the diag channel for strategy logging.
  try {
    const prevInit = P.init.bind(P);
    P.init = (opts) => { if (opts && opts.diag) diag = opts.diag; prevInit(opts); watchDom(); dirty = true; rescan(); };
  } catch {}

  return P;
})();
