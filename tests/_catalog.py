# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared test helper: where the tool catalogue lives.

The catalogue is a product file (`catalog/tools.json`). It used to live only at
`tests/__registry__.json`, which made a test fixture the runtime source of truth
for the bridge. `load_catalog()` prefers the product file and falls back to the
legacy test file so old checkouts keep working.
"""
import io
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

PRODUCT_CATALOG = os.path.join(ROOT, "catalog", "tools.json")
LEGACY_CATALOG = os.path.join(ROOT, "tests", "__registry__.json")


def catalog_path():
    """Absolute path of the catalogue actually in use."""
    if os.path.exists(PRODUCT_CATALOG):
        return PRODUCT_CATALOG
    return LEGACY_CATALOG


def load_catalog():
    """Return the tool-name list from the catalogue in use."""
    path = catalog_path()
    with io.open(path, encoding="utf-8") as f:
        raw = json.load(f)
    if isinstance(raw, dict):
        raw = raw.get("tools") or []
    if not isinstance(raw, list):
        raise ValueError("%s: expected a list of tool names" % path)
    return raw
