/**
 * S17 Automatic Git Commit & Documentation — uses local git CLI if available, else logs-only
 */
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
const pExec = promisify(execFile);

function repoRoot(): string {
  // mcp-server is at <root>/mcp-server, so go one up
  return path.resolve(process.cwd());
}

export interface CommitResult {
  committed: boolean;
  hash?: string;
  message: string;
  diffPreview?: string;
  error?: string;
}

export async function autoCommit(opts: { message: string; files?: string[]; projectId?: string }): Promise<CommitResult> {
  const msg = opts.message || "RoLink auto-commit";
  try {
    // stage
    if (opts.files && opts.files.length) {
      await pExec("git", ["add", ...opts.files], { cwd: repoRoot() });
    } else {
      // best-effort add studio related
      await pExec("git", ["add", "-A"], { cwd: repoRoot() }).catch(()=>{});
    }
    const { stdout: diff } = await pExec("git", ["diff", "--cached", "--stat"], { cwd: repoRoot() }).catch(()=>({stdout:""}) as any);
    const hasStaged = diff.trim().length > 0;
    if (!hasStaged) return { committed: false, message: msg, diffPreview: "no changes", error: "nothing to commit" };
    await pExec("git", ["commit", "-m", msg], { cwd: repoRoot() });
    const { stdout: hash } = await pExec("git", ["rev-parse", "HEAD"], { cwd: repoRoot() });
    // also append to CHANGELOG
    const changelog = path.join(repoRoot(), "CHANGELOG.md");
    const entry = `\n## ${new Date().toISOString().slice(0,10)} — ${msg}\n- hash ${hash.trim().slice(0,7)}\n`;
    try { fs.appendFileSync(changelog, entry); } catch {}
    return { committed: true, hash: hash.trim(), message: msg, diffPreview: diff.slice(0,2000) };
  } catch (e:any) {
    return { committed: false, message: msg, error: e.message?.slice(0,2000) || String(e) };
  }
}

export async function gitLog(limit=10) {
  try {
    const { stdout } = await pExec("git", ["log", `--pretty=%h %ad %s`, "--date=short", `-n`, String(limit)], { cwd: repoRoot() });
    return stdout;
  } catch (e:any){ return `git log failed: ${e.message}`; }
}
