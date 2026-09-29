// SPDX-License-Identifier: GPL-3.0-or-later
// core/execution-trace.js - End-to-end execution trace panel

(function(){
  "use strict";
  class ExecutionTrace {
    constructor(limit){
      this.limit = limit || 300;
      this.entries = [];
      this.listeners = [];
    }
    push(entry){
      // entry: {ts, level: info|ok|warn|error, msg}
      const e = { ts: entry.ts || Date.now(), level: entry.level || "info", msg: String(entry.msg||"") };
      this.entries.push(e);
      if(this.entries.length > this.limit) this.entries.shift();
      for(const fn of this.listeners) try{ fn(e); }catch{}
      // also console
      try{ console.debug("[rolink.trace]", e.level, e.msg); }catch{}
    }
    on(fn){ this.listeners.push(fn); }
    off(fn){ this.listeners = this.listeners.filter(f=>f!==fn); }
    toText(){
      return this.entries.map(e=>{
        const d = new Date(e.ts).toTimeString().slice(0,8);
        return `${d} [${e.level}] ${e.msg}`;
      }).join("\n");
    }
    clear(){ this.entries.length=0; }
  }

  if(typeof window !== "undefined"){
    window.ExecutionTrace = ExecutionTrace;
    window.__rolinkTrace = window.__rolinkTrace || new ExecutionTrace(300);
  }
  if(typeof module !== "undefined" && module.exports) module.exports = { ExecutionTrace };
})();
