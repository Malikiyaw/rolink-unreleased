/**
 * S14 Collaborative Multi-User Sessions — broadcast via bridge WS + HTTP polling fallback
 * Keeps session registry in-memory, session = projectId namespace with multiple clients
 */
export interface CollabClient { clientId: string; projectId: string; joinedAt: number; lastSeen: number; role: "extension"|"plugin"|"ai"; cursor?: string; }
export interface CollabBroadcast { from: string; projectId: string; event: string; data: unknown; ts: number; }

class CollabManager {
  private clients=new Map<string, CollabClient>();
  private history: CollabBroadcast[]=[];
  private maxHist=200;

  join(projectId:string, clientId:string, role: CollabClient["role"]): CollabClient {
    const c: CollabClient={ clientId, projectId, joinedAt:Date.now(), lastSeen:Date.now(), role };
    this.clients.set(clientId, c);
    this.broadcast(projectId, "user_joined", { clientId, role }, "system");
    return c;
  }
  heartbeat(clientId:string){ const c=this.clients.get(clientId); if(c) c.lastSeen=Date.now(); }
  leave(clientId:string){ const c=this.clients.get(clientId); if(c){ this.clients.delete(clientId); this.broadcast(c.projectId,"user_left",{clientId},"system"); } }
  list(projectId:string){ return [...this.clients.values()].filter(c=>c.projectId===projectId); }
  cleanup(timeoutMs=60000){ const now=Date.now(); for(const [k,v] of this.clients) if(now-v.lastSeen>timeoutMs){ this.clients.delete(k); this.broadcast(v.projectId,"timeout",{clientId:k},"system"); } }

  broadcast(projectId:string, event:string, data:unknown, from="system"): CollabBroadcast {
    const b: CollabBroadcast={ from, projectId, event, data, ts:Date.now() };
    this.history.push(b); if(this.history.length>this.maxHist) this.history.shift();
    return b;
  }
  recent(projectId:string, limit=20){ return this.history.filter(h=>h.projectId===projectId).slice(-limit).reverse(); }
  count(projectId?:string){ if(!projectId) return this.clients.size; return this.list(projectId).length; }
}

export const collabManager = new CollabManager();
setInterval(()=> collabManager.cleanup(), 30000).unref?.();
