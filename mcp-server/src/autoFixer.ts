// autoFixer.ts – S36 Self-Healing 2.0 (extends S1)
import { healCode, shouldAutoHeal } from "./selfHeal.js";
export { healCode, shouldAutoHeal };
export function autoFix(code: string, error: string){
  const r = healCode(code, error);
  return { ...r, autoFixed: !!r.healed, stage:"S36" };
}
