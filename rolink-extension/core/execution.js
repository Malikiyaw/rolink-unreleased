// SPDX-License-Identifier: GPL-3.0-or-later
// core/execution.js - ToolExecutionManager (canonical executor)
// Single component allowed to execute AI tool calls. One place to debug.

(function(){
  "use strict";

  const STATUS = {
    QUEUED: "queued",
    RUNNING: "running",
    SUCCESS: "success",
    ERROR: "error",
    TIMEOUT: "timeout",
    CANCELLED: "cancelled",
    STALE: "stale"
  };

  const TIMEOUTS = {
    EXTENSION_TO_BRIDGE_MS: 130000,
    BRIDGE_TO_MCP_MS: 120000,
    EXECUTE_LUAU_MS: 20000,
    DEFAULT_MS: 60000
  };

  function makeId(){
    return `rl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,9)}`;
  }

  function isContextInvalidated(msg){
    return /Extension context invalidated|message port closed|Receiving end does not exist/i.test(msg||"");
  }

  function normalizeError(res){
    if(!res) return { kind:"unknown", error:"no response from bridge", text:"" };
    if(res.ok) return { kind:"success", error:"", text: res.text||"" };
    const kind = res.kind || "execution_error";
    let error = res.error || res.text || "unknown execution error";
    // Map known bridge kinds to AI-readable hints
    if(/unknown tool/i.test(error)){
      error += " — check the valid tool list and use exact name.";
    }
    if(kind === "timeout"){
      error = `ERROR calling tool: Roblox Studio did not return a result within the timeout.\nPossible causes: Studio not ready / MCP disconnected / Luau blocked or waiting.\nRaw: ${error}\nRetry with a smaller command or inspect Studio state.`;
    }
    if(kind === "studio_offline"){
      error = `Roblox Studio MCP is offline. Open Roblox Studio → Assistant Settings → MCP Servers → toggle 'Enable Studio as MCP server' OFF then ON, wait 10s, retry. Raw: ${error}`;
    }
    if(kind === "mcp_offline"){
      error = `Bridge is online but MCP server is offline. Restart bridge with start.bat and ensure Studio MCP is enabled. Raw: ${error}`;
    }
    if(kind === "bridge_offline"){
      error = `Bridge offline — run start.bat (or MacOS_Start.command). Raw: ${error}`;
    }
    return { kind, error, text: res.text||"" };
  }

  class ExecutionRequest {
    constructor({id, tool, args, sessionId, turnId, timeout}){
      this.id = id;
      this.tool = tool;
      this.arguments = args || {};
      this.sessionId = sessionId || null;
      this.turnId = turnId || null;
      this.timeout = timeout || TIMEOUTS.DEFAULT_MS;
      this.startedAt = Date.now();
      this.status = STATUS.QUEUED;
      this.result = null;
      this.error = null;
      this.kind = null;
    }
  }

  class ToolExecutionManager {
    constructor({bg, diag, trace, state}){
      this.bg = bg; // function(msg) => Promise
      this.diag = diag || (()=>{});
      this.trace = trace || null;
      this.state = state || null;
      this.active = null;
      this.queue = [];
      this.cancelledIds = new Set();
    }

    validate(tool, args){
      if(!tool || typeof tool !== "string") return { ok:false, error:"tool name is required" };
      if(tool.length > 120) return { ok:false, error:"tool name too long" };
      if(args != null && typeof args !== "object") return { ok:false, error:"arguments must be an object" };
      return { ok:true };
    }

    async execute(call, opts){
      opts = opts || {};
      const tool = call.name || call.tool;
      const args = call.arguments || call.args || {};
      const v = this.validate(tool, args);
      if(!v.ok){
        return { id: makeId(), ok:false, kind:"validation_error", error:v.error, text:"" };
      }
      const id = (call && typeof call.id === "string" && call.id) ? call.id : makeId();
      const sessionId = opts.sessionId || null;
      const turnId = opts.turnId || null;
      let timeout = opts.timeout || TIMEOUTS.DEFAULT_MS;
      if(tool === "execute_luau" && timeout > TIMEOUTS.EXECUTE_LUAU_MS * 4) timeout = TIMEOUTS.EXECUTE_LUAU_MS;
      // allow caller to request longer for long luau
      if(call.timeout) timeout = call.timeout;

      const req = new ExecutionRequest({id, tool, args, sessionId, turnId, timeout});
      req.status = STATUS.RUNNING;
      this.active = req;
      this.diag("execution.start", { id, tool, sessionId, turnId, timeout });
      // P0 ToolEvent spine: lifecycle publish (never blocks the loop).
      const __bus = (typeof window !== "undefined" && (window.RolinkToolEvents || window.ToolEventBus)) || null;
      const emitEv = (status, extra) => {
        try {
          if (__bus && typeof __bus.publish === "function") {
            __bus.publish(Object.assign(
              { id, tool, args, sessionId, turnId, startTime: req.startedAt, durationMs: Date.now() - req.startedAt },
              extra || {}, { status }));
          }
        } catch (e) {}
      };
      emitEv("running");
      if(this.trace) this.trace.push({ ts: Date.now(), level:"info", msg:`Request ${id} → Bridge → StudioMCP: ${tool}` });
      if(this.state) try{ this.state.transition("EXECUTING_TOOL", tool); }catch{}

      // Ensure tab is visible before sending — skipped in background-run
      // mode (bridge call_tool is tab-independent; only message sends park).
      // Defaults to parking when the flag is unset (standalone/test contexts).
      const bgRun = (typeof window !== "undefined" && window.__rolinkBgRun === true);
      if(document.hidden && !bgRun){
        if(this.trace) this.trace.push({ ts: Date.now(), level:"warn", msg:"tab hidden — pausing execution" });
        await this._waitForVisible();
        if(this.cancelledIds.has(id)){
          req.status = STATUS.CANCELLED;
          emitEv("cancelled", { result: "cancelled while tab hidden" });
          return { id, ok:false, kind:"cancelled", error:"cancelled while tab hidden", text:"" };
        }
        // check staleness after resuming
        if(sessionId && opts.getSessionId && opts.getSessionId() !== sessionId){
          req.status = STATUS.STALE;
          if(this.trace) this.trace.push({ ts: Date.now(), level:"warn", msg:`✗ stale session ${id} — dropping` });
          emitEv("stale", { result: "stale session — new chat opened" });
          return { id, ok:false, kind:"cancelled", error:"stale session — new chat opened", text:"" };
        }
      }

      let res;
      try{
        // Use background worker's correlated call_tool path
        const bgPromise = this.bg({
          type:"call_tool",
          id,
          name: tool,
          arguments: args,
          timeout,
          sessionId,
          turnId
        });
        const timeoutPromise = new Promise((_, reject)=> setTimeout(()=> reject(new Error("extension timeout")), timeout + 10000));
        res = await Promise.race([bgPromise, timeoutPromise]);
      }catch(e){
        const msg = String(e && e.message || e);
        if(isContextInvalidated(msg)){
          req.status = STATUS.ERROR;
          req.kind = "stale-extension";
          req.error = msg;
          if(this.trace) this.trace.push({ ts: Date.now(), level:"error", msg:`✗ ${tool} extension invalidated` });
          emitEv("stale", { result: msg });
          return { id, ok:false, kind:"stale-extension", error:"Extension updated — please reload this page and click Start again.", text:"" };
        }
        req.status = STATUS.TIMEOUT;
        req.kind = "timeout";
        req.error = msg;
        if(this.trace) this.trace.push({ ts: Date.now(), level:"error", msg:`✗ ${tool} timeout` });
        emitEv("timeout", { result: msg });
        return { id, ok:false, kind:"timeout", error: normalizeError({ok:false, kind:"timeout", error: msg}).error, text:"" };
      }

      if(!res){
        req.status = STATUS.ERROR;
        req.error = "no response from bridge";
        req.kind = "bridge_offline";
        if(this.trace) this.trace.push({ ts: Date.now(), level:"error", msg:`✗ ${tool} no bridge response` });
        emitEv("error", { result: "no response from bridge" });
        return { id, ok:false, kind:"bridge_offline", error: normalizeError({ok:false, kind:"bridge_offline", error:"no response"}).error, text:"" };
      }

      // Staleness check on return: if session changed while we were awaiting, don't feed
      if(sessionId && opts.getSessionId && opts.getSessionId() !== sessionId){
        req.status = STATUS.STALE;
        if(this.trace) this.trace.push({ ts: Date.now(), level:"warn", msg:`↻ ${tool} result arrived for stale session — not feeding` });
        emitEv("stale", { result: res.text || res.error || "" });
        // Still return but mark stale so caller can drop feeding
        return { id, ok: !!res.ok, kind: res.kind || (res.ok ? "success" : "execution_error"), error: res.error||"", text: res.text||"", stale:true };
      }

      if(res.ok){
        req.status = STATUS.SUCCESS;
        req.result = res.text||"";
        req.kind = "success";
        if(this.trace) this.trace.push({ ts: Date.now(), level:"ok", msg:`Studio ✓ ${tool} ${String(res.text||"done").slice(0,80)}` });
        emitEv("success", { result: res.text || "", executionId: res.executionId || id, durationMs: res.durationMs, verification: res.verification });
        // Terminal ExecutionEnvelope passthrough: the AI must read status/executionId,
        // never infer success from anything else.
        return { id: res.executionId || id, ok:true, kind:"success", error:"", text: res.text||"", images: res.images||[],
          tool, status: res.status || "success", executionId: res.executionId || id,
          durationMs: res.durationMs, verification: res.verification || { checked:false } };
      } else {
        const norm = normalizeError(res);
        req.status = norm.kind === "timeout" ? STATUS.TIMEOUT : STATUS.ERROR;
        req.kind = norm.kind;
        req.error = norm.error;
        if(this.trace) this.trace.push({ ts: Date.now(), level:"error", msg:`Studio ✗ ${tool} ${norm.kind}: ${String(norm.error).slice(0,120)}` });
        emitEv(norm.kind === "timeout" ? "timeout" : "error", { result: norm.error, executionId: res.executionId, durationMs: res.durationMs });
        return { id: res.executionId || id, ok:false, kind: norm.kind, error: norm.error, text: res.text||"",
          tool, status: res.status || "error", executionId: res.executionId,
          durationMs: res.durationMs, error_code: res.error_code, verification: res.verification || { checked:false } };
      }
    }

    _waitForVisible(){
      if(!document.hidden) return Promise.resolve();
      return new Promise(resolve=>{
        const done = ()=>{
          document.removeEventListener("visibilitychange", onVis);
          clearInterval(iv);
          resolve();
        };
        const onVis = ()=>{ if(!document.hidden) done(); };
        document.addEventListener("visibilitychange", onVis);
        const iv = setInterval(()=>{ if(!document.hidden) done(); }, 500);
      });
    }

    cancelAll(reason){
      this.cancelledIds.clear();
      if(this.active) this.cancelledIds.add(this.active.id);
      this.queue.length = 0;
      if(this.trace) this.trace.push({ ts: Date.now(), level:"warn", msg:`cancelled: ${reason||""}` });
    }
  }

  // Export
  if(typeof window !== "undefined"){
    window.ToolExecutionManager = ToolExecutionManager;
    window.ExecutionStatus = STATUS;
    window.ExecutionTimeouts = TIMEOUTS;
    window.makeExecutionId = makeId;
  }
  if(typeof module !== "undefined" && module.exports) module.exports = { ToolExecutionManager, STATUS, TIMEOUTS, makeId };
})();
