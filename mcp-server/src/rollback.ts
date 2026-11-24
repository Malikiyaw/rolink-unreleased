/**
 * S2 Rollback — history stack per project, undo to waypoint.
 *
 * HONESTY NOTE (this module was a fabricated receipt):
 * `snapshotBefore`/`snapshotAfter` used to be declared optional and assigned by
 * NOTHING, while `rollback()` returned {rolledBack:[...]} as success. The
 * entries it returned carried no state to restore, so a caller was told an undo
 * had happened when nothing had been captured to undo. Now:
 *
 *   * `snapshotBefore` is REQUIRED - you cannot record history for a command
 *     without having captured state first;
 *   * `push()` rejects entries with no snapshot, so the bad shape cannot be
 *     constructed even by a future caller;
 *   * `rollback()` returns only entries that actually carry a snapshot, and
 *     reports `skipped` for the ones that do not, instead of silently
 *     presenting them as undone.
 */
export interface HistoryEntry {
  id: string;
  projectId: string;
  timestamp: number;
  tool: string;
  command: string;
  /** DataModel snapshot captured BEFORE the command ran. Required to roll back. */
  snapshotBefore: string;
  snapshotAfter?: string;
  undone?: boolean;
}

export interface RollbackOutcome {
  /** Entries that carry a real snapshot and were marked undone. */
  restored: HistoryEntry[];
  /** Entries that matched but had no snapshot, so could NOT be undone. */
  skipped: HistoryEntry[];
  /** True only when at least one entry was actually restored. */
  ok: boolean;
  /** Human/model-readable reason when ok is false. */
  reason?: string;
}

const MAX_SIZE = 200;

class RollbackManager {
  private stack: HistoryEntry[] = [];

  /**
   * Record a mutating command. Throws when no snapshot is supplied, because an
   * un-undoable entry that later reports "rolled back" is exactly the bug this
   * module used to have.
   */
  push(e: Omit<HistoryEntry, "snapshotBefore"> & { snapshotBefore?: string }): HistoryEntry {
    const snap = typeof e.snapshotBefore === "string" ? e.snapshotBefore : "";
    if (!snap) {
      throw new Error(
        `rollback: refusing to record ${e.tool} without a snapshotBefore - ` +
          "a history entry without captured state can never be rolled back"
      );
    }
    const entry: HistoryEntry = { ...e, snapshotBefore: snap };
    this.stack.push(entry);
    if (this.stack.length > MAX_SIZE) this.stack.shift();
    return entry;
  }

  list(projectId: string, limit = 20): HistoryEntry[] {
    return this.stack
      .filter((s) => s.projectId === projectId)
      .slice(-limit)
      .reverse();
  }

  getLast(projectId: string): HistoryEntry | undefined {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      if (this.stack[i].projectId === projectId) return this.stack[i];
    }
    return undefined;
  }

  markUndone(id: string) {
    const e = this.stack.find((x) => x.id === id);
    if (e) e.undone = true;
    return e;
  }

  /**
   * Select the N most recent not-yet-undone entries for a project and decide,
   * per entry, whether it can actually be restored.
   *
   * This is deliberately split from "doing the undo": the caller enqueues a real
   * Studio undo for `restored` and must not describe `skipped` as undone.
   */
  rollback(projectId: string, steps = 1): RollbackOutcome {
    const candidates = this.list(projectId, Math.max(1, steps)).filter((e) => !e.undone);
    if (!candidates.length) {
      return {
        restored: [],
        skipped: [],
        ok: false,
        reason: `no rollback history for project '${projectId}' - nothing was recorded to undo`,
      };
    }
    const restorable: HistoryEntry[] = [];
    const skipped: HistoryEntry[] = [];
    for (const e of candidates) {
      if (e.snapshotBefore) restorable.push(e);
      else skipped.push(e);
    }
    for (const e of restorable) e.undone = true;
    if (!restorable.length) {
      return {
        restored: [],
        skipped,
        ok: false,
        reason:
          "the recorded entries carry no snapshot, so no undo can be verified - " +
          "nothing was rolled back",
      };
    }
    return { restored: restorable, skipped, ok: true };
  }

  size() {
    return this.stack.length;
  }

  /** Test helper. */
  clear() {
    this.stack = [];
  }
}

export const rollbackManager = new RollbackManager();
