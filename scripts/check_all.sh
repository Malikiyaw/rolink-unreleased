#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# scripts/check_all.sh — run every gate in one command.
#
# This is the exact sequence CI runs (docs/ci-workflow.yml) and the same six
# commands CONTRIBUTING.md lists. Run it before pushing:
#
#     bash scripts/check_all.sh
#
# Exits non-zero on the first failing gate so the output ends at the problem.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

failures=0
run() {
  local label="$1"; shift
  echo ""
  echo "===== $label ====="
  if "$@"; then
    echo "--- OK: $label"
  else
    echo "--- FAILED: $label"
    failures=$((failures + 1))
  fi
}

# 1. Python: compile + the full suite (includes the drift guards).
run "python compile" python3 -m py_compile bridge.py launch_studio_mcp.py
run "python tests" python3 -m pytest tests/ -q

# 2. Python lint (bridge only — it is the security-critical surface).
if python3 -c "import pyflakes" >/dev/null 2>&1; then
  run "pyflakes" python3 -m pyflakes bridge.py launch_studio_mcp.py
else
  echo ""
  echo "===== pyflakes ====="
  echo "(skipped: pip install -r requirements-dev.txt)"
fi

# 3. Node: typecheck + unit tests.
if [ -x mcp-server/node_modules/.bin/tsc ]; then
  run "typescript" mcp-server/node_modules/.bin/tsc -p mcp-server/tsconfig.json --noEmit
  run "vitest" bash -c 'cd mcp-server && ./node_modules/.bin/vitest run'
else
  echo ""
  echo "===== typescript/vitest ====="
  echo "(skipped: cd mcp-server && npm ci)"
fi

# 4. Extension self-tests + JS syntax.
run "extension parser tests" node rolink-extension/test-parser.js
run "extension agent tests" node rolink-extension/test-agent.js
run "js syntax" bash scripts/check_syntax.sh

# 5. Luau plugin guard.
run "luau blocks" python3 scripts/check_luau_blocks.py

# 6. Tool audit — 0 failing required.
run "tool audit" python3 scripts/audit_tools.py

# 7. Generated artifacts: regenerate, then prove nothing changed.
echo ""
echo "===== generated artifacts in sync ====="
if [ -x mcp-server/node_modules/.bin/tsx ]; then
  npx --prefix mcp-server tsx scripts/generate-tool-prompts.ts >/dev/null 2>&1
  npx --prefix mcp-server tsx scripts/generate-code-fields.ts >/dev/null 2>&1
  node scripts/emit-code-fields.js >/dev/null 2>&1
  node scripts/emit-tool-registry.js >/dev/null 2>&1
  if git diff --quiet -- generated rolink-extension/core rolink-extension/ui; then
    echo "--- OK: artifacts in sync"
  else
    echo "--- FAILED: generated artifacts are stale. Commit the regenerated files:"
    git diff --stat -- generated rolink-extension/core rolink-extension/ui
    failures=$((failures + 1))
  fi
else
  echo "(skipped: needs mcp-server dependencies for the generators)"
fi
run "hud registry in sync" node scripts/emit-tool-registry.js --check

# 8. Versions.
run "version consistency" python3 scripts/check_versions.py

echo ""
if [ "$failures" -eq 0 ]; then
  echo "ALL GATES PASSED"
  exit 0
fi
echo "$failures GATE(S) FAILED"
exit 1
