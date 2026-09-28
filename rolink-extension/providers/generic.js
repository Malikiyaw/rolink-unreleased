// SPDX-License-Identifier: GPL-3.0-or-later
// providers/generic.js - base RLProvider for any AI chat site.
//
// This file defines a SINGLE factory function `makeGenericProvider(opts)` that
// builds a complete RLProvider instance. Per-site providers (gemini, kimi, glm,
// qwen, arena, meta) call this factory with their own id, displayName and any
// selector overrides.
//
// Selectors are tuned for the most common cases. A site-specific provider can
// pass its own selectors in `opts` to override.
window.makeGenericProvider = function(opts){
  "use strict";
  opts = opts || {};
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let diag = () => {};
  const SELF = opts.id || "generic";
  const DISPLAY = opts.displayName || SELF;
  const SUPPORTS_VISION = opts.supportsVision !== false;

  // ── selectors (overridable) ──────────────────────────────────────────────
  const S = Object.assign({
    chatItem: "[data-message-author-role], [data-testid*='conversation-turn'], article, .message, [class*='message' i][class*='turn' i], main p",
    editor: "textarea, [contenteditable='true']",
    sendBtn: "button[data-testid*='send' i], button[aria-label*='Send' i], button[aria-label*='Submit' i], form button[type='submit']",
  }, opts.selectors || {});

  const timings = Object.assign({
    GEN_IDLE_MS: 1000, REASON_IDLE_MS: 15000, WARMUP_MS: 30000,
    REASON_NOREPLY_MS: 60000, STABLE_MS: 7000, RESPONSE_TIMEOUT_MS: 300000,
  }, opts.timings || {});

  // ── core DOM accessors ──────────────────────────────────────────────────
  // Hidden-tab safe: innerText needs layout ("" when backgrounded), so every
  // text read falls back to textContent. Visible behavior unchanged.
  const visibleText = (el) => (el ? ((el.innerText || el.textContent) || "") : "");
  // Sites whose turns need multi-strategy discovery (Agent Mode trace DOM) may
  // pass opts.allItems. Everything downstream (assistantItems, counts,
  // chatIsEmpty, itemKey) derives from this closure, so an override stays
  // consistent by construction. Providers without one keep the default below.
  const allItems = opts.allItems || (() => [...document.querySelectorAll(S.chatItem)].filter(it => {
    return it && visibleText(it).length > 5 && (it.querySelector("p, div") || it.tagName === "ARTICLE" || it.tagName === "DIV");
  }));
  const isUser = opts.isUser || function(it){
    return it && (it.getAttribute && (
      it.getAttribute("data-message-author-role") === "user" ||
      it.getAttribute("data-author") === "user" ||
      /user|human/i.test(it.className || "")
    ));
  };
  const isAssistant = (it) => it && !isUser(it);
  const assistantItems = () => allItems().filter(isAssistant);
  const assistantCount = () => assistantItems().length;
  const userCount = () => allItems().filter(isUser).length;
  const lastAssistant = () => { const a = assistantItems(); return a.length ? a[a.length-1] : null; };

  const getEditor = opts.getEditor || function(){
    const list = [...document.querySelectorAll(S.editor)].filter(e => !e.closest("#rl-root"));
    // offsetParent is null for hidden/backgrounded editors — fall back to any
    // connected editor so background-run mode keeps working.
    return list.find(e => e.offsetParent !== null) || list.find(e => e.isConnected) || null;
  };
  const editorText = () => { const e = getEditor(); return e ? (e.value != null ? e.value : e.textContent || "") : ""; };
  const chatIsEmpty = () => allItems().length === 0;
  const itemKey = opts.itemKey || function(it){
    if(!it) return null;
    const id = it.getAttribute("data-message-id") || it.getAttribute("data-id") || it.getAttribute("data-turn-id") || it.id;
    if(id) return SELF+":"+id;
    const i = assistantItems().indexOf(it);
    return i >= 0 ? SELF+":idx:"+i : null;
  };
  const lastAssistantId = () => itemKey(lastAssistant());
  const itemIdByIndex = (i) => { const a = assistantItems(); return a[i] ? itemKey(a[i]) : null; };
  const composerFrame = () => {
    const t = getEditor(); if(!t) return null;
    let n = t;
    for(let i = 0; i < 14 && n.parentElement; i++){
      const btn = document.querySelector(S.sendBtn);
      if(!btn || n.contains(btn)) return n;
      n = n.parentElement;
    }
    let f = t; for(let i = 0; i < 6; i++) f = f.parentElement || f;
    return f;
  };
  const barMount = () => {
    const t = getEditor(); if(!t) return null;
    let b = t.parentElement;
    while(b && b !== document.body){
      if(b.contains(document.querySelector(S.sendBtn))) break;
      b = b.parentElement;
    }
    if(!b || b === document.body) b = t.parentElement;
    if(!b) return null;
    let before = b.firstElementChild;
    if(before && before.id === "rl-bar") before = before.nextElementSibling;
    return {parent: b, before, inside: true};
  };
  function setInputLock(on){
    const ed = getEditor(); if(!ed) return;
    if(on){
      if(!ed.dataset.rlPlaceholder) ed.dataset.rlPlaceholder = ed.getAttribute("placeholder") || "";
      ed.setAttribute("readonly","");
      ed.setAttribute("placeholder","RoLink agent working, please wait...");
    } else {
      ed.removeAttribute("readonly");
      if(ed.dataset.rlPlaceholder != null) ed.setAttribute("placeholder", ed.dataset.rlPlaceholder);
    }
  }
  const streamLen = (it) => { const i = it || lastAssistant(); return i ? visibleText(i).length : 0; };
  const snapshot = () => { const it = lastAssistant(); return it ? {th:0, rp: visibleText(it).length} : {th:0, rp:0}; };

  // ── generation detection ────────────────────────────────────────────────
  function isStopBtn(btn){
    if(!btn) return false;
    if(btn.querySelector("rect")) return true;
    const p = btn.querySelector("path");
    return p ? /^\s*M\s*[0-3][\s.]/.test(p.getAttribute("d")||"") : false;
  }
  let _streamMax = -1, _streamAt = 0, _streamItem = null;
  function sampleStream(){
    const it = lastAssistant();
    if(!it){ _streamItem = null; _streamMax = -1; return; }
    const len = streamLen(it);
    const now = Date.now();
    if(it !== _streamItem || len < _streamMax - 400){ _streamItem = it; _streamMax = len; _streamAt = now; return; }
    if(len > _streamMax){ _streamMax = len; _streamAt = now; }
  }
  function isGenerating(){
    const btn = document.querySelector(S.sendBtn);
    if(isStopBtn(btn)) return true;
    // Site hook (e.g. Arena Agent Mode busy markers): a per-site provider may
    // pass isGeneratingExtra to report generation states the generic stop-btn
    // + stream sampling cannot see (aria-busy plan steps, progress bars).
    try{ if(typeof opts.isGeneratingExtra === "function" && opts.isGeneratingExtra()) return true; }catch{}
    sampleStream();
    return _streamMax > 1 && Date.now() - _streamAt < 1200;
  }
  function isBusyNow(){ return isGenerating(); }
  function isHardGenerating(){ return isStopBtn(document.querySelector(S.sendBtn)); }
  function genDebug(){ return {gen: isGenerating()}; }

  // ── continue / scan ─────────────────────────────────────────────────────
  function findContinueBtn(){
    for(const b of document.querySelectorAll("button")){
      if(b.offsetParent === null && !b.isConnected) continue;
      if(/^(continue|continuar|continu)/i.test(visibleText(b).trim())) return b;
    }
    return null;
  }
  function clickContinueBtn(){
    const b = findContinueBtn();
    if(b){ try{ b.click(); return true; }catch{} }
    return false;
  }
  function readAssistant(){
    const i = lastAssistant();
    let reply = i ? (opts.readText ? opts.readText(i) : visibleText(i)) : "";
    // Volatile-chrome strip: thought timers / progress nodes tick inside the
    // observed reply and defeat waitForReply's text-stability gate. When the
    // site provides volatileSel, read the clone with those nodes removed.
    // Falls back to the raw text when stripping yields nothing.
    try{
      const s = i ? stripVolatile(i) : null;
      if(s != null && s.trim() !== "") reply = s;
    }catch{}
    // Clipped-fence fallback: some pages render code fences through
    // virtualized/collapsed nodes so innerText shows a placeholder while the
    // full JSON sits in the DOM. textContent sees hidden/collapsed text — if
    // the visible read has a tool signature but no COMPLETE payload while the
    // full text does, prefer the full text (stability is handled downstream
    // by payload-stability, not raw text).
    try{
      if(i && typeof RLParse !== "undefined" && RLParse.hasToolSignature && RLParse.stableBlockKey){
        if(RLParse.hasToolSignature(reply) && !RLParse.stableBlockKey(reply)){
          const ft = fullText(i);
          if(ft && ft.length > reply.length && RLParse.stableBlockKey(ft)) reply = ft;
        }
      }
    }catch{}
    return {present: !!i, reply, thinking: "", item: i};
  }
  // Remove volatile descendants (thought counters, progress bars) from a
  // CLONE so live DOM (event listeners, React state) is never touched.
  // Returns the stripped text or null when no stripping applies.
  const VOLATILE_SEL = opts.volatileSel || null;
  function stripVolatile(item){
    if(!VOLATILE_SEL || !item || !item.cloneNode || !item.querySelectorAll) return null;
    // Fast path: no volatile descendants — skip the clone+layout entirely.
    // (Clone + innerText on giant agent-trace subtrees costs seconds.)
    try{ if(!item.querySelector(VOLATILE_SEL)) return null; }catch{}
    try{
      const c = item.cloneNode(true);
      const bad = c.querySelectorAll(VOLATILE_SEL);
      for(const b of bad){ try{ b.remove(); }catch{} }
      return visibleText(c);
    }catch{ return null; }
  }
  // Raw DOM text including hidden/collapsed nodes (innerText drops those).
  function fullText(item){
    try{ return (item && item.textContent) || ""; }catch{ return ""; }
  }
  function turnHalted(){ return false; }
  function scanError(){ if(!getEditor()) return "Input box gone."; return null; }
  const isTooLongMsg = opts.isTooLongMsg || ((t) => /too long|context.{0,10}limit|maximum.{0,20}context/i.test(t));

  // ── send mechanics ──────────────────────────────────────────────────────
  function setReact(el, v){
    const p = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLDivElement.prototype;
    const s = Object.getOwnPropertyDescriptor(p, "value")?.set;
    if(s){ s.call(el, v); el.dispatchEvent(new Event("input", {bubbles:true})); el.dispatchEvent(new Event("change", {bubbles:true})); }
    else { el.value = v; el.dispatchEvent(new Event("input", {bubbles:true})); }
  }
  async function typeAndSend(text, images){
    const e = getEditor();
    if(!e) throw new Error("no input box");
    e.focus();
    setReact(e, text);
    await sleep(200);
    if(images && images.length && opts.attachImages){
      try{ await opts.attachImages(images); }catch{}
    }
    const btn = document.querySelector(S.sendBtn);
    if(btn && !isStopBtn(btn) && btn.getAttribute("aria-disabled") !== "true"){
      try{ btn.click(); }catch{}
      return;
    }
    const form = e.closest("form");
    if(form){
      try{ form.requestSubmit(); }catch{ form.dispatchEvent(new Event("submit", {bubbles:true, cancelable:true})); }
    }
  }
  function stopGeneration(){
    const b = document.querySelector(S.sendBtn);
    if(isStopBtn(b)) try{ b.click(); }catch{}
  }

  // ── image attach (default: try file input, then paste event) ────────────
  async function attachImages(images){
    if(!images || !images.length) return false;
    const editor = getEditor();
    if(!editor) return false;
    const dt = new DataTransfer();
    for(let i = 0; i < images.length; i++){
      const img = images[i];
      try{
        const mime = img.mimeType || "image/png";
        const bin = atob(img.data || "");
        const arr = new Uint8Array(bin.length);
        for(let j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j);
        const ext = mime.includes("jpeg") || mime.includes("jpg") ? "jpg" : "png";
        const file = new File([arr], `rolink_${Date.now()}_${i}.${ext}`, { type: mime });
        dt.items.add(file);
      }catch{}
    }
    if(!dt.items.length) return false;
    const fileInput = document.querySelector('input[type="file"]');
    if(fileInput){
      try{ fileInput.files = dt.files; fileInput.dispatchEvent(new Event("change", {bubbles:true})); return true; }catch{}
    }
    try{
      editor.focus();
      editor.dispatchEvent(new ClipboardEvent("paste", {clipboardData: dt, bubbles:true, cancelable:true}));
      return true;
    }catch{ return false; }
  }
  function clearAttachments(){
    try{
      document.querySelectorAll('[class*="delete" i], [class*="close" i], [class*="remove" i]')
        .forEach(d => {
          if(d.closest(S.chatItem)) return;
          ["mouseover","mousedown","mouseup","click"].forEach(t => {
            try{ d.dispatchEvent(new MouseEvent(t, {bubbles:true})); }catch{}
          });
        });
    }catch{}
  }

  // ── conversation identity / spot-finding / hooks ─────────────────────────
  const conversationKey = opts.conversationKey || (() => location.pathname);
  const enforceComposer = () => ({});
  const ensureComposerReady = opts.ensureComposerReady || (async () => ({ready: true}));
  // Default cap: identity (per-site providers like Gemini override with their
  // own composer limits). The core calls P.capResult(text) before feeding a
  // tool result back, so huge outputs never jam the composer.
  const capResult = opts.capResult || ((t) => t);
  // Default: no modal above the composer. Sites with login masks (Kimi) or
  // dialogs (Arena) override so the core can park the bar.
  const overlayBlocking = opts.overlayBlocking || (() => false);
  // Default: a turn is settled unless a site hook says otherwise. Sites with
  // out-of-DOM streams (Qwen net tap) override.
  const replyUnsettled = opts.replyUnsettled || (() => false);
  // Streaming generic-label probe: matches a {"tool":|"command": name the
  // moment its opening quote + first chars exist — BEFORE the closing quote
  // arrives. Lets the core hold a tool-shaped turn open mid-stream instead of
  // classifying it as prose (safe: gated on the canonical keys only).
  const STREAM_LABEL_RE = /"(?:command|tool)"\s*:\s*"([^"]*)/;
  const hasStreamingLabel = (t) => STREAM_LABEL_RE.test(t || "");
  const findToolBlockSpot = opts.findToolBlockSpot || function(item, chip){
    if(!item) return null;
    // Marker-aware scan: walk text nodes for a tool opener, hide its block
    // element, and anchor the chip right before it. Falls back to the first
    // paragraph container when no marker node is found (still inside the
    // message item — never document.body).
    try{
      if(item.classList) item.classList.add("rl-cmd-mask");
      var walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
      var n;
      while((n = walker.nextNode())){
        var v = n.nodeValue || "";
        var low = v.toLowerCase();
        if(low.indexOf("###mcp_tool###") === -1 && low.indexOf("###lua###") === -1 &&
           low.indexOf("###tool:") === -1 && !/"(tool|command)"\s*:\s*"/i.test(v) &&
           !hasStreamingLabel(v)) continue;
        var host = n.parentElement;
        while(host && host.parentElement && host.parentElement !== item &&
              host.tagName !== "PRE" && host.tagName !== "CODE" &&
              host.tagName !== "P" && host.tagName !== "DIV") host = host.parentElement;
        if(host && host.parentElement){
          try{ host.classList.add("rl-tool-hide"); }catch(e){}
          host.style.display = "none";
          return { parent: host.parentElement, ref: host };
        }
      }
      var md = item.querySelector("p, div");
      if(md && md.parentElement) return { parent: md.parentElement, ref: md };
      return { parent: item, ref: item.firstElementChild || null };
    }catch(e){ return null; }
  };
  // ── send-hooks (user-send interception) ──────────────────────────────────
  // Wires global keydown + click listeners so the core can be notified when:
  //   - the user typed a real message and pressed Enter / clicked Send
  //   - the user clicked the site's native Stop button
  //   - the user clicked the site's native Continue button
  // Required for the agent loop to re-arm after a session ends.
  let _hooks = null;
  let _hooksInstalled = false;
  function installSendHooks(handlers){
    _hooks = handlers || null;
    if(_hooksInstalled) return;
    _hooksInstalled = true;
    document.addEventListener("keydown", (e) => {
      if(e.key !== "Enter" || e.shiftKey || e.isComposing) return;
      const editor = getEditor();
      if(!editor || !editor.contains(e.target)) return;
      const text = editorText().trim();
      if(!text) return;
      if(_hooks.isBlocked && _hooks.isBlocked()) return;
      if(!_hooks.isStarted || !_hooks.isStarted()){
        if(chatIsEmpty() && _hooks.onBlockedAttempt) _hooks.onBlockedAttempt();
        return;
      }
      if(_hooks.onUserMessage) _hooks.onUserMessage(P ? P.assistantCount() : 0);
    }, true);
    document.addEventListener("click", (e) => {
      if(!getEditor()) return;
      const t = e.target;
      if(!t || !t.closest) return;
      // Native Continue button?
      const all = t.closest("button");
      if(all && /^(continue|continuar|continu|继续|fortfahren|seguir|続行)$/i.test((all.innerText||"").trim())){
        if(_hooks.onNativeContinue) _hooks.onNativeContinue();
        return;
      }
      const btn = t.closest(S.sendBtn);
      if(!btn) return;
      if(isStopBtn(btn)){
        if(_hooks.onNativeStop) _hooks.onNativeStop();
        return;
      }
      if(btn.getAttribute && btn.getAttribute("aria-disabled") === "true") return;
      if(_hooks.isBlocked && _hooks.isBlocked()) return;
      if(!_hooks.isStarted || !_hooks.isStarted()){
        if(chatIsEmpty() && _hooks.onBlockedAttempt) _hooks.onBlockedAttempt();
        return;
      }
      if(_hooks.onUserMessage) _hooks.onUserMessage(P ? P.assistantCount() : 0);
    }, true);
  }
  function isFreshChat(){ return chatIsEmpty(); }

  // ── the RLProvider object ────────────────────────────────────────────────
  const P = {
    id: SELF, displayName: DISPLAY,
    get supportsVision(){ return SUPPORTS_VISION; },
    // Opt-in condensed user-voiced system prompt (injection-sensitive models).
    compactPrompt: !!opts.compactPrompt,
    timings,
    init({diag:d}={}){ if(d) diag=d; },
    allItems,
    isUserItem: isUser,
    isAssistantItem: isAssistant,
    itemText: i => visibleText(i),
    classifyText: i => visibleText(i),
    assistantCount, userCount, lastAssistant, lastAssistantId, itemIdByIndex, itemKey, readAssistant,
    streamLen, snapshot,
    getEditor, editorText, chatIsEmpty, isFreshChat, composerFrame, barMount,
    setInputLock, typeAndSend, stopGeneration,
    isGenerating, isBusyNow, isHardGenerating, genDebug,
    enforceComposer, ensureComposerReady,
    turnHalted, findContinueBtn, clickContinueBtn,
    scanError, isTooLongMsg,
    attachImages, clearAttachments, conversationKey,
    installSendHooks, findToolBlockSpot,
    capResult, overlayBlocking, replyUnsettled, hasStreamingLabel,
    stripVolatile, fullText, volatileSel: VOLATILE_SEL,
  };

  // Allow per-site providers to patch the instance before exposing it.
  if(typeof opts.augment === "function"){ try{ opts.augment(P); }catch{} }
  return P;
};

// Default generic instance for callers that don't have a per-site wrapper.
window.__rolink_generic = window.makeGenericProvider({id: "generic", displayName: "Generic"});
