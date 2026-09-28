// S43 learning mode placeholder
let learnMode = false;
export function toggle_learning_mode(enabled?: boolean) {
  if (typeof enabled === "boolean") learnMode = enabled;
  else learnMode = !learnMode;
  return { learnMode };
}
export function isLearningMode() { return learnMode; }
