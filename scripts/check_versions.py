#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Verify the release version is identical everywhere it is spelled out.

VERSIONING.md says "the extension manifest, MCP package, parser/system-prompt
version, bridge runtime version and release metadata should move together", but
nothing checked it - mcp-server/package.json had drifted to 2.1.1 while the
product shipped as 2.11.0, and VERSIONING.md still documented a 5.6.x line.

Exit code 0 when consistent, 1 otherwise.
"""
import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read(*parts):
    with io.open(os.path.join(ROOT, *parts), encoding="utf-8", errors="replace") as f:
        return f.read()


def find(pattern, text):
    m = re.search(pattern, text)
    return m.group(1) if m else None


def main():
    checks = []

    version_file = read("VERSION").strip()
    checks.append(("VERSION", version_file))

    checks.append((
        "bridge.py BRIDGE_VERSION",
        find(r'BRIDGE_VERSION\s*=\s*"([^"]+)"', read("bridge.py")),
    ))

    manifest = json.loads(read("rolink-extension", "manifest.json"))
    checks.append(("rolink-extension/manifest.json", manifest.get("version")))

    pkg = json.loads(read("mcp-server", "package.json"))
    checks.append(("mcp-server/package.json", pkg.get("version")))

    checks.append((
        "studio-plugin/RoLink.lua PLUGIN_VERSION",
        find(r'PLUGIN_VERSION\s*=\s*"([^"]+)"', read("studio-plugin", "RoLink.lua")),
    ))
    checks.append((
        "studio-plugin/RoLink.lua load banner",
        find(r'log\("RoLink (\d+\.\d+\.\d+) loaded', read("studio-plugin", "RoLink.lua")),
    ))

    # The README headline and the tool-count claims are documentation drift in
    # the same family, but they are not release-blocking; report them as notes.
    readme = read("README.md")
    readme_version = find(r"^# RoLink (\d+\.\d+\.\d+)", readme)

    print("Version consistency")
    print("-" * 40)
    bad = 0
    for label, value in checks:
        ok = value == version_file
        if not ok:
            bad += 1
        print("%-46s %-10s %s" % (label, value or "<missing>", "OK" if ok else "MISMATCH"))

    notes = []
    if readme_version and readme_version != version_file:
        notes.append("README.md headline says %s but VERSION says %s"
                     % (readme_version, version_file))

    # Catalog count claims (docs say "154 tools" while the catalog had 159+).
    try:
        catalog = json.loads(read("catalog", "tools.json"))
        count = len(catalog.get("tools") or [])
        for label, pattern in (
            ("README.md", r"unlocks all (\d+) tools"),
            ("studio-plugin/RoLink.lua", r"Studio Plugin \((\d+) tools"),
            ("studio-plugin/RoLink.lua", r"loaded \[repo copy\] - (\d+) tools"),
        ):
            text = read(*label.split("/"))
            claimed = find(pattern, text)
            if claimed and int(claimed) != count:
                notes.append("%s claims %s tools, catalog has %d" % (label, claimed, count))
    except Exception as e:
        notes.append("could not read catalog for count check: %s" % e)

    if notes:
        print("\nDocumentation notes (not release-blocking):")
        for n in notes:
            print("  - " + n)

    if bad:
        print("\n%d version string(s) disagree with VERSION (%s)." % (bad, version_file))
        return 1
    print("\nAll version strings agree: %s" % version_file)
    return 0


if __name__ == "__main__":
    sys.exit(main())
