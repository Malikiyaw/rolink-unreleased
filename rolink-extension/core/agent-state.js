// SPDX-License-Identifier: GPL-3.0-or-later
// core/agent-state.js - Formal Agent FSM (replaces scattered booleans)

(function(){
  "use strict";
  const AgentState = {
    IDLE: "IDLE",
    STARTING: "STARTING",
    WAITING_FOR_AI: "WAITING_FOR_AI",
    AI_GENERATING: "AI_GENERATING",
    TOOL_DETECTED: "TOOL_DETECTED",
    EXECUTING_TOOL: "EXECUTING_TOOL",
    FEEDING_RESULT: "FEEDING_RESULT",
    WAITING_FOR_RESUME: "WAITING_FOR_RESUME",
    FINISHED: "FINISHED",
    ERROR: "ERROR",
    STOPPED: "STOPPED"
  };

  const VALID = {
    IDLE: ["STARTING"],
    STARTING: ["WAITING_FOR_AI","ERROR","STOPPED","IDLE"],
    WAITING_FOR_AI: ["AI_GENERATING","TOOL_DETECTED","FINISHED","ERROR","STOPPED"],
    AI_GENERATING: ["TOOL_DETECTED","WAITING_FOR_AI","FINISHED","ERROR","STOPPED"],
    TOOL_DETECTED: ["EXECUTING_TOOL","ERROR","STOPPED"],
    EXECUTING_TOOL: ["FEEDING_RESULT","ERROR","STOPPED"],
    FEEDING_RESULT: ["WAITING_FOR_RESUME","WAITING_FOR_AI","ERROR","STOPPED"],
    WAITING_FOR_RESUME: ["WAITING_FOR_AI","AI_GENERATING","ERROR","STOPPED"],
    FINISHED: ["IDLE","STARTING","STOPPED"],
    ERROR: ["IDLE","STARTING","STOPPED","WAITING_FOR_AI"],
    STOPPED: ["IDLE","STARTING"]
  };

  class AgentFSM {
    constructor({diag, trace}){
      this.state = AgentState.IDLE;
      this.prev = null;
      this.history = [];
      this.diag = diag || (()=>{});
      this.trace = trace || null;
      this.enteredAt = Date.now();
    }
    canTransition(to){
      const allowed = VALID[this.state] || [];
      return allowed.includes(to) || this.state === to;
    }
    transition(to, reason){
      const from = this.state;
      // allow forced transitions for ERROR/STOPPED
      if(!this.canTransition(to) && to !== AgentState.ERROR && to !== AgentState.STOPPED){
        // still allow but warn
        this.diag("fsm.invalid_transition", { from, to, reason });
        if(this.trace) this.trace.push({ ts: Date.now(), level:"warn", msg:`FSM ${from} → ${to} (forced) ${reason||""}` });
      }
      this.prev = from;
      this.state = to;
      this.enteredAt = Date.now();
      this.history.push({ t: Date.now(), from, to, reason });
      if(this.history.length > 200) this.history.shift();
      this.diag("fsm.transition", { from, to, reason });
      if(this.trace) this.trace.push({ ts: Date.now(), level:"info", msg:`${from} → ${to}${reason?" ("+reason+")":""}` });
    }
    is(...states){ return states.includes(this.state); }
    reset(){ this.transition(AgentState.IDLE, "reset"); }
  }

  if(typeof window !== "undefined"){
    window.AgentState = AgentState;
    window.AgentFSM = AgentFSM;
  }
  if(typeof module !== "undefined" && module.exports) module.exports = { AgentState, AgentFSM };
})();
