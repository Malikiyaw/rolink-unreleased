#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# scripts/check_syntax.sh - verify all JS files parse before commit/release.
# Run: bash scripts/check_syntax.sh
# Exits 0 if all files parse, 1 if any have syntax errors.
set -e
cd "$(dirname "$0")/.."
errors=0
echo "Checking JS syntax in rolink-extension/..."
for f in $(find rolink-extension -name "*.js" -not -path "*/node_modules/*" -not -path "*/src/*"); do
  if ! node -c "$f" 2>/dev/null; then
    echo "  FAIL: $f"
    node -c "$f" 2>&1 | head -5
    errors=$((errors + 1))
  fi
done
if [ $errors -gt 0 ]; then
  echo ""
  echo "ERROR: $errors JS file(s) have syntax errors. Fix before committing."
  exit 1
fi
echo "  All $(find rolink-extension -name '*.js' -not -path '*/node_modules/*' -not -path '*/src/*' | wc -l) JS files parse cleanly."
