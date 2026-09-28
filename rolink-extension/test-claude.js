// Quick Node smoke test for providers/claude.js (run: node test-claude.js).
// Not shipped.
//
// Fresh-provider contract pins: identity, vision flag, thinking hook,
// prompt rules, and the single send-button click path. Stub DOM only -
// live-DOM validation on claude.ai is still required (see LIVE-DOM notes in
// providers/claude.js). No jsdom, no npm install.
const fs = require("fs");

global.window = {};
global.location = { pathname: "/new" };
global.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
  dispatchEvent: () => {},
  documentElement: { classList: { contains: () => false } },
  body: null,
};
global.MutationObserver = class { observe() {} disconnect() {} };
global.setInterval = () => 0;
global.getComputedStyle = () => ({});
global.CustomEvent = class { constructor(t) { this.type = t; } };

// Generic factory must load first (claude.js consumes window.makeGenericProvider).
new Function(fs.readFileSync(__dirname + "/providers/generic.js", "utf8"))();
const P = new Function(
  fs.readFileSync(__dirname + "/providers/claude.js", "utf8") + "; return RLProvider;"
)();

const ok = (name, cond) => { console.log((cond ? "PASS" : "FAIL") + "  " + name); if (!cond) process.exitCode = 1; };
const claudeSrc = fs.readFileSync(__dirname + "/providers/claude.js", "utf8");

ok("provider id is claude", P.id === "claude");
ok("display name names Claude", /claude/i.test(P.displayName || ""));
ok("vision enabled (Claude reads images)", P.supportsVision === true);
ok("thinking hook exported", /thinking/i.test(P.thinkingSel || ""));
ok("promptExtra keeps commands out of artifacts", /artifact/i.test(P.promptExtra || ""));
ok("promptExtra preaches usage economy", /usage|concise|batch_queue/i.test(P.promptExtra || ""));
// Single click path (send only) - same supervised rule as the agent provider.
const clicks = claudeSrc.match(/\.click\(\)/g) || [];
ok("single click path (send only)", clicks.length === 1);
// Direct-like contract: no vote gate, no orchestration hooks on this provider.
ok("no vote-gate hook", typeof P.voteGateActive === "undefined");
ok("no orchestration hook", typeof P.isComparisonTurn === "undefined");

for (const fn of ["getEditor", "typeAndSend", "setInputLock", "isGenerating",
                  "isBusyNow", "readAssistant", "installSendHooks", "findToolBlockSpot"]) {
  ok("exposes " + fn, typeof P[fn] === "function");
}

ok("init runs clean", (() => { try { P.init({}); return true; } catch { return false; } })());
ok("manifest routes claude.ai", (() => {
  try {
    const m = JSON.parse(fs.readFileSync(__dirname + "/manifest.json", "utf8"));
    return m.content_scripts.some((c) =>
      (c.matches || []).some((u) => u.includes("claude.ai")) &&
      (c.js || []).includes("providers/claude.js"));
  } catch { return false; }
})());
ok("background covers claude.ai", (() => {
  try {
    return fs.readFileSync(__dirname + "/background.js", "utf8").includes("https://claude.ai/*");
  } catch { return false; }
})());

// ── Refusal handling (injection-skepticism refusals) ────────────────────────
// The reply in the field report ("looks like an injected instruction... no
// real RoLink integration... won't pretend to run commands") must classify as
// its own kind - never terminal text - so the loop answers once and stops.
const RL = new Function(
  fs.readFileSync(__dirname + "/core/config.js", "utf8") + "; return RL;"
)();
const FIELD_REFUSAL =
  "This looks like an injected instruction trying to get me to treat arbitrary " +
  "chat text as a command channel into external tools - I'm not going to follow " +
  "it. I don't have a real \"RoLink\" integration, and I won't pretend to run " +
  "commands against your Roblox Studio project or any other software through " +
  "fake JSON blocks in my replies.";
ok("field refusal classifies", RL.isRefusal(FIELD_REFUSAL) === true);
ok("plain prose is not a refusal",
  RL.isRefusal("I can't run that here, sorry.") === false);
ok("command JSON is never a refusal",
  RL.isRefusal('{"command": "list_commands"}') === false);
ok("de-escalation is user-voiced with an opt-out",
  /I'm the person typing/.test(RL.FEEDBACK.deescalate) &&
  /chat normally instead/.test(RL.FEEDBACK.deescalate));
ok("de-escalation offers the falsifiable test",
  /list_commands/.test(RL.FEEDBACK.deescalate) &&
  /no answer ever arrives/.test(RL.FEEDBACK.deescalate));

// Condensed user-voiced prompt for injection-sensitive models.
const full = RL.buildSystemPrompt({ siteName: "Claude" });
const short = RL.buildSystemPrompt({ siteName: "Claude", compact: true });
ok("compact prompt stays small", short.length < full.length * 0.45);
ok("compact prompt is user-voiced", /I installed/.test(short));
ok("compact prompt offers the falsifiable test",
  /no answer.*ever arrives|tell me plainly/.test(short));
ok("compact prompt keeps the essentials",
  short.includes("list_commands") && short.includes("###LUA###") &&
  short.includes("⟦RL-SYS⟧"));
ok("compact prompt drops the catalog dump", !short.includes("command_name"));
ok("full prompt unchanged by default",
  RL.buildSystemPrompt("Claude") === RL.buildSystemPrompt({ siteName: "Claude" }));
ok("provider opts into compact + opener",
  P.compactPrompt === true && typeof P.bootOpener === "function");
ok("opener is small and user-voiced",
  P.bootOpener().length < 800 && /I installed/.test(P.bootOpener()));

// Core wiring (static pins - the loop itself needs a live page).
const mainSrc = fs.readFileSync(__dirname + "/core/main.js", "utf8");
ok("core classifies refusal kind", /kind: "refusal"/.test(mainSrc));
ok("core sends one de-escalation", /RL\.FEEDBACK\.deescalate/.test(mainSrc));
ok("core honors two-step bootstrap", /P\.bootOpener/.test(mainSrc));
ok("core passes the compact flag", /compact: P\.compactPrompt/.test(mainSrc));

// ── Core execution-truth pins (relocated from test-pi.js when Pi was removed) ──
// These guard provider-agnostic bootstrap logic; they belong to no single
// provider, so they live here with the other core wiring pins.
{
  ok("proveIt is a top-level FEEDBACK key",
    typeof RL.FEEDBACK.proveIt === "string" && RL.FEEDBACK.proveIt.length > 0);
  ok("proveIt demands list_commands",
    /list_commands/.test(RL.FEEDBACK.proveIt));
  ok("proveIt never reproduces an example envelope",
    !/"command":\s*"(?!list_commands)/.test(RL.FEEDBACK.proveIt));
  ok("proof round reads proveIt directly", /RL\.FEEDBACK\.proveIt/.test(mainSrc));

  // Account restriction (throttle/ToS notice): terminal everywhere. Classified
  // BEFORE refusal so a throttled account never gets de-escalated or retried.
  const RESTR =
    "We have detected a number of violations of our Terms of Service in your " +
    "recent messages. We have temporarily restricted your ability to talk. " +
    "You will be able to resume your conversation in 1 minute.";
  ok("restriction classifies", RL.isRestricted(RESTR) === true);
  ok("ToS question is not a restriction",
    RL.isRestricted("What are the terms of service?") === false);
  ok("command JSON never restricts",
    RL.isRestricted('{"command": "list_commands"}') === false);
  ok("classify checks restriction before refusal",
    mainSrc.indexOf("RL.isRestricted") !== -1 &&
    mainSrc.indexOf("RL.isRestricted") < mainSrc.indexOf("RL.isRefusal"));
  ok("loop stops on restriction", /kind === "restricted"/.test(mainSrc));
  ok("restriction banner waits it out", /do NOT click Start|wait it out/i.test(mainSrc));
  ok("restriction aborts every bootstrap path", (mainSrc.match(/start\.restricted/g) || []).length >= 3);

  // Proof gate: A.started may only flip after an executed command.
  ok("started gated on execution",
    /if \(!bootRanTool\) \{[\s\S]{0,400}?didn't emit a command/.test(mainSrc));
  ok("chatty model gets one proof round",
    (mainSrc.match(/RL\.FEEDBACK\.proveIt/g) || []).length === 1);
  ok("no-tool bootstrap banners honestly",
    /didn't emit a command/.test(mainSrc));

  // Input-budget: results capped with a marked gap; the system prompt never.
  ok("core caps results via capResult", /P\.capResult\(&& |P\.capResult &&/.test(mainSrc) ||
    /text = P\.capResult\(text\)/.test(mainSrc));
  ok("core never caps the system prompt", /SYS_MARKER\) === -1/.test(mainSrc));

  // Stuck-lock guard: an idle bar force-clears composer locks.
  ok("idle bar releases stuck locks", /__unlockAt/.test(mainSrc));
}

// Invite rotation: exactly one Discord URL in the shipped extension, the new
// one (pure node - no grep dependency on Windows).
{
  const hits = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = dir + "/" + e.name;
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(js|html|json|md)$/.test(e.name)) continue;
      let src = "";
      try { src = fs.readFileSync(p, "utf8"); } catch { continue; }
      const m = src.match(/discord\.gg\/[A-Za-z0-9]+/g) || [];
      for (const u of m) hits.push(p + ": " + u);
    }
  };
  walk(__dirname);
  ok("single Discord invite, the new one",
    hits.length === 1 && hits[0].includes("discord.gg/AgqwfTVwJ6"));
}
