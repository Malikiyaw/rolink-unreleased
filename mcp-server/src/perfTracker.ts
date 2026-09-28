/**
 * S3 Performance Tracking — records execution timings from plugin, aggregates stats
 */
export interface PerfEntry {
  id: string;
  tool: string;
  elapsedMs: number;
  timestamp: number;
  projectId: string;
  success: boolean;
}

class PerfTracker {
  private entries: PerfEntry[] = [];
  private max = 500;

  record(e: PerfEntry) {
    this.entries.push(e);
    if (this.entries.length > this.max) this.entries.shift();
  }

  stats(projectId?: string) {
    const filtered = projectId ? this.entries.filter(e => e.projectId === projectId) : this.entries;
    if (filtered.length === 0) return { count: 0, avgMs: 0, p95Ms: 0, slowest: null, byTool: {} };
    const sorted = [...filtered].sort((a, b) => a.elapsedMs - b.elapsedMs);
    const avg = filtered.reduce((s, x) => s + x.elapsedMs, 0) / filtered.length;
    const p95 = sorted[Math.floor(sorted.length * 0.95)].elapsedMs;
    const byTool: Record<string, { count: number; avgMs: number }> = {};
    for (const e of filtered) {
      if (!byTool[e.tool]) byTool[e.tool] = { count: 0, avgMs: 0 };
      byTool[e.tool].count++;
      byTool[e.tool].avgMs = (byTool[e.tool].avgMs * (byTool[e.tool].count - 1) + e.elapsedMs) / byTool[e.tool].count;
    }
    // round
    for (const k of Object.keys(byTool)) byTool[k].avgMs = Math.round(byTool[k].avgMs * 100) / 100;
    return {
      count: filtered.length,
      avgMs: Math.round(avg * 100) / 100,
      p95Ms: p95,
      slowest: sorted[sorted.length - 1],
      byTool,
    };
  }

  recent(limit = 20, projectId?: string) {
    const f = projectId ? this.entries.filter(e => e.projectId === projectId) : this.entries;
    return f.slice(-limit).reverse();
  }
  clear() { this.entries = []; }
}

export const perfTracker = new PerfTracker();
