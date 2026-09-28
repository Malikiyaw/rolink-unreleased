/**
 * S2 Rollback — history stack per project, undo to waypoint
 */
export interface HistoryEntry {
  id: string;
  projectId: string;
  timestamp: number;
  tool: string;
  command: string;
  snapshotBefore?: string;
  snapshotAfter?: string;
  undone?: boolean;
}

class RollbackManager {
  private stack: HistoryEntry[] = [];
  private maxSize = 200;

  push(e: HistoryEntry) {
    this.stack.push(e);
    if (this.stack.length > this.maxSize) this.stack.shift();
  }

  list(projectId: string, limit = 20): HistoryEntry[] {
    return this.stack.filter(s => s.projectId === projectId).slice(-limit).reverse();
  }

  getLast(projectId: string): HistoryEntry | undefined {
    for (let i = this.stack.length - 1; i >= 0; i--) if (this.stack[i].projectId === projectId) return this.stack[i];
    return undefined;
  }

  markUndone(id: string) {
    const e = this.stack.find(x => x.id === id);
    if (e) e.undone = true;
    return e;
  }

  // rollback N steps -> returns commands to enqueue for undo
  rollback(projectId: string, steps = 1): HistoryEntry[] {
    const entries = this.list(projectId, steps).filter(e => !e.undone);
    for (const e of entries) e.undone = true;
    return entries;
  }

  size() { return this.stack.length; }
}

export const rollbackManager = new RollbackManager();
