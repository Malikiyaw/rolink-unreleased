# RoLink Versioning (SemVer)

`VERSION` is the single source of truth. Every other place the version is
spelled out must match it, and `python scripts/check_versions.py` (run in CI and
by `scripts/check_versions.py`) fails the build when they do not:

| Where | What to look for |
| --- | --- |
| `VERSION` | the source of truth |
| `bridge.py` | `BRIDGE_VERSION` |
| `rolink-extension/manifest.json` | `version` |
| `mcp-server/package.json` | `version` |
| `studio-plugin/RoLink.lua` | `PLUGIN_VERSION` **and** the load banner |

Releases are tagged `vMAJOR.MINOR.PATCH`; the tag matches `VERSION`.

## Release process

1. Bump `VERSION`, then the five mirrors above.
2. Regenerate artifacts (`CONTRIBUTING.md` → "Generated files").
3. Run the six pre-PR commands; the audit must report 0 failing.
4. Update `README.md` (headline version, "New in X" section) and `CHANGELOG.md`.
5. Tag `v<version>`.

`README.md` states "Plugin reinstall required" for releases that change
`studio-plugin/RoLink.lua`. It genuinely is required: Studio caches plugins at
startup, so a running Studio keeps the old file.

## Notes on history

Earlier revisions of this file described a `5.6.x` line and a 111-tool
catalogue. That numbering no longer refers to anything in the tree — the
current line is `2.x` and the catalogue is defined by `catalog/tools.json`
(currently 160 tools). Historical detail lives in `CHANGELOG.md`, which is the
authoritative record for what shipped in each release.
