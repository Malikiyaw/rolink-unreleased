/**
 * S7 Team Log — append-only structured log for collaborative sessions
 */
export interface LogEntry {
  ts: number;
  level: "info" | "warn" | "error";
  projectId: string;
  actor: string; // extension | plugin | ai | system
  event: string;
  data?: unknown;
  id: string;
}

class TeamLog {
  private entries: LogEntry[] = [];
  private max = 1000;

  append(level: LogEntry["level"], projectId:string, actor:string, event:string, data?:unknown): LogEntry {
    const e: LogEntry = { ts: Date.now(), level, projectId, actor, event, data, id: Math.random().toString(36).slice(2,9) };
    this.entries.push(e);
    if (this.entries.length > this.max) this.entries.shift();
    console.log(`[teamLog:${level}] ${actor} :: ${event}`);
    return e;
  }
  query(opts: { projectId?: string; actor?: string; event?: string; limit?: number } = {}): LogEntry[] {
    let r = this.entries;
    if (opts.projectId) r = r.filter(e=>e.projectId===opts.projectId);
    if (opts.actor) r = r.filter(e=>e.actor===opts.actor);
    if (opts.event) r = r.filter(e=>e.event.includes(opts.event!));
    return r.slice(-(opts.limit ?? 50)).reverse();
  }
  recent(limit=50, projectId?:string){ return this.query({projectId, limit}); }
}

export const teamLog = new TeamLog();
