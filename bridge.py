# # SPDX-License-Identifier: GPL-3.0-or-later
# bridge.py
# ──────────────────────────────────────────────────────────────────────────
#  RoLink Bridge
#  Local WebSocket <-> Roblox Studio MCP server.
#  The browser extension talks to this over ws://127.0.0.1:<PORT>.
#
#  What this bridge exposes to Kimi (aggregated into one tools/list):
#    - Every MCP server declared in config.json (by default: roblox), each
#      spawned as a stdio child and routed by tool name.
#
#  Design goals (robustness first):
#   - Each MCP stdio process is read by ONE dedicated thread; responses are
#     matched by JSON-RPC id (no "read the next line and hope" races).
#   - stderr is drained so a child never blocks on a full pipe.
#   - A dead server is auto-restarted and the failing call retried once.
#   - Tool calls are locked PER SERVER, so a slow server never blocks another.
#   - Every call ALWAYS produces a reply: a result OR a structured error.
#     Nothing ever hangs the agentic loop silently.
# ──────────────────────────────────────────────────────────────────────────
import asyncio
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time

try:
    # Sibling script (same folder as bridge.py, which Python puts on sys.path
    # automatically) - reused here purely to detect a Studio version bump
    # (see _current_studio_exe below), not to launch anything.
    import launch_studio_mcp as _studio_scan
except Exception:
    _studio_scan = None

try:
    import websockets
except ImportError:
    print("[bridge] Missing dependency. Run:  pip install websockets")
    sys.exit(1)

# Windows consoles often default to a legacy codepage (cp1252): printing
# non-ASCII text then raises UnicodeEncodeError INSIDE the WS handler, which
# kills the connection. Force UTF-8 (best effort). We also keep all console
# output strictly ASCII (no arrows / dots) so nothing garbles on a console that
# stayed on a legacy codepage anyway.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def _enable_ansi_colors():
    """On Windows, turn on ANSI escape processing so color codes render instead
    of printing as literal gibberish like "<ESC>[92m". Returns True on success."""
    if sys.platform != "win32":
        return True
    try:
        import ctypes
        k = ctypes.windll.kernel32
        h = k.GetStdHandle(-11)  # STD_OUTPUT_HANDLE
        mode = ctypes.c_uint32()
        if not k.GetConsoleMode(h, ctypes.byref(mode)):
            return False
        # ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004
        return bool(k.SetConsoleMode(h, mode.value | 0x0004))
    except Exception:
        return False


HOST = "127.0.0.1"
# Keep in sync with rolink-extension/manifest.json "version" - printed at
# startup so a user's terminal output alone tells us which build they're on.
BRIDGE_VERSION = "2.7.0"
PORT = int(os.environ.get("ROLINK_BRIDGE_PORT", os.environ.get("RL_BRIDGE_PORT", "17613")))
HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, "config.json")
# Serialise extension-driven config mutations. The websocket and the options
# page can both add/remove servers; without this lock two quick writes could
# read the same old file and silently drop one of the changes.
CONFIG_LOCK = threading.RLock()

# The primary server. It is always present, added by the installer, and can
# never be edited/removed through the extension (it is what RoLink is FOR).
PRIMARY_SERVER_ID = "roblox"

# ── RoLink unified catalog (Option A: single WS, bridge answers local tools) ──
# Workflow stays RoLink-identical: extension -> bridge :17613 -> StudioMCP.
# StudioMCP only knows Roblox-native tools. RoLink's 140-catalog adds pure-local
# tools (time, validation, ordering, analytics stubs, planning helpers). Those
# are answered HERE with deterministic handlers so they work even when Studio
# is offline. Studio-mutating tools always go via mgr.call (StudioMCP/addons).
# See docs/workflow-contract.md.
try:
    import json as _json_catalog
    _REG_PATH = os.path.join(HERE, "tests", "__registry__.json")
    with open(_REG_PATH, "r", encoding="utf-8") as _f:
        ROLINK_TOOL_NAMES = _json_catalog.load(_f)
    if not isinstance(ROLINK_TOOL_NAMES, list):
        ROLINK_TOOL_NAMES = []
    _CATALOG_ERROR = "" if ROLINK_TOOL_NAMES else "registry file is empty"
except Exception as e:
    ROLINK_TOOL_NAMES = []
    _CATALOG_ERROR = str(e) or "load failed"
_CATALOG_OK = not _CATALOG_ERROR and bool(ROLINK_TOOL_NAMES)

# Tools that MUST be routed to StudioMCP/addons (they mutate or read Studio).
# Derived from mcp-server/src/tools/registry.ts provider:"roblox" execution:"studio".
STUDIO_ROUTED_TOOLS = frozenset([
    "get_instances", "create_instance", "set_properties", "delete_instance",
    "clone_instance", "move_instance", "find_instance", "execute_luau",
    "get_script_content", "set_script_content", "create_module", "run_function",
    "add_event_handler", "remove_event_handler", "get_global_variables",
    "confirm_sandbox_apply", "simulate_ticks", "get_property_value",
    "get_all_properties", "search_by_attribute", "get_referenced_instances",
    "resolve_path", "ensure_path", "generate_terrain", "set_terrain_region",
    "place_parts", "create_model_from_table", "apply_material", "create_ui",
    "set_ui_property", "get_ui_tree", "bind_ui_click", "create_animation_track",
    "play_animation", "get_animation_info", "delete_animation",
    "create_cutscene", "create_dialogue", "create_motion_effect", "create_vfx",
    "preview_cutscene", "validate_cutscene", "remove_cutscene",
    "create_motion_animation", "inspect_motion_effect", "remove_motion_effect",
    "inspect_motion_animation", "validate_motion_animation", "preview_motion_animation",
    "remove_motion_animation", "export_animation_clip", "publish_animation",
    "set_lighting", "add_particle_emitter",
    "get_datastore_value", "set_datastore_value", "send_notification",
    "set_breakpoint", "remove_breakpoint", "watch_variable", "step_through",
    "continue_execution", "run_playtest", "adjust_difficulty",
    "set_difficulty_profile", "play_sound",
    "analyze_animatable_model", "create_model_animation", "set_model_keyframe",
    "set_model_easing", "add_animation_marker", "preview_model_animation",
    "validate_model_animation",
    "retime_animation", "reverse_animation", "mirror_animation",
    "blend_animation", "fix_animation", "create_attack_animation",
    "create_idle_animation", "create_walk_cycle",
    "set_track_lock",
])

def _local_get_time(args):
    import datetime
    now = datetime.datetime.now(datetime.timezone.utc)
    return {"ok": True, "text": json.dumps({"time": now.isoformat(), "epoch": int(now.timestamp() * 1000)})}

def _local_validate_command(args):
    tool = (args or {}).get("tool", "")
    valid = isinstance(tool, str) and len(tool) > 0 and (tool in ROLINK_TOOL_NAMES or tool in STUDIO_ROUTED_TOOLS)
    # Also accept StudioMCP-dynamic tools (list_roblox_studios etc.) — bridge
    # can't know them offline, so report allowed=true with a note instead of false.
    if tool in ("list_roblox_studios", "get_studio_state", "list_commands", "list_mcp_servers"):
        valid = True
    # Luau pre-flight (Sprint 4 #15): validate_command doubles as the offline
    # Luau gate — when the args carry code, run the same string-aware check
    # safe_call applies to execute_luau, so guaranteed-fail Luau gets a
    # validation_error the model can self-correct from without Studio.
    code = (args or {}).get("code", None)
    if isinstance(code, str):
        _pre = _luau_preflight(code)
        if _pre:
            return {"ok": False, "kind": "validation_error",
                    "error": "validate_command: Luau pre-flight failed: " + _pre}
        _risk = _luau_risk(code)
        return {"ok": True, "text": json.dumps({"tool": tool, "allowed": valid, "luau": "ok",
                                                "risk": _risk, "summary": _risk_summary(_risk)})}
    return {"ok": True, "text": json.dumps({"tool": tool, "allowed": valid})}

def _local_suggest_ordering(args):
    items = (args or {}).get("items", [])
    if not isinstance(items, list):
        return {"ok": False, "kind": "validation_error", "error": "suggest_ordering: 'items' must be an array of strings"}
    ordered = sorted(str(x) for x in items)
    return {"ok": True, "text": json.dumps({"ordered": ordered})}

def _local_get_suggestions(args):
    return {"ok": True, "text": json.dumps({"suggestions": ["get_instances", "get_studio_state", "execute_luau"]})}

def _local_list_plugins(args):
    return {"ok": True, "text": json.dumps({"plugins": ["rolink-core", "selfHeal", "perfTracker"], "count": 3})}

def _local_get_projects(args):
    return {"ok": True, "text": json.dumps({"projects": ["default"], "active": _active_project["name"]})}

def _local_switch_project(args):
    """Offline project switch (Sprint 3 gap, closed Sprint 4): pure-local,
    deterministic, works with no Studio and no MCP alive — same precedent as
    get_projects above. The Studio plugin's own switch is a stub, so shadowing
    it here loses nothing and gains offline usability."""
    a = args or {}
    pid = (a.get("projectId", a.get("project", "")) or "")
    if not isinstance(pid, str):
        pid = ""
    pid = pid.strip()
    if not pid:
        return {"ok": False, "kind": "validation_error", "error": "switch_project: 'projectId' is required"}
    _active_project["name"] = pid
    return {"ok": True, "text": json.dumps({"switched": True, "active": pid})}

# In-memory active project for the offline project handlers above.
_active_project = {"name": "default"}

# ── search_asset: live Roblox Creator Store / Library search ─────────────
# The Studio plugin cannot make outbound web calls, so the local search runs
# HERE (pure stdlib urllib - no Node server, no MCP, no Studio needed). The
# same AssetInfo shape is produced by mcp-server/src/assetStore.ts so both
# paths look identical to the model. NEVER invent results: an upstream
# failure returns asset_search_unavailable, and a transient failure falls
# back to Studio's NATIVE search_asset tool when one is connected.
# Roblox retired the legacy catalog endpoint. The current public Creator Store
# search endpoint is the v2 Toolbox Service API.
_ASSET_SEARCH_URL = "https://apis.roblox.com/toolbox-service/v2/assets:search"
_ASSET_CATEGORIES = {
    "model": "Model", "models": "Model",
    "mesh": "MeshPart", "meshes": "MeshPart", "meshpart": "MeshPart",
    "decal": "Decal", "decals": "Decal", "image": "Decal", "images": "Decal",
    "texture": "Decal", "textures": "Decal",
    "audio": "Audio", "sound": "Audio", "sounds": "Audio",
    "plugin": "Plugin", "plugins": "Plugin",
    "video": "Video", "videos": "Video",
    "font": "FontFamily", "fontfamily": "FontFamily", "fonts": "FontFamily",
    # These are model/toolbox concepts rather than separate v2 search types.
    "tool": "Model", "tools": "Model", "gear": "Model",
    "decoration": "Model", "decorations": "Model",
}
_ASSET_CATEGORY_NAMES = frozenset((
    "Model", "MeshPart", "Decal", "Audio", "Plugin", "Video", "FontFamily",
))
_ASSET_TYPE_NAMES = {
    3: "Audio", 10: "Model", 13: "Decal", 38: "Plugin", 40: "MeshPart",
}


def _asset_category(raw) -> str:
    """Map a user/model-supplied category to a current v2 search type."""
    if raw is None or str(raw).strip() == "":
        return "Model"
    text = str(raw).strip()
    mapped = _ASSET_CATEGORIES.get(text.lower())
    if mapped:
        return mapped
    if text in _ASSET_CATEGORY_NAMES:
        return text
    # Do not send arbitrary text to the API: the service would answer 400 and
    # turn a typo into an opaque network error. Treat it as a model search.
    return "Model"


def _asset_rows(data):
    """Return rows from current v2 and legacy-compatible response shapes."""
    if isinstance(data, list):
        return data
    if not isinstance(data, dict):
        return []
    for key in ("creatorStoreAssets", "data", "catalogSearchResults", "results", "items"):
        if isinstance(data.get(key), list):
            return data[key]
    return []


def _normalize_asset_rows(data, limit, category=None) -> list:
    """Creator Store JSON -> [{id,name,description,creator,assetType,url}].

    The current API returns ``creatorStoreAssets: [{asset, creator}, ...]``.
    The small legacy shapes remain readable so fixtures and older Node data
    cannot turn a valid response into a misleading empty list. Rows without a
    positive numeric id are dropped: an importable asset id is the only thing
    the model may forward to import_asset.
    """
    out = []
    for row in _asset_rows(data):
        if not isinstance(row, dict):
            continue
        asset = row.get("asset") if isinstance(row.get("asset"), dict) else row
        rid = (asset.get("id") or asset.get("ItemId") or asset.get("AssetId")
               or asset.get("assetId"))
        try:
            rid = int(rid)
        except (TypeError, ValueError):
            continue
        if rid <= 0:
            continue
        creator = row.get("creator") if isinstance(row.get("creator"), dict) else {}
        creator_name = (creator.get("name") or row.get("CreatorName")
                        or row.get("creatorName") or (row.get("creator")
                                                       if isinstance(row.get("creator"), str) else ""))
        raw_type = asset.get("assetType") or asset.get("AssetType") or asset.get("itemType")
        if not raw_type and asset.get("assetTypeId") in _ASSET_TYPE_NAMES:
            raw_type = _ASSET_TYPE_NAMES[asset.get("assetTypeId")]
        try:
            script_count = int(asset.get("scriptCount"))
        except (TypeError, ValueError):
            script_count = None
        has_scripts = asset.get("hasScripts")
        if not isinstance(has_scripts, bool) and script_count is not None:
            has_scripts = script_count > 0
        price_cents = None
        try:
            product = row.get("creatorStoreProduct") if isinstance(row, dict) else None
            quantity = ((product or {}).get("purchasePrice") or {}).get("quantity") or {}
            sig = float(quantity["significand"])
            exp = int(quantity["exponent"])
            price_cents = int(round(sig * (10 ** (exp + 2))))
        except (TypeError, ValueError, KeyError, OverflowError):
            pass
        item = {
            "id": rid,
            "name": str(asset.get("name") or asset.get("Name") or "Asset")[:120],
            "description": str(asset.get("description") or asset.get("Description") or "")[:400],
            "creator": str(creator_name or "")[:80],
            "assetType": str(raw_type or category or "Model")[:40],
            "url": "https://www.roblox.com/library/%d/redirect" % rid,
        }
        if isinstance(has_scripts, bool):
            item["hasScripts"] = has_scripts
        if script_count is not None:
            item["scriptCount"] = script_count
        if price_cents is not None:
            item["priceCents"] = price_cents
            item["isFree"] = price_cents == 0
        out.append(item)
        if len(out) >= limit:
            break
    return out


def _local_search_asset(args):
    """Live Creator Store search from the bridge process."""
    a = args or {}
    raw_kw = a.get("keyword", a.get("query", a.get("q", "")))
    if raw_kw is None or not isinstance(raw_kw, str):
        return {"ok": False, "kind": "validation_error",
                "error": "search_asset: 'keyword' must be a string (1-64 characters)"}
    keyword = raw_kw.strip()
    if not keyword:
        return {"ok": False, "kind": "validation_error",
                "error": "search_asset: 'keyword' is required (e.g. keyword='medieval sword')"}
    if len(keyword) > 64:
        return {"ok": False, "kind": "validation_error",
                "error": "search_asset: 'keyword' must be 64 characters or fewer"}
    try:
        limit = int(a.get("limit", 8))
    except (TypeError, ValueError):
        limit = 8
    limit = max(1, min(limit, 20))
    category = _asset_category(a.get("category"))
    try:
        from urllib.parse import urlencode
        from urllib.request import Request, urlopen
        qs = urlencode({"searchCategoryType": category, "query": keyword,
                        "maxPageSize": str(limit),
                        "includeOnlyVerifiedCreators": "false"})
        req = Request("%s?%s" % (_ASSET_SEARCH_URL, qs),
                      headers={"Accept": "application/json",
                               "User-Agent": "RoLink/2.5 (local bridge; asset search)"})
        with urlopen(req, timeout=6) as resp:
            raw = resp.read(2 * 1024 * 1024)
        data = json.loads(raw.decode("utf-8", "replace"))
        if isinstance(data, dict) and (data.get("error") or data.get("errors")):
            raise RuntimeError(str(data.get("error") or data.get("errors"))[:160])
        if not isinstance(data, (dict, list)):
            raise RuntimeError("Roblox catalog returned a non-object JSON response")
    except Exception as e:
        # Transient upstream/network failure: no mock results, ever. If Studio
        # advertises its own search_asset, let the caller fall back to it.
        return {"ok": False, "kind": "execution_error", "transient": True,
                "error_code": "ASSET_SEARCH_UNAVAILABLE",
                "error": ("asset_search_unavailable: Roblox Creator Store search failed "
                          "(%s: %s). Check this PC's network/firewall; never invent asset IDs - "
                          "retry later or search the Creator Store by hand and use import_asset "
                          "with the real id."
                          % (type(e).__name__, str(e)[:160]))}
    assets = _normalize_asset_rows(data, limit, category)
    body = {"keyword": keyword, "category": category, "count": len(assets),
            "assets": assets, "source": "roblox-catalog",
            "note": "Import with import_asset{assetId} - ids here are real; never invent one."}
    if not assets:
        body["note"] = ("no matches - try a shorter keyword or another category "
                        "(Model/MeshPart/Decal/Audio). Never invent an asset id.")
    return {"ok": True, "text": json.dumps(body)}


def _native_asset_body(text, keyword, category, limit):
    """Normalize StudioMCP's native search_asset response, if it succeeded.

    The native Roblox MCP tool has a different schema (`results`, `assetId`,
    `creatorStoreUrl`) and requires a Studio UUID.  Do not pass its text through
    as if it were the bridge contract: an error-shaped native response must
    remain an error, never become a successful empty result.
    """
    try:
        data = json.loads(text or "{}")
    except Exception:
        return None
    if not isinstance(data, dict) or data.get("error") or data.get("ok") is False:
        return None
    if str(data.get("status", "success")).lower() not in ("success", "ok"):
        return None
    rows = data.get("results")
    if not isinstance(rows, list):
        rows = data.get("assets") if isinstance(data.get("assets"), list) else []
    assets = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        try:
            rid = int(row.get("assetId") or row.get("id") or 0)
        except (TypeError, ValueError):
            continue
        if rid <= 0:
            continue
        creator = row.get("creatorName") or row.get("creator") or ""
        if isinstance(creator, dict):
            creator = creator.get("name", "")
        item = {
            "id": rid,
            "name": str(row.get("name") or "Asset")[:120],
            "description": str(row.get("description") or "")[:400],
            "creator": str(creator)[:80],
            "assetType": str(row.get("assetType") or category or "Model")[:40],
            "url": str(row.get("creatorStoreUrl") or
                       row.get("url") or
                       ("https://www.roblox.com/library/%d/redirect" % rid))[:300],
        }
        if isinstance(row.get("hasScripts"), bool):
            item["hasScripts"] = row["hasScripts"]
        if row.get("scriptCount") is not None:
            try:
                item["scriptCount"] = int(row["scriptCount"])
            except (TypeError, ValueError):
                pass
        if isinstance(row.get("isFree"), bool):
            item["isFree"] = row["isFree"]
        if row.get("priceCents") is not None:
            try:
                item["priceCents"] = int(row["priceCents"])
            except (TypeError, ValueError):
                pass
        assets.append(item)
        if len(assets) >= limit:
            break
    body = {"keyword": keyword, "category": category, "count": len(assets),
            "assets": assets, "source": "studio-mcp",
            "note": "Import with import_asset{assetId} - ids here are real; never invent one."}
    if not assets:
        body["note"] = "no matches - never invent an asset id."
    return body


def _native_asset_call_args(arguments, studio_id):
    """Build the native StudioMCP search_asset arguments from our contract."""
    a = arguments or {}
    raw_kw = a.get("keyword", a.get("query", a.get("q", "")))
    keyword = str(raw_kw or "").strip()
    try:
        limit = max(1, min(int(a.get("limit", 8)), 20))
    except (TypeError, ValueError):
        limit = 8
    category = _asset_category(a.get("category"))
    native_category = {"Model": "Model", "MeshPart": "MeshPart", "Decal": "Decal",
                       "Audio": "Audio", "Video": "Video"}.get(category)
    out = {"studio_id": str(studio_id), "query": keyword, "maxResults": limit,
           "scope": "creator_store", "verifiedCreatorsOnly": False}
    if native_category:
        out["assetType"] = native_category
    return out, keyword, category, limit


def _native_studio_id(explicit=None):
    """Get the UUID required by StudioMCP's native search_asset, if available."""
    if explicit:
        return str(explicit)
    try:
        text = _probe_tool_text("list_roblox_studios")
        data = json.loads(text or "{}")
        studios = data.get("studios") if isinstance(data, dict) else None
        if isinstance(studios, list) and studios and isinstance(studios[0], dict):
            sid = studios[0].get("id") or studios[0].get("studio_id")
            return str(sid) if sid else None
    except Exception:
        pass
    return None


def _native_import_asset(arguments, timeout):
    """Use StudioMCP's native insert_asset only when our queue is unavailable.

    The native tool already knows Roblox's type-specific insertion rules and
    strips executable sources. Normalize only a response that proves an
    inserted path; otherwise let the normal queue/plugin-offline path report
    the failure instead of claiming success.
    """
    a = arguments or {}
    raw_id = a.get("assetId")
    if isinstance(raw_id, float) and raw_id.is_integer():
        digits = str(int(raw_id))
    else:
        digits = str(raw_id or "")
    if digits.startswith("rbxassetid://"):
        digits = digits[len("rbxassetid://"):]
    if not digits.isdigit() or int(digits) <= 0:
        return None
    parent = str(a.get("parent") or "workspace")
    native_parent = parent.replace("/", ".")
    if native_parent.lower() in ("workspace", "game.workspace"):
        native_parent = "game.Workspace"
    elif not native_parent.startswith("game."):
        native_parent = "game." + native_parent
    try:
        index = getattr(mgr, "index", {}) or {}
        native_key = None
        for key, entry in index.items():
            holder, real = entry
            if real == "insert_asset" and getattr(holder, "id", PRIMARY_SERVER_ID) == PRIMARY_SERVER_ID:
                native_key = key
                break
        if not native_key:
            return None
        studio_id = _native_studio_id(a.get("studio_id"))
        if not studio_id:
            return None
        native_args = {"studio_id": studio_id, "assetId": digits, "parentPath": native_parent}
        if a.get("assetName"):
            native_args["assetName"] = str(a["assetName"])[:120]
        if a.get("assetType"):
            native_args["assetType"] = str(a["assetType"])[:40]
        raw = mgr.call(native_key, native_args, timeout)
        data = json.loads(raw.get("text") or "{}")
    except Exception:
        return None
    if not isinstance(data, dict) or data.get("error") or data.get("ok") is False:
        return None
    if str(data.get("status", "success")).lower() not in ("success", "ok"):
        return None
    payload = data.get("result") if isinstance(data.get("result"), dict) else data

    def find_path(value):
        if isinstance(value, dict):
            for key in ("path", "instancePath", "fullName", "insertedPath"):
                if isinstance(value.get(key), str) and value.get(key):
                    return value[key]
            for child in value.values():
                found = find_path(child)
                if found:
                    return found
        elif isinstance(value, list):
            for child in value:
                found = find_path(child)
                if found:
                    return found
        return None

    path = find_path(payload)
    if not path:
        return None
    return {"ok": True, "text": json.dumps({
        "tool": "import_asset", "status": "success", "ok": True,
        "imported": True, "assetId": int(digits), "id": int(digits),
        "path": path, "parent": parent, "source": "studio-mcp",
        "verification": {"checked": True},
        "note": "Inserted by StudioMCP native insert_asset; verify with get_instances.",
    })}


def _local_get_memory_usage(args):
    try:
        depth = sum(len(c.tools_cache or []) for c in mgr.clients.values())
    except Exception:
        depth = 0
    return {"ok": True, "text": json.dumps({"queueDepth": depth})}

def _local_set_performance_threshold(args):
    v = (args or {}).get("thresholdMs", 100)
    return {"ok": True, "text": json.dumps({"thresholdMs": v, "applied": True})}

def _local_list_sessions(args):
    return {"ok": True, "text": json.dumps([])}

def _local_session_users(args):
    return {"ok": True, "text": json.dumps([])}


def _installed_plugin_state(plugdir=None, repo_file=None):
    """Read-only compare of the Studio-installed plugin vs this folder's copy.

    Never writes or deletes: purely diagnostic, so `plugin_status` can name
    a stale install (wrong bytes, duplicate copies, missing file) instead of
    the generic 'waiting for poll'. Pass explicit paths in tests; defaults
    resolve the real Studio locations (Windows vs macOS/Linux)."""
    import hashlib as _hl
    import glob as _glob
    try:
        if repo_file is None:
            repo_file = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                     "studio-plugin", "RoLink.lua")
        repo_size = os.path.getsize(repo_file)
        with open(repo_file, "rb") as _f:
            repo_sha = _hl.sha256(_f.read()).hexdigest()[:16]
    except Exception:
        repo_file, repo_size, repo_sha = None, None, None
    try:
        if plugdir is None:
            if os.name == "nt":
                plugdir = os.path.join(os.environ.get("LOCALAPPDATA", ""), "Roblox", "Plugins")
            else:
                plugdir = os.path.join(os.path.expanduser("~"), "Documents", "Roblox", "Plugins")
        copies = []
        for _p in sorted(_glob.glob(os.path.join(plugdir, "*RoLink*.lua"))):
            try:
                _size = os.path.getsize(_p)
                with open(_p, "rb") as _f:
                    _sha = _hl.sha256(_f.read()).hexdigest()[:16]
                copies.append({"name": os.path.basename(_p), "size": _size,
                               "matches_repo": bool(repo_sha) and _sha == repo_sha})
            except Exception:
                copies.append({"name": os.path.basename(_p), "size": None, "matches_repo": False})
    except Exception:
        plugdir, copies = None, []
    exact = [c for c in copies if c.get("name") == "RoLink.lua"]
    return {"dir": plugdir, "repo_size": repo_size,
            "copies": copies, "copy_count": len(copies),
            "exact_present": bool(exact),
            "exact_matches_repo": bool(exact and exact[0].get("matches_repo")),
            "stale_or_missing": not bool(exact and exact[0].get("matches_repo"))}


def _local_plugin_status(args):
    """Instant, offline-capable plugin health for the model to call BEFORE
    burning a timeout on a real Studio command."""
    now = time.time()
    last = _queue_last_poll[0]
    age = (now - last) if last > 0 else None
    with _queue_lock:
        vals = list(_queue_cmds.values())
    _flight = [c for c in vals if c.get("status") == "claimed"]
    _oldest = None
    if _flight:
        try:
            _oldest = round(now - min(c.get("claimed_at", now) for c in _flight), 1)
        except Exception:
            _oldest = None
    _by_proj = {}
    for _c in vals:
        if _c.get("status") in ("queued", "claimed"):
            _pk = _c.get("projectId") or "default"
            _by_proj[_pk] = _by_proj.get(_pk, 0) + 1
    _alive = _plugin_alive()
    if not bool(_queue_server_on[0]):
        _verdict = "no-queue"
    elif last <= 0:
        _verdict = "no-plugin"
    elif _oldest is not None and _oldest > 30:
        _verdict = "stuck-execution"
    elif _flight:
        _verdict = "executing"
    elif _by_proj and _alive and age is not None and age < 5:
        _verdict = "routing-stall"
    elif not _alive:
        _verdict = "plugin-stale"
    else:
        _verdict = "healthy"
    try:
        _installed = _installed_plugin_state()
    except Exception:
        _installed = {"dir": None, "copies": [], "copy_count": 0,
                      "exact_present": False, "exact_matches_repo": False,
                      "stale_or_missing": None}
    _install_note = None
    if _installed.get("stale_or_missing"):
        _names = [_c.get("name") for _c in _installed.get("copies", [])]
        if not _installed.get("exact_present"):
            _install_note = ("no RoLink.lua in %s (saw: %s) - quit Studio fully, run install-plugin.bat "
                             "from THIS release folder, reopen; expect RoLink 2.7.0 loaded [repo copy]"
                             % (_installed.get("dir") or "?", _names or "nothing"))
        elif _installed.get("copy_count", 1) != 1:
            _install_note = ("duplicate plugin copies %s in %s - Studio loads ALL of them and they fight; "
                             "keep only RoLink.lua, delete the rest, restart Studio fully"
                             % (_names, _installed.get("dir") or "?"))
        else:
            _install_note = ("installed RoLink.lua differs from this folder (repo %s bytes) - reinstall from "
                             "THIS folder with Studio fully closed; expect RoLink 2.7.0 loaded [repo copy]"
                             % (_installed.get("repo_size") or "?"))
    return {"ok": True, "text": json.dumps({
        "queue_up": bool(_queue_server_on[0]),
        "plugin_alive": _plugin_alive(),
        "plugin_version": _plugin_version[0] or None,
        "stale": _queue_last_poll[0] > 0 and not _plugin_version[0],
        "ever_polled": last > 0,
        "last_poll_age_s": round(age, 1) if age is not None else None,
        "pending": sum(1 for c in vals if c.get("status") in ("queued", "claimed")),
        "pending_by_project": _by_proj,
        "in_flight": len(_flight),
        "oldest_claim_age_s": _oldest,
        "verdict": _verdict,
        "installed_plugin": _installed,
        "install_note": _install_note,
        "consecutive_timeouts": _queue_consec_timeouts[0],
    })}

def _local_get_studio_state(args):
    """Aggregated Studio truth: connectivity + play state + selection + load.

    Never raises, never waits on StudioMCP (probe_studio is a cache read).
    The plugin probe is best-effort: offline fields report "unknown" instead
    of failing the whole call."""
    try:
        st = probe_studio()
    except Exception:
        st = {"app": None, "place": None}
    app, place = st.get("app"), st.get("place")
    if app is True and place is True:
        studio = "ready"
    elif app is True:
        studio = "no-place" if place is False else "unknown"
    elif app is False:
        studio = "offline"
    else:
        studio = "unknown"
    play_state, selected, plugin_ver = "unknown", [], (_plugin_version[0] or None)
    if _plugin_alive():
        try:
            # Internal probe: bypasses safe_call name validation on purpose.
            pr = _queue_call("studio_probe", {"projectId": (args or {}).get("projectId", "default")}, 10)
            if pr.get("ok"):
                try:
                    body = json.loads(pr.get("text") or "{}")
                    inner = body.get("result") if isinstance(body.get("result"), dict) else body
                    play_state = inner.get("playState", "unknown")
                    selected = inner.get("selection", []) or []
                    plugin_ver = inner.get("pluginVersion", plugin_ver)
                except Exception:
                    pass
        except Exception:
            pass
    try:
        with _queue_lock:
            pending = sum(1 for c in _queue_cmds.values() if c.get("status") in ("queued", "claimed"))
    except Exception:
        pending = 0
    return {"ok": True, "text": json.dumps({
        "studio": studio,
        "place": place if place is not None else "unknown",
        "playState": play_state,
        "selected": selected,
        "plugin": plugin_ver,
        "bridge": BRIDGE_VERSION,
        "pendingTasks": pending,
        "project": (args or {}).get("projectId", _active_project["name"]),
    })}

# ── Structured project memory (offline JSON store, per project) ──────────
# Sections mirror how Roblox games are actually organized so the AI can pull
# ONE relevant section instead of a dumped context blob.
_MEMORY_SECTIONS = ("architecture", "services", "remotes", "instances",
                    "conventions", "ui", "dependencies", "bugs", "tasks", "decisions")

def _memory_path(project):
    safe = "".join(c if (c.isalnum() or c in "-_") else "_" for c in (project or "default")) or "default"
    d = os.path.join(HERE, "memory")
    try:
        os.makedirs(d, exist_ok=True)
    except Exception:
        pass
    return os.path.join(d, safe + ".json")

def _memory_load(project):
    p = _memory_path(project)
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            return data
    except Exception:
        pass
    return {s: "" for s in _MEMORY_SECTIONS}

def _memory_save(project, data):
    p = _memory_path(project)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, p)

def _local_get_memory(args):
    """get_memory{project?, section?}: one section, or a TOC with sizes.

    The prompt rule: ask for the section the task needs (ui task -> "ui" +
    "remotes"), never the whole store."""
    a = args or {}
    project = a.get("project", a.get("projectId", _active_project["name"])) or "default"
    section = (a.get("section") or "").strip()
    data = _memory_load(project)
    if section:
        if section not in _MEMORY_SECTIONS:
            return {"ok": False, "kind": "validation_error",
                    "error": f"get_memory: unknown section '{section}' - one of {', '.join(_MEMORY_SECTIONS)}"}
        return {"ok": True, "text": json.dumps({"project": project, "section": section,
                                                "content": data.get(section, "")})}
    toc = {s: len(data.get(s, "") or "") for s in _MEMORY_SECTIONS}
    return {"ok": True, "text": json.dumps({"project": project, "sections": list(_MEMORY_SECTIONS),
                                            "chars": toc,
                                            "hint": "call get_memory with one section name"})}

def _local_update_memory(args):
    """update_memory{project?, section*, content*, mode=replace|append}."""
    a = args or {}
    project = a.get("project", a.get("projectId", _active_project["name"])) or "default"
    section = (a.get("section") or "").strip()
    content = a.get("content", "")
    mode = (a.get("mode") or "replace").strip()
    if section not in _MEMORY_SECTIONS:
        return {"ok": False, "kind": "validation_error",
                "error": f"update_memory: section must be one of {', '.join(_MEMORY_SECTIONS)}"}
    if not isinstance(content, str) or not content.strip():
        return {"ok": False, "kind": "validation_error",
                "error": "update_memory: 'content' must be a non-empty string"}
    if mode not in ("replace", "append"):
        return {"ok": False, "kind": "validation_error",
                "error": "update_memory: mode must be 'replace' or 'append'"}
    if len(content) > 20000:
        return {"ok": False, "kind": "validation_error",
                "error": f"update_memory: content too large ({len(content)} chars, max 20000) - summarize first"}
    data = _memory_load(project)
    data[section] = (data.get(section, "") + "\n" + content if mode == "append" and data.get(section) else content)
    try:
        _memory_save(project, data)
    except Exception as e:
        return {"ok": False, "kind": "execution_error", "error": f"update_memory: save failed: {e}"}
    return {"ok": True, "text": json.dumps({"project": project, "section": section,
                                            "mode": mode, "chars": len(data[section])})}

def _local_playtest_scenario(args):
    """playtest_scenario{scenario*, seconds?, watch?, expect?}: composed flow.

    take_snapshot -> plugin observe window (ticks + Output) -> scan_errors ->
    check `expect` substring in output. Edit-mode observation: starting Play
    itself needs a human click, so this verifies logic, not rendering."""
    a = args or {}
    scenario = (a.get("scenario") or "").strip()
    if not scenario:
        return {"ok": False, "kind": "validation_error",
                "error": "playtest_scenario: 'scenario' is required (e.g. 'new player joins and purchases a sword')"}
    seconds = a.get("seconds", 5)
    try:
        seconds = max(0.5, min(float(seconds), 10.0))
    except Exception:
        return {"ok": False, "kind": "validation_error",
                "error": "playtest_scenario: 'seconds' must be a number 0.5-10"}
    project = a.get("projectId", "default") or "default"
    snap = safe_call("take_snapshot", {"projectId": project}, 30)
    # Queue-direct (not safe_call): this handler OWNS the name
    # "playtest_scenario", so safe_call would recurse into itself.
    obs = _queue_call("playtest_scenario", {"seconds": seconds, "watch": a.get("watch", ""),
                                            "projectId": project}, 30)
    errs = safe_call("scan_errors", {"limit": 20, "projectId": project}, 30)
    checks, output_text = [], ""
    expect = (a.get("expect") or "").strip()
    obs_body: dict = {}
    if obs.get("ok"):
        try:
            obs_body = json.loads(obs.get("text") or "{}").get("result", {})
            output_text = json.dumps(obs_body.get("output", []))[:4000]
        except Exception:
            pass
    err_list = []
    if errs.get("ok"):
        try:
            err_list = json.loads(errs.get("text") or "{}").get("result", {}).get("errors", [])
        except Exception:
            pass
    if expect:
        found = expect.lower() in output_text.lower()
        checks.append({"check": f"output contains '{expect}'", "passed": found})
    checks.append({"check": "no new Studio errors", "passed": len(err_list) == 0,
                   "detail": f"{len(err_list)} error(s) in window"})
    passed = all(c.get("passed") for c in checks)
    return {"ok": passed, "kind": None if passed else "execution_error",
            "text": json.dumps({"scenario": scenario, "passed": passed, "seconds": seconds,
                                "playState": obs_body.get("playState", "unknown"),
                                "checks": checks, "errors": err_list[:10],
                                "snapshotOk": bool(snap.get("ok"))}),
            **({} if passed else {"error": f"playtest_scenario '{scenario}' failed: " +
                  "; ".join(c["check"] for c in checks if not c.get("passed"))})}

def _local_migrate_system(args):
    """migrate_system{system*, goal*, sources[]?, steps[]?, plan_only?, confirm?}.

    Reads current implementation, returns a heuristic plan; applies NOTHING
    unless confirm:true with explicit steps[], which run as an ATOMIC batch
    (rollback on failure). The AI authors steps; the bridge validates shape,
    applies, and verifies."""
    a = args or {}
    system = (a.get("system") or "").strip()
    goal = (a.get("goal") or "").strip()
    if not system or not goal:
        return {"ok": False, "kind": "validation_error",
                "error": "migrate_system: 'system' and 'goal' are required"}
    sources = a.get("sources", []) or []
    if not isinstance(sources, list):
        return {"ok": False, "kind": "validation_error",
                "error": "migrate_system: 'sources' must be an array of script paths"}
    project = a.get("projectId", "default") or "default"
    readback = []
    for path in sources[:10]:
        try:
            r = safe_call("get_script_content", {"path": path, "projectId": project}, 30)
            body = (r.get("text") or "")[:2000]
            readback.append({"path": path, "ok": bool(r.get("ok")), "head": body})
        except Exception as e:
            readback.append({"path": path, "ok": False, "head": str(e)[:200]})
    requires = sorted({m for rb in readback for m in
                       __import__("re").findall(r"require\(\s*([^)]+)\)", rb.get("head", ""))})
    plan = {"system": system, "goal": goal,
            "steps": [{"order": i + 1,
                       "action": "move to module" if i == 0 else "update require",
                       "detail": "author concrete edits from the readback above"}
                      for i in range(min(len(readback), 5))] or
                     [{"order": 1, "action": "add module",
                       "detail": "no sources read - pass sources[] first"}],
            "requiresFound": requires[:20],
            "readback": readback}
    steps = a.get("steps", []) or []
    if a.get("plan_only", True) or not steps or not (a.get("confirm") is True):
        return {"ok": True, "text": json.dumps(
            {"planOnly": True, "plan": plan,
             "toApply": "re-send with plan_only:false, confirm:true, and steps:[{tool,args}] "
                        "(create_module/set_script_content only) to apply atomically"})}
    allowed = {"create_module", "set_script_content"}
    for i, s in enumerate(steps):
        if not isinstance(s, dict) or s.get("tool") not in allowed or not isinstance(s.get("args"), dict):
            return {"ok": False, "kind": "validation_error",
                    "error": f"migrate_system: step {i} must be {{tool, args}} with tool in {sorted(allowed)}"}
    applied = _local_batch_queue({"commands": steps, "mode": "atomic",
                                  "projectId": project}, 60)
    try:
        applied_body = json.loads(applied.get("error") or applied.get("text") or "{}")
    except Exception:
        applied_body = {"raw": (applied.get("error") or applied.get("text") or "")[:500]}
    ok = bool(applied.get("ok"))
    return {"ok": ok, "kind": None if ok else "execution_error",
            "text": json.dumps({"planOnly": False, "plan": plan, "applied": applied_body}),
            **({} if ok else {"error": "migrate_system: atomic apply failed - rolled back"})}

# Deterministic local handlers: work with no Studio, no MCP server alive.
# Anything not listed here falls through to mgr.call (StudioMCP/addons) or a
# structured unknown-tool error — never a hang, never an exception leak.
LOCAL_HANDLERS = {
    "get_time": _local_get_time,
    "validate_command": _local_validate_command,
    "search_asset": _local_search_asset,
    "suggest_ordering": _local_suggest_ordering,
    "get_suggestions": _local_get_suggestions,
    "list_plugins": _local_list_plugins,
    "get_projects": _local_get_projects,
    "switch_project": _local_switch_project,
    "get_memory_usage": _local_get_memory_usage,
    "set_performance_threshold": _local_set_performance_threshold,
    "list_sessions": _local_list_sessions,
    "session_users": _local_session_users,
    "plugin_status": _local_plugin_status,
    "get_studio_state": _local_get_studio_state,
    "get_memory": _local_get_memory,
    "update_memory": _local_update_memory,
    "playtest_scenario": _local_playtest_scenario,
    "migrate_system": _local_migrate_system,
}

def _local_batch_queue(args, timeout):
    """Sequential fan-out for batch_queue (superpower beyond RoLink).

    Each sub-command goes through safe_call recursively so studio tools get
    studio gating and local tools get the fast-path. Bounded to 10 sub-calls:
    the plugin executes on a single thread, so larger batches reliably wedge
    it — prefer single commands, keep batches small and independent. Stops at
    the first stuck/timeout failure instead of hammering the rest. Never raises.

    Modes: best_effort (default) leaves completed steps in place; atomic takes
    a take_snapshot first and, on the first failure, issues rollback for every
    succeeded Studio step and verifies the tree hash matches. Atomic requires
    a live plugin — snapshot/rollback/DataStore effects cannot be restored.

    Bounded by a batch deadline (<=115s): the extension stops listening well
    before its hard cap, so the batch must settle first — otherwise Studio
    keeps running steps the model already recorded as failed (ghost writes).
    Each sub-call gets what remains of the budget, never the full timeout.
    """
    import hashlib as _hl
    cmds = (args or {}).get("commands", [])
    if not isinstance(cmds, list) or not cmds:
        return {"ok": False, "kind": "validation_error", "error": "batch_queue: 'commands' must be a non-empty array"}
    if len(cmds) > 10:
        return {"ok": False, "kind": "validation_error", "error": "batch_queue: max 10 commands per batch - split into smaller batches or single commands"}
    mode = (args or {}).get("mode", "best_effort")
    if mode not in ("atomic", "best_effort"):
        return {"ok": False, "kind": "validation_error",
                "error": "batch_queue: mode must be 'atomic' or 'best_effort'"}

    def _snap_hash():
        """(hash, detail) of the current tree, header line stripped (it carries
        wall-clock/FPS that legitimately differs run to run)."""
        try:
            r = safe_call("take_snapshot", {"projectId": (args or {}).get("projectId", "default")}, 30)
        except Exception as e:
            return None, f"snapshot call raised: {e}"
        if not r.get("ok"):
            return None, f"snapshot failed: {(r.get('error') or '')[:160]}"
        try:
            body = json.loads(r.get("text") or "{}")
            snap = (body.get("result") or {}).get("snapshot", "") if isinstance(body.get("result"), dict) else ""
            if not snap and isinstance(body.get("snapshot"), str):
                snap = body["snapshot"]
        except Exception:
            snap = r.get("text") or ""
        lines = snap.split("\n")
        core = "\n".join(lines[1:] if len(lines) > 1 else lines)
        return _hl.md5(core.encode("utf-8", "replace")).hexdigest(), "ok"

    pre_hash, pre_detail = (None, "best_effort: no snapshot")
    if mode == "atomic":
        pre_hash, pre_detail = _snap_hash()
        if pre_hash is None:
            return {"ok": False, "kind": "execution_error",
                    "error": "batch_queue atomic: cannot guarantee rollback without a pre-snapshot - " + pre_detail}

    def _canonical(t):
        try:
            return _TOOL_ALIASES.get(t, t)
        except Exception:
            return t

    def _is_undoable(tool_name):
        c = _canonical(tool_name)
        try:
            return c in STUDIO_QUEUE_TOOLS or c in _QUEUE_EXTRA_TOOLS
        except Exception:
            return False

    results = []
    failed = None
    _deadline = time.time() + max(10.0, min(float(timeout or 30), 115.0))
    for i, c in enumerate(cmds):
        if not isinstance(c, dict):
            results.append({"index": i, "ok": False, "error": "command must be an object"})
            failed = results[-1]
            break
        sub_name = c.get("tool", "")
        sub_args = c.get("args", {})
        if not isinstance(sub_args, dict):
            sub_args = {}
        if sub_name == "batch_queue":
            # No nested batches (contract): reject instead of recursing.
            results.append({"index": i, "tool": sub_name, "ok": False, "kind": "validation_error",
                            "error": "batch_queue: nested batches are not allowed"})
            failed = results[-1]
            break
        # Recurse via safe_call (defined later) — resolved at call time.
        # Deadline share: the batch must settle before the extension stops
        # listening, so each step gets the remainder of a bounded budget.
        # Under ~8s remaining, stop honestly instead of orphaning work.
        _remaining = _deadline - time.time()
        if _remaining < 8:
            results.append({"index": i, "tool": sub_name or "batch_queue", "ok": False, "kind": "timeout",
                            "error": "batch_queue: batch time budget exhausted with %d of %d commands unrun - completed steps stand (best_effort) or were rolled back (atomic); retry the remainder singly" % (len(cmds) - i, len(cmds))})
            failed = results[-1]
            break
        try:
            r = safe_call(sub_name, sub_args, min(_remaining, 60.0))
        except Exception as e:
            r = {"ok": False, "kind": "execution_error", "error": str(e)}
        results.append({"index": i, "tool": sub_name, **r})
        if not r.get("ok"):
            failed = results[-1]
            if r.get("kind") in ("stuck-execution", "plugin_offline", "timeout"):
                results.append({"index": i + 1, "tool": "batch_queue", "ok": False, "kind": "validation_error",
                                "error": "batch_queue: stopping early - Studio stopped answering; call plugin_status, then retry remaining commands singly"})
            break
    ok_count = sum(1 for r in results if r.get("ok"))
    if failed is None:
        body = {"mode": mode, "status": "success", "batched": len(results),
                "succeeded": ok_count, "partialCommitAllowed": mode != "atomic",
                "results": results}
        return {"ok": True, "text": json.dumps(body)}
    if mode != "atomic":
        body = {"mode": mode, "status": "stopped-at-first-failure", "batched": len(results),
                "succeeded": ok_count, "partialCommitAllowed": True, "results": results}
        return {"ok": True, "text": json.dumps(body)}
    # Atomic: roll back every succeeded Studio step, then verify the tree.
    undo_steps = sum(1 for r in results if r.get("ok") and _is_undoable(r.get("tool", "")))
    rolled_back, verify = False, {"checked": False}
    if undo_steps:
        try:
            rb = safe_call("rollback", {"steps": undo_steps,
                                        "projectId": (args or {}).get("projectId", "default")}, 30)
            rolled_back = bool(rb.get("ok"))
            rb_note = "" if rb.get("ok") else f"rollback call failed: {(rb.get('error') or '')[:160]}"
        except Exception as e:
            rb_note = f"rollback raised: {e}"
        post_hash, post_detail = _snap_hash()
        if post_hash is not None and pre_hash is not None:
            verify = {"checked": True, "passed": post_hash == pre_hash,
                      "detail": "tree hash matches pre-batch snapshot" if post_hash == pre_hash
                                else "tree differs from pre-batch snapshot - manual review needed"}
        else:
            verify = {"checked": True, "passed": False, "detail": (rb_note + "; " + post_detail).strip("; ")}
    else:
        verify = {"checked": True, "passed": True, "detail": "no Studio steps had succeeded - nothing to revert"}
        rolled_back = True
    body = {"mode": "atomic", "status": "rolled_back" if (rolled_back and verify.get("passed")) else "rollback_failed",
            "batched": len(results), "succeeded": ok_count, "rolledBack": rolled_back,
            "undoneSteps": undo_steps, "partialCommitAllowed": False,
            "verification": verify, "results": results}
    return {"ok": False, "kind": "execution_error", "error_code": "TX_ROLLBACK",
            "error": json.dumps(body), "verification": verify}

def _luau_preflight(code):
    """Mirror of mcp-server validateLuau for the WS path (no Node needed).

    Returns an error string when the code is guaranteed to fail Studio's
    loadstring ("Failed to parse command code"), else None. String-aware:
    brackets inside literals/comments never count.
    """
    import re as _re
    if not isinstance(code, str):
        return "code must be a string"
    # Transport markers must never reach the compiler: ###LUA### leak wrote a
    # '#' line 1 into files ("Expected identifier, got '#'"). Flag them here
    # so the model strips instead of executing marker text.
    if "###LUA" in code or "###END_LUA" in code:
        return "render chrome: Luau transport markers (###LUA###) leaked into code - strip them before sending"
    s = _re.sub(r"[\u200b\u200c\u200d\ufeff]", "", code).lstrip("\ufeff")
    s = s.replace("\u201c", '"').replace("\u201d", '"').replace("\u2018", "'").replace("\u2019", "'").replace("\u00a0", " ")
    if not s.strip():
        return "empty code after stripping render chrome"
    if len(s) > 50000:
        return "code too large (max 50k)"
    if s.startswith("```") or _re.match(r"(?:copy\s+code|copy|json)(?![A-Za-z0-9_(])[\s]", s, _re.I):
        return "render chrome prefix (Copy/fence) — strip before sending to Studio"
    if s.rstrip().endswith("```"):
        return "render chrome suffix (fence) — strip before sending to Studio"
    # string/comment-aware balance scan
    paren = brace = bracket = 0
    i, n, st = 0, len(s), None
    while i < n:
        c = s[i]
        if st == '"' or st == "'":
            if c == "\\":
                i += 2
                continue
            if c == st:
                st = None
            i += 1
            continue
        if st == "]]":
            if c == "]" and i + 1 < n and s[i + 1] == "]":
                st = None
                i += 2
                continue
            i += 1
            continue
        if c == "-" and i + 1 < n and s[i + 1] == "-":
            if s[i + 2:i + 4] == "[[":
                end = s.find("]]", i + 4)
                i = n if end == -1 else end + 2
                continue
            nl = s.find("\n", i + 2)
            i = n if nl == -1 else nl + 1
            continue
        if c == '"' or c == "'":
            st = c
            i += 1
            continue
        if c == "[" and i + 1 < n and s[i + 1] == "[":
            st = "]]"
            i += 2
            continue
        if c == "(":
            paren += 1
        elif c == ")":
            paren -= 1
        elif c == "{":
            brace += 1
        elif c == "}":
            brace -= 1
        elif c == "[":
            bracket += 1
        elif c == "]":
            bracket -= 1
        i += 1
    if st:
        return "unterminated string literal"
    if paren != 0:
        return "unbalanced parentheses"
    if brace != 0:
        return "unbalanced braces"
    if bracket != 0:
        return "unbalanced brackets"
    # Tight-loop guard (no hook in Studio to preempt it): a loop with no
    # yield hangs the plugin poll task. Fail fast as validation instead.
    low = s.lower()
    if ("while true" in low or "while 1 do" in low) and not any(
        k in low for k in ("task.wait", "task.delay", "heartbeat", ":wait(", "wait(")
    ):
        return "probable infinite loop with no yield - add task.wait() inside the loop"
    return None

def _strip_luau_noise(code):
    """Code with string literals and comments blanked (length preserved).

    Risk scans must not count `Destroy` inside a comment or `"http"` inside a
    dialogue string. Mirrors the string-aware walk in _luau_preflight."""
    out = list(code)
    i, n = 0, len(code)
    def blank(a, b):
        for k in range(a, min(b, n)):
            if out[k] != "\n":
                out[k] = " "
    while i < n:
        c = code[i]
        if c == "-" and i + 1 < n and code[i + 1] == "-":
            if code[i + 2:i + 4] == "[[":
                end = code.find("]]", i + 4)
                blank(i, n if end == -1 else end + 2)
                i = n if end == -1 else end + 2
                continue
            nl = code.find("\n", i + 2)
            blank(i, n if nl == -1 else nl)
            i = n if nl == -1 else nl
            continue
        if c == '"' or c == "'":
            j = i + 1
            while j < n:
                if code[j] == "\\":
                    j += 2
                    continue
                if code[j] == c:
                    break
                j += 1
            blank(i, j + 1)
            i = j + 1
            continue
        if c == "[" and i + 1 < n and code[i + 1] == "[":
            end = code.find("]]", i + 2)
            blank(i, n if end == -1 else end + 2)
            i = n if end == -1 else end + 2
            continue
        i += 1
    return "".join(out)


def _destroy_in_loop(clean):
    """True when a :Destroy() call sits inside a for/while/repeat body.

    Lets scan-then-delete-one-target through without confirmation (the
    Destroy is outside any loop) while still gating real wipes like
    `for _, d in ipairs(X:GetDescendants()) do d:Destroy() end`.
    Runs on noise-stripped code so keywords inside strings/comments can
    never fake a block. Fail-safe direction: confusion gates (confirm),
    it never silently passes.
    """
    import re as _re
    destroys = [m.start() for m in _re.finditer(r":destroy\s*\(", clean)]
    if not destroys:
        return False
    toks = [(m.start(), m.group(1)) for m in
            _re.finditer(r"\b(for|while|repeat|function|if|until|end)\b", clean)]
    stack = []
    di = 0
    for pos, kw in toks:
        while di < len(destroys) and destroys[di] < pos:
            if "loop" in stack:
                return True
            di += 1
        if kw in ("for", "while", "repeat"):
            stack.append("loop")
        elif kw in ("function", "if"):
            stack.append("block")
        elif kw in ("end", "until"):
            if stack:
                stack.pop()
    while di < len(destroys):
        if "loop" in stack:
            return True
        di += 1
    return False


def _luau_risk(code):
    """Preflight risk analysis for execute_luau-class tools (offline, heuristic).

    Returns {"level": LOW|MEDIUM|HIGH, "dangers": [...], "services": [...],
             "scope": {...}, "requiresConfirm": bool}. Estimates are honest
    approximations (counts + breadth), never fake precision. Non-undoable
    operations (DataStore writes, HTTP, broad destroy) require confirmation.
    """
    import re as _re
    if not isinstance(code, str) or not code.strip():
        return {"level": "LOW", "dangers": [], "services": [], "scope": {},
                "requiresConfirm": False}
    clean = _strip_luau_noise(code)
    low = clean.lower()
    dangers = []
    # Service names live INSIDE string literals (blanked above), so extract
    # from the raw source. Commented-out GetService lines may count — this is
    # a heuristic estimate, and the summary says so.
    services = sorted(set(_re.findall(r"getservice\(\s*['\"]([\w]+)['\"]", code, _re.I)))
    scope = {}

    def count(pat):
        return len(_re.findall(pat, low))

    # — DataStore —
    has_ds = "getdatastore" in low or "getordereddatastore" in low
    ds_write = has_ds and any(k in low for k in ("setasync", "updateasync", "removeasync", "incrementasync"))
    if ds_write:
        dangers.append({"id": "datastore-write", "severity": "HIGH",
                        "detail": "writes live player data (Set/Update/RemoveAsync) - cannot be undone via rollback",
                        "confirm": True})
    elif has_ds:
        dangers.append({"id": "datastore-read", "severity": "LOW",
                        "detail": "reads player data only", "confirm": False})

    # — HTTP —
    if "httpservice" in low or "requestasync" in low or "httpget" in low or "httppost" in low:
        dangers.append({"id": "http-request", "severity": "HIGH",
                        "detail": "contacts the external network - side effects leave Studio",
                        "confirm": True})

    # — Destruction —
    destroys = count(r":destroy\s*\(")
    clears = count(r"clearallchildren\s*\(")
    scan = ("getdescendants" in low or "getchildren" in low)
    broad = clears > 0 or \
            (destroys > 0 and any(k in low for k in ("workspace:destroy", "game:destroy", "game.workspace:destroy"))) or \
            (destroys > 0 and scan and _destroy_in_loop(clean))
    scope["destroyCalls"] = destroys
    if broad:
        dangers.append({"id": "broad-destroy", "severity": "HIGH",
                        "detail": f"{destroys} Destroy call(s) over a subtree (GetDescendants/ClearAllChildren) - confirm scope before running",
                        "confirm": True})
    elif destroys > 0:
        dangers.append({"id": "targeted-destroy", "severity": "MEDIUM",
                        "detail": f"{destroys} targeted Destroy call(s) - undoable via rollback",
                        "confirm": False})

    # — Mass creation (loop-aware: one Instance.new inside a 200-iteration
    # loop is ~200 parts, not ~1) —
    news = count(r"instance\.new\s*\(")
    in_loop = news > 0 and ("for " in low or "while " in low)
    bounds = []
    for m in _re.finditer(r"for\s+\w+\s*=\s*[^,]+,\s*(\d+)", low):
        try:
            bounds.append(int(m.group(1)))
        except Exception:
            pass
    scope["instanceNewCalls"] = news
    estimated = news * (max(bounds) if bounds else 100) if in_loop else news
    if news > 0 and estimated > 50:
        dangers.append({"id": "mass-create", "severity": "HIGH",
                        "detail": f"~{news} Instance.new call site(s) inside loops (~{estimated} estimated instances) - may stall the viewport; split into smaller batches",
                        "confirm": False})
        scope["estimatedInstances"] = f"~{estimated}"
    elif news > 0:
        scope["instancesAffected"] = f"~{news} new instance(s)"

    # — Script source writes —
    if ".source" in low and "=" in low:
        dangers.append({"id": "script-write", "severity": "MEDIUM",
                        "detail": "modifies script source at runtime - undoable via rollback, prefer set_script_content for kept changes",
                        "confirm": False})
        scope["scriptsAffected"] = scope.get("scriptsAffected", ">=1")

    # — Large bounded loops —
    big = False
    for m in _re.finditer(r"for\s+\w+\s*=\s*[^,]+,\s*(\d+)", low):
        try:
            if int(m.group(1)) > 10000:
                big = True
        except Exception:
            pass
    if big:
        dangers.append({"id": "large-loop", "severity": "MEDIUM",
                        "detail": "loop bound over 10000 iterations - must still terminate in seconds (20s budget)",
                        "confirm": False})

    # — External content —
    if "getobjects" in low or "loadstring" in low:
        dangers.append({"id": "external-content", "severity": "MEDIUM",
                        "detail": "loads external/by-id content or dynamic code - verify the source",
                        "confirm": False})

    if services:
        scope["servicesAffected"] = services
    level = "LOW"
    if any(d["severity"] == "HIGH" for d in dangers):
        level = "HIGH"
    elif dangers:
        level = "MEDIUM"
    return {"level": level, "dangers": dangers, "services": services, "scope": scope,
            "requiresConfirm": any(d.get("confirm") for d in dangers)}


def _risk_summary(risk):
    """One-line human summary the AI sees before execution."""
    ds = "; ".join(f"{d['id']}: {d['detail']}" for d in risk.get("dangers", []))
    scope = risk.get("scope", {})
    bits = []
    if scope.get("servicesAffected"):
        bits.append(f"{len(scope['servicesAffected'])} service(s): " + ", ".join(scope["servicesAffected"][:5]))
    if scope.get("instanceNewCalls"):
        bits.append(f"~{scope['instanceNewCalls']} Instance.new")
    if scope.get("destroyCalls"):
        bits.append(f"{scope['destroyCalls']} Destroy")
    head = f"Preflight risk {risk.get('level', 'LOW')}"
    if bits:
        head += " (" + ", ".join(bits) + ")"
    if ds:
        head += " - " + ds
    if risk.get("requiresConfirm"):
        head += " [CONFIRM REQUIRED: re-send with confirm:true]"
    return head

# Full per-tool param guidance for the advertised catalog (drives the live
# list_commands output even when Studio is offline). Generated file; the
# bridge works without it (falls back to a generic description).
try:
    with open(os.path.join(HERE, "generated", "tool-prompts.json"), "r", encoding="utf-8") as _f:
        TOOL_PROMPTS = json.load(_f).get("prompts", {})
    if not isinstance(TOOL_PROMPTS, dict):
        TOOL_PROMPTS = {}
except Exception:
    TOOL_PROMPTS = {}


if _enable_ansi_colors():
    C = {
        "reset": "\033[0m", "dim": "\033[2m", "gr": "\033[92m",
        "yl": "\033[93m", "rd": "\033[91m", "cy": "\033[96m",
        # Bold white-on-red: for a non-technical user, an "ACTION NEEDED" step
        # must look nothing like the routine cyan/yellow status noise around
        # it, or it gets scrolled past unread (seen live 2026-07-13 - the
        # toggle instruction and the boot banner's own yellow re-explanation
        # of the SAME step were visually indistinguishable). Bright-yellow-bg
        # with black text was tried first but reads as low-contrast/washed
        # out on several real terminal color schemes (also seen live) - white
        # on red is the universal high-contrast "act now" pairing.
        "act": "\033[1m\033[97m\033[41m",
    }
else:
    C = {k: "" for k in ("reset", "dim", "gr", "yl", "rd", "cy", "act")}

# Every run appends here (never truncated), so a whole test session - across
# multiple restarts - stays in one file the user can just send us. Each
# process start writes a banner (see main()) so restarts are easy to spot.
LOGS_DIR = os.path.join(HERE, "logs")
os.makedirs(LOGS_DIR, exist_ok=True)
LOG_PATH = os.path.join(LOGS_DIR, "bridge_debug.log")
try:
    _log_file = open(LOG_PATH, "a", encoding="utf-8", errors="replace")
except Exception:
    _log_file = None


class _Spinner:
    """Terminal-only progress indicator for waits that can run several seconds
    (server launch/handshake, Studio attach grace period) so the console never
    just sits there looking dead - the #1 thing that makes a user assume the
    bridge hung and close the window. Purely cosmetic: writes over its own line
    with \\r, never touches bridge_debug.log, and is skipped entirely when
    stdout isn't a real console (redirected to a file, no ANSI)."""
    FRAMES = "|/-\\"
    # Only ONE spinner may animate at a time: server launches now run in
    # PARALLEL (see MCPManager.start_all), and several spinners fighting over
    # the same console line with \r produced interleaved garbage. Whoever
    # acquires this lock animates; the others silently skip (the log lines
    # around them still tell the story).
    _active = threading.Lock()

    def __init__(self, label):
        self.label = label
        self._stop = threading.Event()
        self._thread = None
        self._owns_lock = False

    def __enter__(self):
        if sys.stdout.isatty() and _Spinner._active.acquire(blocking=False):
            self._owns_lock = True
            self._thread = threading.Thread(target=self._run, daemon=True)
            self._thread.start()
        return self

    def __exit__(self, *exc):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=1.0)
            # Wipe the spinner line so the next log() line doesn't get glued
            # onto trailing spinner characters.
            print("\r" + " " * (len(self.label) + 4) + "\r", end="", flush=True)
        if self._owns_lock:
            _Spinner._active.release()

    def _run(self):
        i = 0
        while not self._stop.is_set():
            frame = self.FRAMES[i % len(self.FRAMES)]
            print(f"\r{C['dim']}{self.label} {frame}{C['reset']}", end="", flush=True)
            i += 1
            self._stop.wait(0.15)


def _clear_spinner_line():
    """Wipe whatever a live _Spinner (running on its own thread, mid-frame) left
    on the current console line via bare \\r writes, so the next print() below
    doesn't get glued onto its trailing characters - seen live 2026-07-14: an
    action_banner() fired while '[roblox] starting... -' was still mid-line and
    the red box rendered smashed onto it instead of starting on a fresh line.
    \\033[K (clear to end of line) doesn't depend on knowing the spinner's label
    length the way Spinner.__exit__'s own wipe does."""
    if sys.stdout.isatty():
        print("\r\033[K", end="", flush=True)


def log(msg, color="dim", terminal=True):
    """terminal=False: written to bridge_debug.log only, not the console. Use
    for noisy/technical detail (raw stderr from child MCP servers, per-call
    traces) that would bury the handful of lines a non-technical user actually
    needs to read. Nothing is ever lost - it all still lands in the file."""
    if terminal:
        _clear_spinner_line()
        ts = time.strftime("%H:%M:%S")
        print(f"{C['dim']}{ts}{C['reset']} {C.get(color,'')}{msg}{C['reset']}", flush=True)
    if _log_file:
        try:
            _log_file.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}\n")
            _log_file.flush()
        except Exception:
            pass


def action_banner(lines):
    """Print a step the USER must physically go do, styled so it cannot be
    mistaken for routine status/warning noise (see the 'act' color above).
    Framed with blank lines so it visually stands alone in a scrolling
    terminal - a non-technical user should be able to glance at the window
    and immediately spot this without reading everything above it.

    Every line (header, content, footer) is padded to the SAME width so the
    yellow block renders as one clean rectangle - an earlier version padded
    each line to a fixed guess independently, which produced a ragged block
    with mismatched edges on a real console (seen live 2026-07-13)."""
    header = "ACTION NEEDED"
    width = max([len(header) + 8] + [len(ln) for ln in lines]) + 2
    top = f">>> {header} " + ">" * max(0, width - len(header) - 5)
    _clear_spinner_line()
    print()
    print(f"{C['act']}  {top.ljust(width)}{C['reset']}")
    for ln in lines:
        print(f"{C['act']}  {ln.ljust(width)}{C['reset']}")
    print(f"{C['act']}  {'>' * width}{C['reset']}")
    print()
    if _log_file:
        try:
            _log_file.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} ACTION NEEDED: "
                             f"{' | '.join(lines)}\n")
            _log_file.flush()
        except Exception:
            pass


# Roblox Studio exposes its built-in MCP server on this loopback port. StudioMCP
# (and our bridge, via it) reaches Studio through it.
STUDIO_MCP_PORT = 13469


def _port_owner(port):
    """(pid, name, path) of the process LISTENING on `port`, or None. Win32 only."""
    if sys.platform != "win32":
        return None
    # BOTH stacks: "-p TCP" alone is IPv4-only, and a squatter listening on
    # [::1]:<port> (IPv6 loopback) was then completely invisible to this probe
    # even while Get-NetTCPConnection showed it plainly (the likely reason the
    # boot-time squatter check stayed silent on a machine where ropilot
    # provably held the port - see the 2026-07-13 live report).
    out = ""
    for proto in ("TCP", "TCPv6"):
        try:
            out += subprocess.run(
                ["netstat", "-ano", "-p", proto],
                capture_output=True, text=True, encoding="utf-8", errors="replace",
                timeout=8,
            ).stdout
        except Exception:
            pass
    if not out:
        return None
    pid = None
    # v4 lines end the local address in ":<port>", v6 in "]:<port>" - matching
    # on the ":<port> " suffix (with the column gap) covers both shapes.
    needle = f":{port} "
    for line in out.splitlines():
        if "LISTENING" in line and needle in line:
            parts = line.split()
            if parts and parts[-1].isdigit():
                pid = parts[-1]
                break
    if not pid:
        return None
    name, path = "?", ""
    try:
        ps = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             f"$p=Get-Process -Id {pid} -ErrorAction SilentlyContinue; "
             f"if($p){{$p.Name; $p.Path}}"],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=8,
        ).stdout.splitlines()
        ps = [l.strip() for l in ps if l.strip()]
        if ps:
            name = ps[0]
            path = ps[1] if len(ps) > 1 else ""
    except Exception:
        pass
    return (pid, name, path)


def _roblox_studio_app_running():
    """True/False whether a real Roblox Studio window process exists, or None
    if this can't be determined (non-Windows, or the check itself failed)."""
    if sys.platform != "win32":
        return None
    try:
        out = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq RobloxStudioBeta.exe"],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=8,
        ).stdout
    except Exception:
        return None
    return "RobloxStudioBeta.exe" in out


def _kill_orphan_studio_mcp():
    """Kill leftover StudioMCP.exe processes from a PREVIOUS session/crash.

    StudioMCP.exe is Roblox's own MCP proxy; launch_studio_mcp.py spawns one
    as a direct child every time the bridge starts. If an earlier restart's
    tree-kill missed the grandchild (a reparenting race), or Studio itself
    crashed and left its own StudioMCP.exe running (seen live 2026-07-11:
    RobloxStudioBeta.exe zombied after two RobloxCrashHandler.exe events),
    the orphan keeps LISTENING on Studio's MCP port. Every StudioMCP.exe we
    launch afterward - even a freshly restarted one - just connects to that
    zombie instead of a real Studio, so the bridge reports "Studio connected"
    forever even with Studio fully closed. studio_watch's auto-restart cannot
    fix this on its own: restarting our proxy still lands on the same zombie.

    Only acts when NO real Studio app is running at all - in that state any
    existing StudioMCP.exe is unambiguously orphaned (a legitimate one only
    exists to serve a live Studio), so it is safe to auto-kill without asking.
    If Studio IS running (or this can't be determined), this is a no-op: a
    live StudioMCP.exe might be legitimately serving it, so nothing is
    touched - this must never risk killing a working connection.
    """
    if sys.platform != "win32":
        return
    if _roblox_studio_app_running() is not False:
        return
    try:
        out = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq StudioMCP.exe"],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=8,
        ).stdout
    except Exception:
        return
    if "StudioMCP.exe" not in out:
        return
    log("Found leftover StudioMCP.exe process(es) with no Roblox Studio running - "
        "cleaning them up (known cause of a phantom 'Studio connected' state).", "yl")
    try:
        subprocess.run(["taskkill", "/F", "/IM", "StudioMCP.exe"],
                       capture_output=True, text=True, timeout=8)
    except Exception as e:
        log(f"could not clean up orphaned StudioMCP.exe: {e}", "rd")


def _descendant_pids(root_pid):
    """Set of PIDs = root_pid + every descendant, or None if the process tree
    could not be read (in which case callers must NOT make kill decisions)."""
    if sys.platform != "win32":
        return None
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             "Get-CimInstance Win32_Process | ForEach-Object "
             "{ \"$($_.ProcessId) $($_.ParentProcessId)\" }"],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=10,
        ).stdout
    except Exception:
        return None
    children = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
            children.setdefault(int(parts[1]), []).append(int(parts[0]))
    if not children:
        return None
    pids = {int(root_pid)}
    stack = [int(root_pid)]
    while stack:
        for c in children.get(stack.pop(), []):
            if c not in pids:
                pids.add(c)
                stack.append(c)
    return pids


def _reclaim_studio_port(client):
    """Kill a StudioMCP.exe that owns Studio's MCP port but is NOT our own child.

    The deadlock this breaks (reported live, survives every restart combo):
    a zombie StudioMCP.exe from a crashed session keeps LISTENING on 13469.
    The user reopens Studio -> its MCP plugin does its ONE-SHOT registration
    against the ZOMBIE (wasted). The user restarts the bridge -> Studio is now
    running, so _kill_orphan_studio_mcp's safety guard skips the cleanup, and
    check_studio_port waves the zombie through too (its path IS under Roblox).
    Our fresh StudioMCP can't own the port, Studio never re-registers on its
    own -> 0 tools forever, no restart order can fix it by hand.

    Ownership is decided by PID, not heuristics: we know the PID of the
    launcher we spawned (client.proc), so a StudioMCP.exe holding the port
    outside that process tree is a leftover by definition - Studio open or
    not. If the process tree can't be read, we do nothing (never risk killing
    our own healthy child on bad data). Returns True if a zombie was killed;
    the caller must then restart the roblox proxy (safe here even with Studio
    open: the plugin's single registration already went to the zombie, so
    there is no attempt left for a restart to collide with) AND tell the user
    to open Assistant Settings > MCP Servers so the plugin re-registers.
    """
    owner = _port_owner(STUDIO_MCP_PORT)
    if not owner:
        return False
    pid, name, path = owner
    # Only ever kill a StudioMCP.exe. Studio itself holding the port is fine;
    # a non-Roblox squatter is check_studio_port's (interactive) job.
    if "studiomcp" not in (name or "").lower():
        return False
    try:
        pid_i = int(pid)
    except (TypeError, ValueError):
        return False
    if client is not None and client.proc is not None and client.is_alive():
        tree = _descendant_pids(client.proc.pid)
        if tree is None or pid_i in tree:
            return False  # ours, or unknowable - leave it alone
    log(f"port {STUDIO_MCP_PORT} is held by a StudioMCP.exe (pid {pid_i}) that this "
        "bridge did NOT launch - a leftover from a previous session. Studio "
        "registered to it, so our proxy sees 0 tools.", "yl")
    try:
        subprocess.run(["taskkill", "/F", "/PID", str(pid_i)],
                       capture_output=True, text=True, timeout=8)
    except Exception as e:
        log(f"could not kill the leftover StudioMCP.exe: {e}", "rd")
        return False
    log(f"killed the leftover StudioMCP.exe (pid {pid_i}) to free Studio's MCP port.", "cy")
    return True


def _process_cmdline(pid):
    """Full command line of `pid`, or "" if it can't be read. Win32 only.

    Used to tell OUR OWN kind of process (a python running bridge.py) apart
    from an unrelated app that merely happens to listen on the same port -
    the process NAME is just "python"/"py"/"pythonw", far too generic to kill
    on. The command line is what proves it is a leftover bridge."""
    if sys.platform != "win32":
        return ""
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             f"(Get-CimInstance Win32_Process -Filter \"ProcessId={pid}\" "
             f"-ErrorAction SilentlyContinue).CommandLine"],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=8,
        ).stdout
    except Exception:
        return ""
    return (out or "").strip()


def _reclaim_bridge_port():
    """Free OUR OWN listen port (17613) from a leftover bridge before we bind.

    The common failure (reported live, WinError 10048 on bind): the user
    relaunches start.bat while an earlier bridge.py is still running - window
    closed with the X instead of Ctrl+C, a previous crash that left a detached
    python, or a double double-click. The old process still holds the port, so
    websockets.serve() dies on bind with a cryptic (localised) OSError and the
    whole bridge exits code 1.

    We reuse _port_owner (already generic over the port) and only ever kill a
    process we can PROVE is another bridge.py - never a same-name innocent
    (some unrelated python listening on 17613): the guard is the command line
    containing "bridge.py", plus an explicit self-exclusion by PID. Anything
    else (a non-python app, or a python whose cmdline we can't read) is left
    alone and surfaced to the user by the caller's friendly bind-error path.
    Returns True if a leftover bridge was killed."""
    owner = _port_owner(PORT)
    if not owner:
        return False
    pid, name, path = owner
    try:
        pid_i = int(pid)
    except (TypeError, ValueError):
        return False
    if pid_i == os.getpid():
        return False  # never kill ourselves (defensive; we haven't bound yet)
    # Must look like a python interpreter AND be running bridge.py. Killing on
    # the port alone would murder whatever legitimately owns 17613.
    if "python" not in (name or "").lower() and "py" != (name or "").lower():
        return False
    cmdline = _process_cmdline(pid_i)
    if "bridge.py" not in cmdline.lower():
        log(f"port {PORT} is held by pid {pid_i} ('{name}') but it does not look "
            f"like a RoLink bridge - leaving it alone.", "yl")
        return False
    log(f"port {PORT} is held by a leftover RoLink bridge (pid {pid_i}) from a "
        "previous session - killing it so this one can start.", "yl")
    try:
        subprocess.run(["taskkill", "/F", "/PID", str(pid_i)],
                       capture_output=True, text=True, timeout=8)
    except Exception as e:
        log(f"could not kill the leftover bridge (pid {pid_i}): {e}", "rd")
        return False
    log(f"killed the leftover bridge (pid {pid_i}); the port is free now.", "cy")
    return True


def _kill_port_squatter():
    """Kill a NON-Roblox process holding Studio's MCP port, no questions asked.

    Called only when the child's stderr has PROVEN the port is hijacked (see
    MCPClient.saw_foreign_ws_host - StudioMCP connected to a foreign host and
    could not parse its protocol; the ropilot case). At that point there is no
    ambiguity left to justify check_studio_port's interactive prompt, and the
    prompt was itself a trap: many users never answer it, and the one-shot boot
    check often runs a beat before a background helper (ropilot) grabs the
    port. Here we have hard evidence, so kill the squatter outright. Returns
    (killed, name) so the caller can tell the user which app to uninstall /
    remove from startup, since it will otherwise reclaim the port on next boot.
    """
    owner = _port_owner(STUDIO_MCP_PORT)
    if owner:
        pid, name, path = owner
        if "roblox" in (path or "").lower() or "studiomcp" in (name or "").lower():
            return False, None  # legitimate Studio-side owner; not a squatter
        log(f"port {STUDIO_MCP_PORT} is hijacked by '{name}' (pid {pid}, {path}).", "yl")
        log("    StudioMCP connected to it instead of Roblox Studio - that is why "
            "there are 0 tools.", "yl")
        try:
            subprocess.run(["taskkill", "/F", "/PID", str(pid)],
                           capture_output=True, text=True, timeout=8)
        except Exception as e:
            log(f"could not kill '{name}': {e}", "rd")
            return False, name
        log(f"killed '{name}' so Studio can use the port.", "cy")
        return True, name
    # We could NOT resolve who owns the port, yet StudioMCP's stderr proved the
    # port is hijacked (this function is only called under that proof). This is
    # the state that used to fail SILENTLY: _port_owner returning None (e.g. a
    # squatter listening on IPv6 loopback that an IPv4-only netstat missed, or
    # any netstat quirk) left the user staring at 0 tools with no explanation.
    # Never be silent here. Try a name-based fallback for the known offender
    # (ropilot ships a background helper that squats this port), then always
    # tell the user what we know.
    log(f"port {STUDIO_MCP_PORT} is hijacked (StudioMCP could not talk to Roblox "
        "Studio on it) but the owning process could not be identified by port.", "yl")
    # ropilot is a multi-process app (validated live 2026-07-13): the port is
    # held by ropilot-infra-helper.exe, supervised by ropilot-infra.exe. Kill
    # both so the supervisor can't just respawn the helper and re-grab the port.
    killed_name = None
    for img in ("ropilot-infra-helper.exe", "ropilot-infra.exe", "ropilot.exe"):
        try:
            res = subprocess.run(["taskkill", "/F", "/IM", img],
                                 capture_output=True, text=True, timeout=8)
        except Exception:
            continue
        if res.returncode == 0:
            killed_name = img
            log(f"killed '{img}' (known port squatter) so Studio can use the port.", "cy")
    if killed_name:
        return True, killed_name
    log("    Could not auto-kill it. Find it manually: run  netstat -ano | "
        f"findstr {STUDIO_MCP_PORT}  then end that PID in Task Manager.", "yl")
    return False, None


def _print_squatter_hint(name):
    """After killing a port squatter (e.g. ropilot), tell the user how to stop
    it coming back - it is a background helper that respawns on the next boot
    and re-grabs the port before Studio, which is why a PC reboot never fixed
    this class of 0-tools report."""
    app = name or "the other app"
    action_banner([
        f"'{app}' fights Roblox Studio for its connection - it will keep",
        "coming back after every restart until you remove it.",
        f"1. Uninstall '{app}' (or remove it from Windows startup).",
        "2. In Roblox Studio: Assistant Settings > MCP Servers,",
        "   turn OFF then back ON 'Enable Studio as MCP server'.",
    ])


def _print_reregister_hint():
    """The one user action that completes a zombie-kill recovery: Studio's MCP
    plugin registers only once per boot and that attempt went to the zombie,
    so after the kill + proxy restart the user must make it register again."""
    # Opening the panel alone is technically enough to re-register, but we tell
    # the user to toggle OFF/ON to be sure - a toggle strictly implies opening
    # the panel, so it can never do less, and it removes any ambiguity about
    # whether "just looking at it" counted. Same wording as the squatter/no-place
    # banners so all three read as one identical instruction, not three variants.
    action_banner([
        "Go to Roblox Studio now.",
        "Turn OFF then back ON: Assistant Settings > MCP Servers",
        "         > 'Enable Studio as MCP server'",
        "Wait about 10 seconds - this window will turn green.",
    ])


def check_studio_port():
    """Warn (and optionally kill) a NON-Roblox process squatting Studio's MCP port.

    A third-party tool (e.g. "ropilot") that binds 13469 before Studio does
    hijacks the MCP channel: StudioMCP connects to IT instead of Studio, the
    handshake succeeds but tools/list never answers -> the bridge sees 0 tools.
    This is silent and brutal to diagnose, so we surface it up front.
    """
    owner = _port_owner(STUDIO_MCP_PORT)
    if not owner:
        return False
    pid, name, path = owner
    # The legitimate holder is Studio itself / a Roblox helper: its path lives
    # under a "...\Roblox\..." folder. Anything else is an intruder.
    if "roblox" in (path or "").lower():
        return False
    where = path or name
    log(f"port {STUDIO_MCP_PORT} (Studio's MCP port) is held by a non-Roblox process:", "yl")
    log(f"    {name} (pid {pid})  {where}", "yl")
    log("    This will block Studio's tools (the bridge will see 0 tools).", "yl")
    try:
        ans = input("    Kill this process so Studio can use the port? [y/N] ").strip().lower()
    except (EOFError, KeyboardInterrupt):
        ans = ""
    if ans in ("y", "yes", "o", "oui"):
        try:
            subprocess.run(["taskkill", "/F", "/PID", str(pid)],
                           capture_output=True, text=True, timeout=8)
            log(f"killed {name} (pid {pid}). Studio can use the port now.", "cy")
            # Tell the user the finishing step IMMEDIATELY, here, instead of only
            # after the ~48s server-launch grace loop that follows: killing the
            # squatter frees the port, but Studio's MCP plugin registers only
            # once per boot and that attempt already went to the squatter, so it
            # will NOT re-attach on its own - a toggle is needed. Printing this
            # now (not 48s later, after start_all's grace loop) is what turns a
            # ~1-minute "why is nothing happening" wait into an act-right-away
            # instruction. Uses action_banner (not log) so a non-technical user
            # visually cannot miss it among the surrounding status lines - seen
            # live indistinguishable when both used the same plain color.
            action_banner([
                "Go to Roblox Studio now.",
                "Turn OFF then back ON: Assistant Settings > MCP Servers",
                "         > 'Enable Studio as MCP server'",
                "Wait about 10 seconds - this window will turn green.",
            ])
            return True  # a squatter WAS killed -> Studio must reclaim the port
        except Exception as e:
            log(f"could not kill it: {e}", "rd")
    else:
        log("left it running. Close it yourself, then restart the bridge.", "yl")
    return False


_TRANSIENT_STUDIO_MARKERS = (
    "no roblox studio instance", "no active studio", "studio instance is connect",
    "studio instance connected", "not connected to", "no studio instance",
)


def _looks_like_transient_studio_drop(text):
    low = (text or "").lower()
    return any(m in low for m in _TRANSIENT_STUDIO_MARKERS)


# ── config.json read / write (for extension-driven add/remove) ──────────────
def _read_config():
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            if isinstance(cfg, dict):
                cfg.setdefault("mcpServers", {})
                return cfg
        except Exception as e:
            log(f"config.json unreadable ({e}) - starting from a fresh one", "yl")
    return {"mcpServers": {PRIMARY_SERVER_ID: {"command": "launch_studio_mcp.py", "args": []}}}


def _write_config(cfg):
    """Atomic write so a crash mid-write never leaves a truncated config.json."""
    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
    os.replace(tmp, CONFIG_PATH)


def config_add_server(server_id, command, args=None, env=None):
    """Add/replace an addon server in config.json. Refuses to touch the primary
    (roblox) server. Returns (ok, error)."""
    sid = (server_id or "").strip()
    if not sid:
        return False, "server id is required"
    if sid == PRIMARY_SERVER_ID:
        return False, f"'{PRIMARY_SERVER_ID}' is the primary server and cannot be edited"
    if not (command or "").strip():
        return False, "a command is required"
    with CONFIG_LOCK:
        cfg = _read_config()
        spec = {"command": command.strip(), "args": list(args or [])}
        if env:
            spec["env"] = dict(env)
        cfg["mcpServers"][sid] = spec
        try:
            _write_config(cfg)
        except Exception as e:
            return False, f"could not write config.json: {e}"
    return True, None


def config_remove_server(server_id):
    """Remove an addon server from config.json. Refuses the primary server."""
    sid = (server_id or "").strip()
    if sid == PRIMARY_SERVER_ID:
        return False, f"'{PRIMARY_SERVER_ID}' is the primary server and cannot be removed"
    with CONFIG_LOCK:
        cfg = _read_config()
        if sid not in cfg.get("mcpServers", {}):
            return False, f"server '{sid}' is not in the config"
        del cfg["mcpServers"][sid]
        try:
            _write_config(cfg)
        except Exception as e:
            return False, f"could not write config.json: {e}"
    return True, None


# ══════════════════════════════════════════════════════════════════════════
#  MCP SERVER PRESETS  (strictly opt-in - config.json is never touched here
#  at import time, at boot, or by any code path a user did not explicitly
#  trigger from the extension)
# ══════════════════════════════════════════════════════════════════════════
# A preset is a reviewed, pinned spawn spec for a well-known third-party MCP
# server. Its whole point is that the command/env must match upstream's
# documented setup character for character: a hand-typed typo fails as
# "Blender is broken" minutes later, and the user has no way to tell a typo
# from "the addon is not running".
#
# SAFETY RULES (all enforced by config_add_preset below):
#  * MCPManager.load_config reads config.json and NOTHING else, so a default
#    install still spawns exactly one child (roblox) and its config.json stays
#    byte-identical to the shipped file. A preset is applied only when the user
#    asks for it from the options page (add_preset message).
#  * Re-adding a preset is idempotent; a preset can never take over the
#    primary (roblox) server, and a server id already owned by a DIFFERENT
#    preset is refused instead of silently rewritten.
#  * Nothing is downloaded or launched by the bridge itself: the spec is just
#    written to config.json, and the existing child-process launcher does the
#    rest exactly as it does for a hand-added server.
#
# `namespace` is the advertised tool prefix. Blender ships generically named
# tools (get_scene_info, execute_blender_code, ...) that WILL collide with
# RoLink/Studio names, and a collision is resolved in rebuild_index by
# renaming whichever server is seen SECOND - so an addon could silently take
# over a Roblox command depending on config order. A namespaced server is
# therefore ALWAYS advertised as "<namespace>/<upstream name>" (no ordering
# dependence), while the index keeps the EXACT upstream name for the actual
# tools/call, because upstream only accepts its own spelling.
MCP_SERVER_PRESETS = {
    "mcp-for-blender": {
        "server_id": "blender",
        "label": "Blender (MCP for Blender)",
        "namespace": "blender",
        "command": "uvx",
        "args": ["--python", "3.11", "mcp-for-blender"],
        # Upstream's own defaults are localhost:9876. The IPv4 literal is
        # spelled out on purpose: the Blender addon binds IPv4 only, and on
        # Windows "localhost" can resolve to ::1 first, which is a silent
        # connect failure that looks exactly like "Blender is not responding".
        "env": {
            "BLENDER_HOST": "127.0.0.1",
            "BLENDER_PORT": "9876",
            # Safe mode is deliberately opt-in and local-only. The addon socket
            # has no authentication; safe mode is an upstream guard, not a
            # sandbox, so users should still save their .blend before executing
            # arbitrary Blender code.
            "BLENDER_MCP_SAFE_MODE": "1",
            "DISABLE_TELEMETRY": "true",
            # Pin to uv-managed Python so conda/pyenv/asdf interpreters never
            # hijack the install (upstream recommendation).
            "UV_PYTHON_PREFERENCE": "only-managed",
        },
        "safeMode": True,
        "startupTimeoutMs": 90000,
        # Commands that must exist on PATH before the server can ever work.
        "requires": ["uvx"],
        "homepage": "https://github.com/ahujasid/mcp-for-blender",
        "summary": "Drive Blender: scene/object inspection, materials, Python code, viewport screenshots.",
        "notes": ("Needs uv (astral.sh/uv). In Blender: N -> MCP for Blender -> "
                  "Start MCP Server, otherwise every call fails to connect."),
    },
}


def _preset_namespaces():
    out = {}
    for p in MCP_SERVER_PRESETS.values():
        sid, ns = p.get("server_id"), p.get("namespace")
        if sid and ns:
            out[sid] = ns
    return out


# server_id -> advertised tool prefix. A server can also force its own prefix
# with a "namespace" key in config.json (which wins over this).
SERVER_NAMESPACES = _preset_namespaces()


def preset_availability(preset_id):
    """Is a preset actually runnable on THIS machine? Checked, never assumed -
    the bridge starts every configured server, so a missing `uvx` would
    otherwise show up as a silent crash-loop in the terminal."""
    p = MCP_SERVER_PRESETS.get(preset_id)
    if not p:
        return {"available": False, "missing": [], "hint": f"unknown preset '{preset_id}'"}
    missing = [c for c in (p.get("requires") or []) if not shutil.which(c)]
    return {
        "available": not missing,
        "missing": missing,
        "hint": ("" if not missing else
                 "install uv (https://docs.astral.sh/uv/getting-started/installation/), "
                 "restart RoLink, then add the server again"),
    }


def public_preset(preset_id, preset=None):
    """The extension-facing form of a preset. Only ever built from OUR reviewed
    constants - a user's env values are never echoed back through this path."""
    p = preset if preset is not None else MCP_SERVER_PRESETS.get(preset_id) or {}
    return {
        "id": preset_id,
        "label": p.get("label") or preset_id,
        "summary": p.get("summary") or "",
        "notes": p.get("notes") or "",
        "server_id": p.get("server_id") or "",
        "namespace": p.get("namespace") or "",
        "command": p.get("command") or "",
        "args": list(p.get("args") or []),
        "env": dict(p.get("env") or {}),
        "requires": list(p.get("requires") or []),
        "homepage": p.get("homepage") or "",
    }


def list_presets(installed=None):
    """Every known preset, with availability and whether it is installed."""
    if installed is None:
        installed = set()
        for spec in (_read_config().get("mcpServers", {}) or {}).values():
            if isinstance(spec, dict) and spec.get("preset"):
                installed.add(spec["preset"])
    out = []
    for pid, p in MCP_SERVER_PRESETS.items():
        entry = public_preset(pid, p)
        entry.update(preset_availability(pid))
        entry["installed"] = pid in installed
        out.append(entry)
    return out


def effective_namespace(sid, spec=None):
    """The prefix a server's tools are advertised under ('' = bare names).
    config.json may pin one explicitly; otherwise it comes from the preset
    registry (matched on server id, so a hand-written `uvx mcp-for-blender`
    entry named "blender" is namespaced too)."""
    spec = spec or (_read_config().get("mcpServers", {}) or {}).get(sid) or {}
    if spec.get("namespace"):
        return str(spec["namespace"])
    return SERVER_NAMESPACES.get(sid) or ""


def server_meta(sid, spec=None):
    """Safe-to-broadcast description of a configured server: exact command,
    env NAMES, namespace, preset provenance.

    NEVER env VALUES. A configured MCP server routinely carries API
    credentials (Sketchfab / Poly Pizza / Hunyuan3D keys all read from env),
    and this payload goes to every open extension tab and into the model-facing
    status output - a value must not leave the bridge process. Key names are
    kept because "BLENDER_PORT is not set" is exactly the diagnostic a user
    needs and reveals nothing.

    `spec` may be passed by a caller that already read config.json, so a
    health() over N servers costs one file read, not N."""
    if spec is None:
        spec = (_read_config().get("mcpServers", {}) or {}).get(sid) or {}
    meta = {
        "command": spec.get("command") or "",
        "args": list(spec.get("args") or []),
        "env_keys": sorted(spec.get("env") or {}),
        "namespace": effective_namespace(sid, spec),
        "safeMode": bool((MCP_SERVER_PRESETS.get(spec.get("preset"), {}) or {}).get("safeMode", False)),
        "status": "configured",
    }
    pid = spec.get("preset")
    if pid and pid in MCP_SERVER_PRESETS:
        meta["preset"] = pid
        meta["label"] = MCP_SERVER_PRESETS[pid].get("label") or pid
        meta["homepage"] = MCP_SERVER_PRESETS[pid].get("homepage") or ""
    return meta


def list_mcp_servers():
    """The extension's settings view: every configured server (primary first)
    with its exact spawn spec and live health, plus the presets that are not
    installed yet. Env values are omitted (see server_meta)."""
    cfg = _read_config()
    servers = cfg.get("mcpServers", {}) or {}
    rows = []
    for sid, spec in servers.items():
        spec = spec or {}
        client = mgr.clients.get(sid)
        row = {
            "id": sid,
            "primary": sid == PRIMARY_SERVER_ID,
            "command": spec.get("command") or "",
            "args": list(spec.get("args") or []),
            "env_keys": sorted(spec.get("env") or {}),
            "namespace": effective_namespace(sid, spec),
            "safeMode": bool((MCP_SERVER_PRESETS.get(spec.get("preset"), {}) or {}).get("safeMode", False)),
            "alive": bool(client.is_alive()) if client is not None else False,
            "initialized": bool(getattr(client, "initialized", False)) if client is not None else False,
            "tools": len(client.tools_cache or []) if client is not None else 0,
        }
        if spec.get("preset"):
            row["preset"] = spec["preset"]
        err = getattr(client, "start_error", None)
        if err:
            row["error"] = err
        rows.append(row)
    return {"ok": True, "servers": rows,
            "presets": list_presets({r["preset"] for r in rows if r.get("preset")})}


def config_add_preset(preset_id, server_id=None, env=None):
    """Write a reviewed preset into config.json. Explicit opt-in only.

    Returns (ok, error, info). Refuses the primary server, an unknown preset,
    an id that would make an unusable namespace, and a server id that already
    belongs to a different preset. `env` only ADDS to the preset's own env and
    is never echoed back in `info` (it may hold a user secret)."""
    pid = (preset_id or "").strip()
    p = MCP_SERVER_PRESETS.get(pid)
    if not p:
        return False, (f"unknown MCP preset '{pid}'" if pid else "preset id is required"), None
    sid = (server_id or p.get("server_id") or "").strip()
    if not sid:
        return False, "server id is required", None
    if sid == PRIMARY_SERVER_ID:
        return False, f"'{PRIMARY_SERVER_ID}' is the primary server and cannot be replaced by a preset", None
    if "/" in sid or any(c.isspace() for c in sid):
        return False, "server id must not contain '/' or spaces (it names a tool namespace)", None
    spec = {"command": p.get("command"), "args": list(p.get("args") or []),
            "preset": pid, "namespace": p.get("namespace"),
            "safeMode": bool(p.get("safeMode", False)),
            "startupTimeoutMs": int(p.get("startupTimeoutMs") or 90000)}
    merged_env = {str(k): str(v) for k, v in (p.get("env") or {}).items()}
    merged_env.update({str(k): str(v) for k, v in (env or {}).items() if str(k).strip()})
    if merged_env:
        spec["env"] = merged_env
    with CONFIG_LOCK:
        cfg = _read_config()
        existing = cfg.get("mcpServers", {}).get(sid) or {}
        if existing.get("preset") not in (None, "", pid):
            return False, (f"server '{sid}' already uses the '{existing['preset']}' preset - "
                           "remove it first to switch presets"), None
        cfg["mcpServers"][sid] = spec
        try:
            _write_config(cfg)
        except Exception as e:
            return False, f"could not write config.json: {e}", None
    info = {"server_id": sid, "preset": pid, "env_keys": sorted(merged_env)}
    info.update(preset_availability(pid))
    return True, None, info


def restart_self():
    """Replace this process with a fresh one so config.json is reloaded from
    scratch. Children are killed first to free their stdio pipes / ports before
    the new instance claims them. Never returns on success (os.execv)."""
    log("restarting bridge to load new server config...", "yl")
    try:
        for c in mgr.clients.values():
            c.stop()
    except Exception:
        pass
    if _log_file:
        try:
            _log_file.flush()
        except Exception:
            pass
    # sys.argv[0] may be relative ('bridge.py'); make it absolute so the restart
    # works regardless of the current working directory.
    argv = list(sys.argv)
    script = os.path.abspath(argv[0]) if argv else os.path.abspath(__file__)
    argv = [script] + argv[1:]
    try:
        os.execv(sys.executable, [sys.executable] + argv)
    except Exception as e:
        # execv failed (rare) - fall back to spawning a detached copy and exiting
        # so the user still ends up with a running, up-to-date bridge.
        log(f"in-place restart failed ({e}); spawning a fresh bridge...", "rd")
        try:
            subprocess.Popen([sys.executable] + argv, cwd=HERE)
        except Exception as e2:
            log(f"could not spawn a fresh bridge: {e2} - please restart it manually", "rd")
        os._exit(0)


# ══════════════════════════════════════════════════════════════════════════
#  HARDENED MCP CLIENT  (one per server in config.json)
# ══════════════════════════════════════════════════════════════════════════
class MCPClient:
    def __init__(self, server_id, command, args, env=None, meta=None):
        self.id = server_id
        self.command = command
        self.args = list(args or [])
        self.env = env or {}
        meta = meta or {}
        self.namespace = str(meta.get("namespace") or "")
        self.label = str(meta.get("label") or server_id)
        self.preset = str(meta.get("preset") or "")
        self.safe_mode = bool(meta.get("safeMode") or (self.preset == "mcp-for-blender"))
        self.startup_timeout_ms = int(meta.get("startupTimeoutMs") or 30000)
        self.initialized = False
        self.server_info = {}
        self.proc = None
        self.req_id = 1
        self.write_lock = threading.Lock()
        self.call_lock = threading.Lock()   # serialize tool calls (single stdio pipe)
        self.pending = {}                    # id -> queue.Queue (one slot)
        self.pend_lock = threading.Lock()
        self.tools_cache = []
        self.start_lock = threading.Lock()
        self._reader_thread = None
        # Crash-loop forensics (read by server_watch). The auto-restart used to
        # hide a server that something else kills over and over: the terminal
        # showed an endless quiet restart cycle with no explanation at all. We
        # keep just enough state to NAME the problem in the terminal instead:
        #  - last_exit: exit code from the final _reader EOF (crash vs kill hint)
        #  - stderr_tail: the last few stderr lines (usually the actual reason -
        #    port bind failure, missing dependency, crash trace)
        #  - restart_times: recent auto-restart timestamps (loop detector input)
        #  - loop_warned_at: throttle so the big red banner prints once per
        #    cooldown, not every 5s poll
        self.last_exit = None
        self.stderr_tail = []
        self.restart_times = []
        self.loop_warned_at = 0.0
        # Set when the configured command itself couldn't be launched at all
        # (e.g. 'uvx' not installed / not on PATH). This is NOT a crash - the
        # process never existed, so last_exit/stderr_tail stay empty and the
        # generic crash-loop banner used to print "the server printed no error
        # output before dying", which is misleading for a config problem the
        # user can fix in seconds. Kept across restarts so the banner can name
        # the real cause instead.
        self.start_error = None
        # Set when StudioMCP's stderr shows it connected to a FOREIGN WS host on
        # Studio's MCP port (not Studio). The unmistakable signature is a parse
        # error on the host's messages ("missing field `type`") - Studio speaks
        # the expected protocol, a squatter like ropilot speaks its own. This is
        # a timing-independent proof that the port is hijacked, unlike the
        # one-shot check_studio_port() boot probe which can miss a squatter that
        # grabs the port a moment after boot (seen live 2026-07-13: ropilot took
        # the port ~1s after the boot check ran, so nothing was flagged).
        self.saw_foreign_ws_host = False

    # ── lifecycle ─────────────────────────────────────────────────────────
    def _resolve(self, s):
        return os.path.expandvars(os.path.expanduser(str(s)))

    def start(self):
        with self.start_lock:
            if self.is_alive():
                return
            cmd = [self._resolve(self.command)] + [self._resolve(a) for a in self.args]
            # A bare .py command (relative paths resolve against the bridge dir)
            # is run with the SAME interpreter the bridge itself uses, so it works
            # even on installs where only the `py` launcher exists (no `python`
            # on PATH). This is how the Studio MCP launcher is wired by default.
            if cmd[0].lower().endswith(".py"):
                script = cmd[0]
                if not os.path.isabs(script):
                    script = os.path.join(HERE, script)
                cmd = [sys.executable, script] + cmd[1:]
            # On Windows, npx/npm/yarn/pnpm/bunx are .cmd shims that Popen can't
            # launch directly (WinError 2). Run them through cmd.exe so any
            # node-based MCP server "just works" from config.json.
            if sys.platform == "win32":
                base = os.path.basename(cmd[0]).lower()
                if base in ("npx", "npm", "yarn", "pnpm", "bunx"):
                    cmd = ["cmd.exe", "/c"] + cmd
            env = dict(os.environ)
            for k, v in self.env.items():
                env[k] = self._resolve(v)
            log(f"[{self.id}] launching  ({' '.join(cmd)})", "cy")
            with _Spinner(f"    [{self.id}] starting..."):
                try:
                    self.proc = subprocess.Popen(
                        cmd,
                        stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        text=True,
                        bufsize=1,
                        encoding="utf-8",
                        errors="replace",
                        cwd=HERE,
                        env=env,
                    )
                except FileNotFoundError:
                    # The OS couldn't find cmd[0] at all - this is a config
                    # problem (missing dependency, typo, not on PATH), not a
                    # transient crash. Auto-restart will keep retrying (the
                    # user may install it later), but name the real cause so
                    # it doesn't just look like an endless silent restart loop.
                    self.start_error = (
                        f"command not found: '{cmd[0]}' - is it installed and on PATH? "
                        f"(configured for server '{self.id}' in config.json)"
                    )
                    log(f"[{self.id}] {self.start_error}", "rd")
                    raise
                except OSError as e:
                    self.start_error = f"could not launch '{cmd[0]}': {e}"
                    log(f"[{self.id}] {self.start_error}", "rd")
                    raise
                else:
                    self.start_error = None
                with self.pend_lock:
                    self.pending.clear()
                self.saw_foreign_ws_host = False  # fresh process, fresh verdict
                self._reader_thread = threading.Thread(target=self._reader, args=(self.proc,), daemon=True)
                self._reader_thread.start()
                threading.Thread(target=self._stderr_drain, args=(self.proc,), daemon=True).start()

                # MCP handshake.
                self._request("initialize", {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "rolink-bridge", "version": "1.0"},
                }, timeout=max(30, self.startup_timeout_ms / 1000))
                self.initialized = True
                self._notify("notifications/initialized")
                # Some MCP servers (notably Roblox's StudioMCP) advertise 0 tools at
                # the instant initialize returns, because they connect to their
                # backend (the running Studio) a moment AFTER the stdio handshake.
                # A single tools/list then caches an empty list forever. So if we
                # get nothing, retry for a few seconds to let the backend attach.
                # Short per-attempt timeout so the bridge never looks frozen if the
                # server stays silent (e.g. Studio not open yet); ~12s total budget.
                for _ in range(12):
                    if self.refresh_tools(timeout=3):
                        break
                    if not self.is_alive():
                        break
                    time.sleep(1.0)
            log(f"[{self.id}] MCP server up  ({len(self.tools_cache)} tools advertised)", "cy")

    def is_alive(self):
        return self.proc is not None and self.proc.poll() is None

    def restart(self):
        log(f"[{self.id}] restarting...", "yl")
        self.stop()
        time.sleep(0.4)
        self.start()

    def stop(self):
        with self.pend_lock:
            for q in self.pending.values():
                try:
                    q.put_nowait(None)
                except Exception:
                    pass
            self.pending.clear()
        if self.proc:
            # proc.terminate() (TerminateProcess on Windows) only kills THIS
            # pid. Our command is often a wrapper (e.g. launch_studio_mcp.py)
            # that Popen()s a real child (StudioMCP.exe) to own the stdio
            # pipes - terminate() would leave that child orphaned, still bound
            # to Studio's MCP port, fighting the next restart's fresh instance.
            # taskkill /T kills the whole tree.
            try:
                if sys.platform == "win32":
                    subprocess.run(
                        ["taskkill", "/F", "/T", "/PID", str(self.proc.pid)],
                        capture_output=True, timeout=8,
                    )
                else:
                    self.proc.terminate()
            except Exception:
                pass
        self.proc = None

    # ── io threads ────────────────────────────────────────────────────────
    def _reader(self, proc):
        stream = proc.stdout
        while True:
            try:
                line = stream.readline()
            except Exception:
                break
            if line == "":  # EOF -> process exited
                break
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except Exception:
                continue  # stray non-JSON log on stdout
            mid = msg.get("id")
            if mid is None:
                continue  # server notification, nothing waits on it
            with self.pend_lock:
                q = self.pending.get(mid)
            if q is not None:
                try:
                    q.put_nowait(msg)
                except Exception:
                    pass
        code = proc.poll()
        self.last_exit = code  # kept for the crash-loop banner in server_watch
        log(f"[{self.id}] stdout closed (process ended, exit code {code})", "rd")
        with self.pend_lock:
            for q in self.pending.values():
                try:
                    q.put_nowait(None)
                except Exception:
                    pass

    def _stderr_drain(self, proc):
        # Surface the child's stderr instead of silently discarding it - this
        # is often the ONLY clue why a server died (crash trace, port bind
        # failure, missing Studio, etc).
        try:
            for line in iter(proc.stderr.readline, ""):
                line = line.rstrip()
                if line:
                    # Ring buffer of the last stderr lines: when the server
                    # enters a crash loop, these are printed in the terminal
                    # banner - they are usually the only real explanation
                    # (port already in use, module not found, crash trace).
                    self.stderr_tail.append(line)
                    if len(self.stderr_tail) > 8:
                        self.stderr_tail.pop(0)
                    # Squatter signature: StudioMCP connected to a non-Studio host
                    # on the MCP port and can't parse its protocol. This is the
                    # ropilot hijack, timing-independent (see saw_foreign_ws_host).
                    low = line.lower()
                    if "failed to parse message from ws host" in low or "missing field `type`" in low:
                        self.saw_foreign_ws_host = True
                    log(f"[{self.id}] stderr: {line}", "yl", terminal=False)
        except Exception:
            pass

    # ── jsonrpc ───────────────────────────────────────────────────────────
    def _next_id(self):
        with self.write_lock:
            rid = self.req_id
            self.req_id += 1
            return rid

    def _notify(self, method, params=None):
        payload = {"jsonrpc": "2.0", "method": method, "params": params or {}}
        with self.write_lock:
            self.proc.stdin.write(json.dumps(payload) + "\n")
            self.proc.stdin.flush()

    def _request(self, method, params, timeout):
        if not self.is_alive():
            raise RuntimeError(f"server '{self.id}' is not running")
        rid = self._next_id()
        q = queue.Queue(maxsize=1)
        with self.pend_lock:
            self.pending[rid] = q
        try:
            payload = {"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}}
            with self.write_lock:
                self.proc.stdin.write(json.dumps(payload) + "\n")
                self.proc.stdin.flush()
            try:
                return q.get(timeout=timeout)
            except queue.Empty:
                return None
        finally:
            with self.pend_lock:
                self.pending.pop(rid, None)

    # ── high-level ────────────────────────────────────────────────────────
    def refresh_tools(self, timeout=20):
        msg = self._request("tools/list", {}, timeout=timeout)
        if msg and "result" in msg:
            self.tools_cache = msg["result"].get("tools", [])
        return self.tools_cache

    def call_tool(self, name, arguments, timeout):
        """Returns {"text":..., "images":[...]}. Raises on error/timeout."""
        with self.call_lock:
            for attempt in (1, 2):
                if not self.is_alive():
                    self.restart()
                msg = self._request("tools/call",
                                    {"name": name, "arguments": arguments}, timeout)
                if msg is None:
                    if not self.is_alive():
                        self.restart()
                        msg = self._request("tools/call",
                                            {"name": name, "arguments": arguments}, timeout)
                    if msg is None:
                        raise TimeoutError(
                            f"No response from server '{self.id}' after {timeout}s.")
                if msg.get("error"):
                    err = msg["error"]
                    err_text = err.get("message", json.dumps(err))
                    if attempt == 1 and _looks_like_transient_studio_drop(err_text):
                        log(f"[{self.id}] {name}: transient Studio drop, retrying once...", "yl")
                        time.sleep(1.5)
                        continue
                    raise RuntimeError(err_text)
                content = msg.get("result", {}).get("content", [])
                text = "\n".join(it.get("text", "") for it in content if it.get("type") == "text")
                images = [{"data": it["data"], "mimeType": it.get("mimeType", "image/jpeg")}
                          for it in content if it.get("type") == "image" and it.get("data")]
                if not text and not images and content:
                    text = json.dumps(content)[:4000]
                # Studio's own MCP proxy briefly loses its binding to the Studio
                # app every few seconds on some machines (seen live: repeated
                # "Bound studio ... disconnected for proxy ..." stderr, self-
                # healing within ~1-4s). A tool call landing in that window
                # fails with a "no Studio instance connected" style message
                # even though Studio is genuinely open - confirmed live via
                # start_stop_play. One short retry rides through it instead of
                # surfacing a spurious error to the user.
                if attempt == 1 and _looks_like_transient_studio_drop(text):
                    log(f"[{self.id}] {name}: transient Studio drop, retrying once...", "yl")
                    time.sleep(1.5)
                    continue
                return {"text": text, "images": images}


# ══════════════════════════════════════════════════════════════════════════
#  MANAGER  - aggregates every MCP server, routes by tool name.
# ══════════════════════════════════════════════════════════════════════════
class MCPManager:
    def __init__(self):
        self.clients = {}          # server_id -> MCPClient
        self.index = {}            # advertised_name -> (holder, real_name)
        self.index_lock = threading.Lock()
        # server_id -> forced advertised prefix. Seeded from the preset registry
        # (see SERVER_NAMESPACES) and overridable per server in config.json.
        self.namespaces = dict(SERVER_NAMESPACES)
        # (server_id, upstream_name) -> advertised_name. The reverse of index:
        # rebuild_index used to recover this by scanning the whole index for
        # every tool of every server on every list_tools call (O(n^2) on a
        # ~50-tool catalogue, and a namespaced catalogue makes "which key is
        # this?" a real question rather than "the bare name").
        self.advertised = {}

    def _make_client(self, sid, spec):
        spec = spec or {}
        ns = spec.get("namespace") or effective_namespace(sid, spec)
        if ns:
            self.namespaces[str(sid)] = str(ns)
        preset_id = spec.get("preset")
        preset = MCP_SERVER_PRESETS.get(preset_id, {}) if preset_id else {}
        meta = {
            "namespace": ns or "",
            "label": spec.get("label") or preset.get("label") or sid,
            "preset": preset_id or "",
            "safeMode": bool(preset.get("safeMode", preset_id == "mcp-for-blender")),
            "startupTimeoutMs": int(spec.get("startupTimeoutMs") or preset.get("startupTimeoutMs") or 30000),
        }
        return MCPClient(sid, spec.get("command"), spec.get("args"), spec.get("env"), meta)

    def load_config(self):
        servers = _read_config().get("mcpServers", {}) or {}
        for sid, spec in servers.items():
            self.clients[sid] = self._make_client(sid, spec)
        log(f"configured {len(self.clients)} MCP server(s): {', '.join(self.clients) or '(none)'}", "cy")

    def install_server(self, sid):
        """Load a newly configured server into the ALREADY RUNNING bridge.

        Used by add_preset. The alternative - add_server's full process restart
        - drops every live MCP child (including an attached Roblox Studio
        session) and the whole WebSocket just to add one addon, which is a lot
        of collateral for an opt-in the user just performed. The new client
        finishes its handshake in a background thread, so a slow server can
        never block the socket; returns (ok, error) as soon as it is installed.
        """
        spec = (_read_config().get("mcpServers", {}) or {}).get(sid)
        if not spec:
            return False, f"server '{sid}' is not in the config"
        old = self.clients.get(sid)
        if old is not None:
            try:
                old.stop()
            except Exception:
                pass
        client = self._make_client(sid, spec)
        self.clients[sid] = client

        def _run():
            try:
                client.start()
            except Exception as e:
                log(f"[{sid}] failed to start: {e}  (other servers continue)", "rd")
            finally:
                self.rebuild_index()

        threading.Thread(target=_run, daemon=True).start()
        self.rebuild_index()
        return True, None

    def start_all(self):
        # Launch every configured server IN PARALLEL, not one after another.
        # client.start() can block for up to ~12s (its own "wait for Studio's
        # tools to appear" grace loop) - with a sequential for-loop, Roblox
        # being first in config.json meant every OTHER server (Blender, any
        # addon) didn't even begin launching until Roblox's grace loop gave
        # up, even though that addon has nothing to do with Roblox and could
        # have been ready in 1-2s. A thread per client removes that
        # dependency entirely: a slow/absent Roblox Studio no longer holds up
        # an addon server the user actually wants right now.
        threads = []
        for sid, client in self.clients.items():
            def _run(sid=sid, client=client):
                try:
                    client.start()
                except Exception as e:
                    log(f"[{sid}] failed to start: {e}  (other servers continue)", "rd")
            t = threading.Thread(target=_run, daemon=True)
            t.start()
            threads.append(t)
        for t in threads:
            t.join()
        self.rebuild_index()

    def _advertised_name(self, sid, name, taken):
        """How one server's tool is exposed in the unified catalogue.

        A namespaced server (see MCP_SERVER_PRESETS) is ALWAYS prefixed, so an
        addon can neither steal a Roblox command name nor have its own name
        stolen by whichever server happened to be loaded first. Every other
        server keeps the bare name unless it is already taken, then gets
        "<server_id>/" - the historical collision behaviour, unchanged.
        `taken` is the set of names already handed out in this rebuild.
        """
        ns = self.namespaces.get(sid)
        if ns:
            cand = f"{ns}/{name}"
            if cand not in taken:
                return cand
        cand = f"{sid}/{name}" if name in taken else name
        if cand in taken:
            # Pathological only: two servers pinned to the SAME namespace.
            # Keep both reachable instead of letting one shadow the other.
            i = 2
            while f"{cand}__{i}" in taken:
                i += 1
            cand = f"{cand}__{i}"
        return cand

    def rebuild_index(self):
        """Aggregate server tools into one advertised catalogue."""
        with self.index_lock:
            self.index = {}
            self.advertised = {}
            for sid, client in self.clients.items():
                for t in (client.tools_cache or []):
                    name = t.get("name")
                    if not name:
                        continue
                    advertised = self._advertised_name(sid, name, self.index)
                    self.index[advertised] = (client, name)
                    self.advertised[(sid, name)] = advertised

    def advertised_key_for(self, name):
        """The catalogue key a caller may use for `name`.

        An exact advertised key always wins. Failing that, a namespaced server's
        BARE upstream name resolves to its namespaced key, because upstream
        only accepts its own spelling and models copy names straight out of a
        project's docs ("get_scene_info", not "blender/get_scene_info"). An
        ambiguous bare name (two servers export the same one) resolves to None
        rather than being guessed - safe_call turns that into a
        validation_error naming the exact spellings.
        """
        with self.index_lock:
            if name in self.index:
                return name
        # rebuild_index takes the lock itself, so it must run outside ours.
        self.rebuild_index()
        with self.index_lock:
            if name in self.index:
                return name
            hits = [adv for adv, (_holder, real) in self.index.items() if real == name]
        return hits[0] if len(hits) == 1 else None

    def upstream_candidates(self, name):
        """Every advertised key that dispatches to the upstream tool `name`."""
        with self.index_lock:
            return sorted(adv for adv, (_holder, real) in self.index.items() if real == name)

    def provenance(self, advertised_name):
        """{server, tool} with the EXACT upstream tool name behind an advertised
        key. For a namespaced addon the two differ ("blender/get_scene_info" ->
        "get_scene_info"), and the difference matters downstream: the image
        branch of the extension labels a capture with the tool that really ran,
        and the bridge's own error text quotes the upstream name."""
        with self.index_lock:
            entry = self.index.get(advertised_name)
        if not entry:
            return None
        holder, real = entry
        return {"server": getattr(holder, "id", ""), "tool": real}

    def list_tools(self, refresh=False):
        if refresh:
            # Refresh only live children. Starting every configured server from
            # a catalogue request made a dead Roblox/Blender child block the
            # other server's tools for its full startup timeout; server_watch
            # owns recovery and the next explicit start/restart owns launching.
            for sid, client in self.clients.items():
                try:
                    if client.is_alive():
                        client.refresh_tools(timeout=3)
                except Exception as e:
                    log(f"[{sid}] refresh failed: {e}", "yl")
            self.rebuild_index()
        # Self-heal a missing index. The advertised-key reverse map is built by
        # rebuild_index; without it list_tools falls back to the BARE upstream
        # name, which silently reintroduces the exact collision a namespace
        # exists to prevent (a bare blender "get_scene_info" that config order
        # can hand to Roblox). Landing here means something listed tools before
        # start_all()/restart() finished, so rebuild rather than serve a
        # catalogue we already know is wrong.
        if not self.advertised and any(c.tools_cache for c in self.clients.values()):
            self.rebuild_index()
        out = []
        for sid, client in self.clients.items():
            for t in (client.tools_cache or []):
                name = t.get("name")
                # Reverse map built by rebuild_index: the advertised key for
                # this (server, upstream name) pair - bare, collision-prefixed
                # or namespace-prefixed.
                advertised = self.advertised.get((sid, name), name)
                tt = dict(t)
                tt["name"] = advertised
                tt["server"] = sid
                out.append(tt)
        # Extended 140-tool catalog: advertise local/studio tools even when
        # Studio is offline, with param guidance so list_commands stays useful.
        # Never collides: names already advertised by a live server are skipped
        # here (collisions are resolved by the ownership step below instead).
        # Plus bridge built-ins (plugin_status, get_studio_state, get_memory,
        # update_memory) and the native search extras.
        try:
            _seen = {e.get("name") for e in out}
            for _n in list(ROLINK_TOOL_NAMES) + ["plugin_status", "get_studio_state",
                                                 "get_memory", "update_memory"] + sorted(_QUEUE_EXTRA_TOOLS):
                if _n and _n not in _seen:
                    _e = _local_tool_entry(_n)
                    if _e is not None:
                        out.append(_e)
                        _seen.add(_n)
        except Exception:
            pass
        # Single ownership: where our catalog and a live server advertise the
        # SAME name with different params (Studio-native search_asset vs ours),
        # exactly one may speak. search_asset is bridge-local even when the
        # plugin is offline, so its local schema must always win; other local
        # entries retain the historical plugin-alive ownership behavior.
        try:
            _plugin_online = _plugin_alive()
            _new = []
            for _e in out:
                _name = _e.get("name")
                _bare_name = str(_name or "").split("/")[-1]
                _local_entry = _local_tool_entry(_bare_name)
                if (_e.get("server") in (None, "local", PRIMARY_SERVER_ID)
                        and _local_entry is not None
                        and (_bare_name == "search_asset" or _plugin_online)):
                    _new.append(_local_entry)
                else:
                    _new.append(_e)
            out = _new
        except Exception:
            pass
        return out

    def call(self, name, arguments, timeout):
        with self.index_lock:
            entry = self.index.get(name)
        if entry is None:
            # Maybe a freshly added tool - rebuild once and retry.
            self.rebuild_index()
            with self.index_lock:
                entry = self.index.get(name)
        if entry is None:
            # Last resort: a namespaced server's bare upstream name (dispatched
            # with its EXACT spelling - upstream does not know the prefix).
            key = self.advertised_key_for(name)
            if key:
                with self.index_lock:
                    entry = self.index.get(key)
        if entry is None:
            raise RuntimeError(f"unknown tool '{name}'")
        holder, real_name = entry
        return holder.call_tool(real_name, arguments, timeout)

    def restart(self, server_id=None):
        targets = [self.clients[server_id]] if server_id and server_id in self.clients else list(self.clients.values())
        for client in targets:
            try:
                client.restart()
            except Exception as e:
                log(f"[{client.id}] restart failed: {e}", "rd")
        self.rebuild_index()

    def health(self):
        """Per-server liveness for the status push. `meta` is secret-free by
        construction (env NAMES only - see server_meta); `error` surfaces the
        launch failure the crash-loop forensics already collected, which is the
        difference between "blender ○" and "blender ○ - uvx not found on PATH"."""
        out = []
        specs = (_read_config().get("mcpServers", {}) or {})
        for sid, c in self.clients.items():
            row = {"id": sid, "alive": c.is_alive(), "tools": len(c.tools_cache or []),
                   "initialized": bool(getattr(c, "initialized", False)),
                   "namespace": getattr(c, "namespace", ""),
                   "label": getattr(c, "label", sid),
                   "preset": getattr(c, "preset", ""),
                   "safeMode": bool(getattr(c, "safe_mode", False)),
                   "status": "mcp-ready" if c.is_alive() and c.tools_cache else "starting",
                   "backend": "unverified"}
            try:
                row["meta"] = server_meta(sid, specs.get(sid))
            except Exception:
                pass
            if c.start_error:
                row["error"] = c.start_error
            out.append(row)
        return out

    def any_alive(self):
        return any(c.is_alive() for c in self.clients.values())


# ══════════════════════════════════════════════════════════════════════════
#  WEBSOCKET SERVER
# ══════════════════════════════════════════════════════════════════════════
mgr = MCPManager()
clients = set()

# ── Studio connectivity probe ──────────────────────────────────────────────
# The MCP server process stays alive even when Roblox Studio is closed or its
# MCP option is disabled - tool calls then return instantly with an "Unable to
# find an active Studio instance" text. So "mcp_alive" alone is misleading.
#
# TWO LEVELS (validated live 2026-06):
#  - list_roblox_studios: instant, side-effect-free. studios == [] means NO Studio
#    is connected to the MCP (app closed, OR its "Studio as MCP Server" option is
#    disabled - the two are indistinguishable at this layer). A non-empty list
#    means a Studio app IS connected, BUT note its entry stays present (active:true)
#    even when no place is open - only its "name" goes null. So presence != usable.
#  - get_studio_state: tells whether a PLACE is actually loaded. With a place open
#    it returns "Available DataModels: ..."; with the Studio on the home screen (or
#    the active place closed) it returns "...doesn't have a place opened / previously
#    active Studio has disconnected". That is the authoritative "place loaded" signal
#    (same phrase the call path already recognises in core/main.js).
STUDIO_PROBE_TOOL = "list_roblox_studios"
STUDIO_STATE_TOOL = "get_studio_state"
# Substrings get_studio_state emits when a Studio is connected but no place is open.
NO_PLACE_MARKERS = ("doesn't have a place", "no place opened", "place opened",
                    "has disconnected", "no active studio")


def _probe_tool_text(tool):
    """Call a side-effect-free probe tool with no args; return its text, or None if
    the tool is unavailable / the server is busy / it errored (best-effort)."""
    with mgr.index_lock:
        entry = mgr.index.get(tool)
    if entry is None:
        return None
    holder, real_name = entry
    # Never queue behind a long-running tool call (the probe is best-effort).
    if not holder.call_lock.acquire(blocking=False):
        return None
    try:
        if not holder.is_alive():
            return None
        msg = holder._request("tools/call", {"name": real_name, "arguments": {}}, timeout=8)
        if not msg or msg.get("error"):
            return None
        content = msg.get("result", {}).get("content", [])
        return "\n".join(it.get("text", "") for it in content if it.get("type") == "text")
    except Exception:
        return None
    finally:
        holder.call_lock.release()


def probe_studio():
    """Two-level Studio connectivity. Returns {"app": x, "place": y} where each is
    True / False / None (None = unknown: probe tool missing or server busy).
      app   - a Roblox Studio instance is connected to the MCP server. False = Studio
              closed OR its MCP-server option disabled (indistinguishable here).
      place - a place/datamodel is actually loaded and usable. False = Studio open on
              the home screen, or the active place was closed. Only meaningful when
              app is True (when app is False/None, place mirrors it)."""
    roblox = mgr.clients.get(PRIMARY_SERVER_ID)
    if roblox is not None and roblox.is_alive() and not roblox.tools_cache:
        # StudioMCP advertises ZERO tools - including list_roblox_studios itself -
        # until Studio actually attaches. That makes _probe_tool_text() below
        # return None (tool missing) the same way it would for a genuinely
        # transient "probe busy" blip, even though "Studio is simply closed" is
        # the common, SUSTAINED case here, not a blip. Left unhandled, the
        # extension's "unknown = don't degrade" rule (by design, for real
        # transient blips) then leaves the status dot stuck GREEN forever with
        # Studio fully closed (seen live 2026-07-11: dot stayed "on", tooltip
        # showing only an addon server's tool count). An alive client with an
        # empty catalogue is an unambiguous "not connected", so short-circuit
        # straight to that verdict instead of falling through to "unknown".
        return {"app": False, "place": False}
    text = _probe_tool_text(STUDIO_PROBE_TOOL)
    if text is None:
        return {"app": None, "place": None}
    try:
        studios = json.loads(text).get("studios") or []
    except Exception:
        return {"app": None, "place": None}
    if not studios:
        return {"app": False, "place": False}
    # A Studio app is connected - now check whether a place is actually open.
    state = _probe_tool_text(STUDIO_STATE_TOOL)
    if state is None:
        return {"app": True, "place": None}
    low = state.lower()
    place = not any(m in low for m in NO_PLACE_MARKERS)
    return {"app": True, "place": place}


def _ai_readable_error(kind: str, raw: str, tool: str) -> str:
    try:
        raw = re.sub(r"sabuiltin_[^.\s]*\.", "", str(raw or ""))
    except Exception:
        pass
    if kind == "studio_offline":
        return (f"ERROR calling {tool}: Roblox Studio did not return a result.\n"
                f"Roblox Studio is open but its MCP server is unavailable or no place is loaded.\n"
                f"Fix: In Studio → Assistant Settings → MCP Servers → toggle OFF then ON 'Enable Studio as MCP server', wait 10s, retry.\nRaw: {raw}")
    if kind == "mcp_offline":
        return f"ERROR calling {tool}: Bridge online but MCP server offline. Restart start.bat and ensure Studio MCP enabled. Raw: {raw}"
    if kind == "timeout":
        return (f"ERROR calling {tool}: Roblox Studio did not return a result within timeout.\n"
                f"Possible causes: Studio not ready / MCP disconnected / Luau blocked or waiting.\n"
                f"Retry with smaller command or inspect Studio state. Raw: {raw}")
    if kind == "validation_error":
        return f"ERROR calling {tool}: {raw}\nCheck tool name and required arguments from the system prompt list."
    if kind == "plugin_offline":
        return (f"ERROR calling {tool}: the RoLink Studio plugin did not answer.\n"
                f"Fix: in Roblox Studio, install studio-plugin/RoLink.lua into the Plugins folder "
                f"(run install-plugin.bat), then in the command bar run "
                f"game:GetService(\"HttpService\").HttpEnabled = true, and keep a place open.\nRaw: {raw}")
    if kind == "stuck-execution":
        return (f"ERROR calling {tool}: the Studio plugin is polling but did not finish in time.\n"
                f"Likely cause: Luau is still running (infinite loop or long wait). Do NOT resend the same code. "
                f"Call plugin_status first, simplify the snippet (must terminate, yield with task.wait()), "
                f"and only restart Studio if plugin_status says stuck-execution.\nRaw: {raw}")
    if kind == "play_gated":
        return (f"ERROR calling {tool}: Studio blocked this edit while in Play mode.\n"
                f"Fix: call start_stop_play to leave Play, edit in Edit mode via queue tools, then replay. Raw: {raw}")
    return raw

# ── P0 ToolEvent spine ──────────────────────────────────────────────────
# Mirrors rolink-extension/core/config.js toolCategory() (coarse on purpose;
# the extension emits the authoritative category with its queued/running
# events; the P1 Dock/Timeline and P3 Studio HUD fall back to this mapping
# for bridge-originated events).

def _classify_bridge_error(err_text: str) -> str:
    low = (err_text or "").lower()
    if "unknown tool" in low:
        return "validation_error"
    if "bridge not connected" in low or "bridge offline" in low:
        return "bridge_offline"
    if "not available in play mode" in low or "cannot edit while in play" in low:
        return "play_gated"
    if any(m in low for m in ("no roblox studio", "no active studio", "not connected to", "no studio instance")):
        return "studio_offline"
    if "mcp offline" in low or "mcp not alive" in low:
        return "mcp_offline"
    if "timeout" in low or "timed out" in low:
        return "timeout"
    return "execution_error"

_BRIDGE_OWNED_CACHE = None


def _bridge_owned(name):
    """True when the bridge answers this tool ITSELF: a local handler, a Studio
    route, a plugin-queue route, a documented alias or a catalog tool.

    Such a name is never redirected to a namespaced addon. Blender (and any
    generic addon) exports plausible-looking names like get_time, and without
    this a bare "get_time" would be silently rerouted to blender/get_time and
    the bridge's own tool would vanish from reach. Bridge-owned wins by default;
    a model that genuinely wants the addon tool can always spell the namespaced
    name ("blender/get_time") explicitly, which is exact and therefore always
    wins. Built lazily: the tables it reads are defined after this point.
    """
    global _BRIDGE_OWNED_CACHE
    if _BRIDGE_OWNED_CACHE is None:
        names = set(ROLINK_TOOL_NAMES) | set(_QUEUE_EXTRA_TOOLS) | set(STUDIO_ROUTED_TOOLS)
        names |= set(_TOOL_ALIASES) | set(_TOOL_ALIASES.values())
        try:
            names |= set(LOCAL_HANDLERS) | set(STUDIO_QUEUE_TOOLS)
        except Exception:
            pass
        _BRIDGE_OWNED_CACHE = frozenset(n for n in names if n)
    return name in _BRIDGE_OWNED_CACHE


def safe_call(name, arguments, timeout):
    """Never raises. Always returns a dict the extension can feed back. Deterministic handle_call_tool."""
    if not name or not isinstance(name, str):
        return {"ok": False, "error": "tool name is required", "kind": "validation_error"}
    if len(name) > 120:
        return {"ok": False, "error": "tool name too long", "kind": "validation_error"}
    if arguments is None:
        arguments = {}
    if not isinstance(arguments, dict):
        return {"ok": False, "error": "arguments must be an object", "kind": "validation_error"}
    if os.environ.get("ROLINK_DEBUG_DISPATCH") == "1":
        try:
            log(f"dispatch id=? name={name} args_keys={sorted(arguments.keys())}", "dim", terminal=False)
        except Exception:
            pass
    # Canonical name for Studio-native/legacy spellings. Computed first: the
    # unknown-name check below needs it, and the StudioMCP path further down
    # ALWAYS keeps the original name; only the plugin-queue route uses the
    # canonical form (so list_commands and friends never break).
    canonical = _TOOL_ALIASES.get(name, name)
    # Fast unknown-name rejection: a garbage spelling must never reach a
    # network wait. Infrastructure names always pass (they are answered
    # locally or by live servers); everything else must appear in the
    # registry, the alias map, or a connected server's advertised set.
    _PASSTHROUGH = frozenset(("list_commands", "list_tools", "list_mcp_servers",
                              "get_studio_state", "list_roblox_studios",
                              "plugin_status", "get_memory", "update_memory"))
    if name not in _PASSTHROUGH and canonical not in _PASSTHROUGH:
        # Namespace resolution. An addon server pinned to a namespace is
        # advertised as "blender/get_scene_info" while upstream only accepts
        # "get_scene_info", and a model that copies a name out of a project's
        # own docs writes the bare one. Resolve it to the advertised key HERE,
        # before anything else inspects the name, so every later stage (local
        # fast-path, Studio gates, dispatch) sees a key that really exists.
        # Bridge-owned names are excluded: an addon that happens to export
        # "get_time" must not be able to take over the bridge's own tool just by
        # being present (the model can still spell "blender/get_time").
        try:
            _adv = None if _bridge_owned(name) else mgr.advertised_key_for(name)
        except Exception:
            _adv = None
        if _adv and _adv != name:
            name = _adv
            canonical = name
        else:
            # No exact advertised key, so a BARE upstream name that TWO servers
            # export cannot be resolved without guessing - and guessing would
            # silently run the wrong app's tool. This must be checked before the
            # known-name test below: a bare upstream name IS "known" (it is in
            # a server's tools_cache), so the unknown-name branch would never
            # see it and the model would get a bare "unknown tool" with no
            # usable spelling.
            try:
                _amb = mgr.upstream_candidates(name)
            except Exception:
                _amb = []
            if len(_amb) > 1:
                return {"ok": False, "kind": "validation_error",
                        "error": ('ERROR: "' + name + '" is exported by more than one MCP server. '
                                  'Call the exact name: ' + ", ".join(_amb) + ".")}
    if name not in _PASSTHROUGH and canonical not in _PASSTHROUGH:
        try:
            _known = (set(ROLINK_TOOL_NAMES) | set(_QUEUE_EXTRA_TOOLS)
                      | set(_TOOL_ALIASES) | set(_TOOL_ALIASES.values()))
            try:
                _known |= set(getattr(mgr, "index", {}) or {})
                for _c in (getattr(mgr, "clients", {}) or {}).values():
                    for _t in (_c.tools_cache or []):
                        if isinstance(_t, dict) and _t.get("name"):
                            _known.add(_t["name"])
            except Exception:
                pass
            if name not in _known and canonical not in _known:
                # Collision-prefixed spellings ("roblox/search_asset") look
                # plausible but were never advertised - the prefix only exists
                # inside the bridge's own index, so upstream would answer
                # "unknown tool" after a full round trip. Refuse them here and
                # hand back the real name.
                if "/" in name:
                    _bare = name.rsplit("/", 1)[-1]
                    if _bare in _known:
                        return {"ok": False, "kind": "validation_error",
                                "error": ('ERROR: "' + name + '" is not a command name - the command is "'
                                          + _bare + '". Use the exact name from list_commands.')}
                import difflib as _dl
                _sug = _dl.get_close_matches(name, sorted(_known), n=3, cutoff=0.6)
                # Prefix boost: a truncated name ("create_animation") should
                # complete to its tool even when fuzzy scoring prefers the
                # now-larger sibling set. Exact-prefix hits lead, fuzzy fills.
                try:
                    _pref = sorted(n for n in _known
                                   if n.startswith(name) or (len(name) > 3 and name.startswith(n)))
                    _sug = (_pref + [s for s in _sug if s not in _pref])[:3]
                except Exception:
                    pass
                _hint = (" Did you mean: " + ", ".join(_sug) + "?") if _sug else ""
                return {"ok": False, "kind": "validation_error",
                        "error": f'ERROR: unknown tool "{name}".{_hint} Use an exact name from list_commands.'}
        except Exception:
            pass
    # Local fast-path: pure-local tools work with no Studio and no MCP alive.
    # This is what makes the 111-catalog usable offline and is the Option-A
    # routing agreed in docs/workflow-contract.md.
    # Alias spellings (search_assets -> search_asset) resolve to their local
    # handler too, otherwise they would be queue-routed and never answered.
    _local_name = name if name in LOCAL_HANDLERS else (
        canonical if canonical in LOCAL_HANDLERS else None)
    _local = LOCAL_HANDLERS.get(_local_name) if _local_name else None
    if _local is not None:
        try:
            _r = _local(arguments)
            # search_asset: on a TRANSIENT catalog failure, prefer Studio's
            # native search_asset tool over surfacing a network error. Only
            # when Studio advertises it - and tag the result so the model
            # knows which path answered.
            if (not _r.get("ok") and _r.get("transient")
                    and _local_name == "search_asset"):
                try:
                    _live = set(getattr(mgr, "index", {}) or {})
                except Exception:
                    _live = set()
                _native_name = next((k for k in _live
                                      if k == "search_asset" or k.endswith("/search_asset")), None)
                if _native_name:
                    try:
                        _holder, _ = (getattr(mgr, "index", {}) or {}).get(_native_name, (None, None))
                        if _holder is not None and getattr(_holder, "id", PRIMARY_SERVER_ID) != PRIMARY_SERVER_ID:
                            _native_name = None
                    except Exception:
                        pass
                if _native_name:
                    try:
                        _sid = _native_studio_id((arguments or {}).get("studio_id"))
                        if _sid:
                            _native_args, _kw, _cat, _lim = _native_asset_call_args(arguments, _sid)
                            _sm = mgr.call(_native_name, _native_args, timeout)
                        else:
                            # Older/native-compatible servers may accept the
                            # original shape without studio_id. Try it only as
                            # a best-effort fallback; an error-shaped response
                            # is rejected below and never becomes fake success.
                            _kw = str((arguments or {}).get("keyword",
                                          (arguments or {}).get("query",
                                          (arguments or {}).get("q", ""))) or "").strip()
                            _cat = _asset_category((arguments or {}).get("category"))
                            try:
                                _lim = max(1, min(int((arguments or {}).get("limit", 8)), 20))
                            except (TypeError, ValueError):
                                _lim = 8
                            _sm = mgr.call(_native_name, arguments, timeout)
                        _native_body = _native_asset_body(_sm.get("text"), _kw, _cat, _lim)
                        if _native_body is not None:
                            try:
                                log("search_asset source=studio-mcp", "dim", terminal=False)
                            except Exception:
                                pass
                            return {"ok": True, "text": json.dumps(_native_body),
                                    "images": _sm.get("images") or []}
                    except Exception:
                        pass
            return _r
        except Exception as e:
            return {"ok": False, "error": _ai_readable_error("execution_error", str(e), name), "kind": "execution_error"}
    if name == "batch_queue" and isinstance(arguments.get("commands"), list):
        return _local_batch_queue(arguments, timeout)
    # Luau pre-flight: reject code Studio's loadstring is guaranteed to fail
    # ("Failed to parse command code") with a structured error the model can
    # fix, instead of forwarding it. Mirrors mcp-server validateLuau.
    _pending_risk = None
    if canonical in ("execute_luau", "run_in_sandbox") and isinstance(arguments.get("code"), str):
        _pre = _luau_preflight(arguments["code"])
        if _pre:
            return {"ok": False, "error": _ai_readable_error("validation_error", _pre, name), "kind": "validation_error"}
        # Risk gate: non-undoable operations (DataStore writes, HTTP, broad
        # destroy) need an explicit confirm:true — the AI re-sends the SAME
        # call as JSON {"command": name, "params": {..., "confirm": true}}.
        # Bare ###LUA### blocks cannot carry the flag, hence the re-send.
        _risk = _luau_risk(arguments["code"])
        if _risk.get("requiresConfirm") and not (arguments.get("confirm") is True):
            # File-only forensics: the terminal/log line for this rejection is
            # truncated to 80 chars, which hides which danger actually fired.
            # The model gets the full text via tool_result; this copy is for
            # the human reading bridge_debug.log later.
            try:
                log("confirm_required: %s | %s | code: %s" % (
                    name, _risk_summary(_risk),
                    str(arguments.get("code") or "")[:400].replace("\n", " ")),
                    "dim", terminal=False)
            except Exception:
                pass
            return {"ok": False, "tool": name, "executionId": "rl_rejected",
                    "status": "confirm_required", "durationMs": 0,
                    "kind": "confirm_required", "error_code": "CONFIRM_REQUIRED",
                    "error": (_ai_readable_error("validation_error", _risk_summary(_risk), name)
                              + "\nTo proceed, re-send this exact call as JSON with \"confirm\": true in params. "
                              + "To abort, do something else."),
                    "preflight": _risk, "verification": {"checked": False}}
        # Kept aside for the success path below so the AI sees scope with the
        # output. Never forwarded: the plugin must not see bridge internals.
        _pending_risk = _risk
    # Marker leak guard: transport wrappers must never persist into files.
    # Match the same case-insensitive/spaced/dash dialects as the extension
    # parser; a lowercase marker must not survive into a Script/ModuleScript.
    for _k in ("content", "exports", "code", "handlerCode"):
        _v = (arguments or {}).get(_k)
        if isinstance(_v, str) and (re.search(r"###\s*(?:LUA|RAW)", _v, re.I) or "```" in _v):
            _v = re.sub(r"###\s*LUA(?:\s*:[^#\n]*)?\s*(?:###|---)", "", _v, flags=re.I)
            _v = re.sub(r"###\s*END[_\- ]?LUA\s*(?:###|---)", "", _v, flags=re.I)
            _v = re.sub(r"###\s*RAW(?:\s*:[^#\n]*)?\s*(?:###|---)", "", _v, flags=re.I)
            _v = re.sub(r"###\s*END[_\- ]?RAW\s*(?:###|---)", "", _v, flags=re.I)
            # Bare leading opener with no closer ("###RAW:-- comment" as the
            # first line): strip only the marker token, keep trailing code.
            _v = re.sub(r"^\s*###\s*LUA\s*:\s*", "", _v, flags=re.I)
            _v = re.sub(r"^\s*###\s*RAW\s*:\s*", "", _v, flags=re.I)
            arguments[_k] = _v
    # Large script writes hang the plugin recompile: fail fast offline too,
    # before any queue wait or MCP hop.
    if canonical == "set_script_content" and isinstance((arguments or {}).get("content"), str):
        if len(arguments["content"]) > 100000:
            return {"ok": False, "kind": "validation_error",
                    "error": _ai_readable_error("validation_error", f"content too large ({len(arguments['content'])} chars, max 100000) - split into smaller writes", name)}
    # If the RoLink queue is unavailable, prefer StudioMCP's type-aware native
    # insert_asset over reporting a generic plugin-offline error. The adapter
    # returns only a verified inserted path; malformed/native error responses
    # fall through to the normal queue guidance below.
    if canonical == "import_asset" and not _plugin_alive():
        _native_import = _native_import_asset(arguments, timeout)
        if _native_import is not None:
            return _native_import
    # Third-party MCP path: our Studio plugin answers registry tools through
    # the embedded :3001 queue whenever it is polling. Falls through to
    # StudioMCP below when the plugin is absent (graceful degradation).
    # Circuit breaker: after 2 consecutive queue timeouts, fail fast until a
    # poll NEWER than the last timeout arrives (the plugin recovered).
    if (canonical in STUDIO_QUEUE_TOOLS or canonical in _QUEUE_EXTRA_TOOLS) and _plugin_alive():
        if (_queue_consec_timeouts[0] >= 2
                and _queue_last_poll[0] <= _queue_last_timeout[0]):
            return {"ok": False, "kind": "plugin_offline",
                    "error": _ai_readable_error(
                        "plugin_offline",
                        "the last queue calls timed out - the Studio plugin stopped answering; "
                        "restart Studio (or re-run install-plugin.bat) and retry", name)}
        _res = _queue_call(canonical, arguments, timeout)
        if _pending_risk is not None and isinstance(_res, dict):
            _res["preflight"] = _pending_risk
            # MEDIUM/HIGH scope rides WITH the output so the model reasons
            # about blast radius without a second call. LOW stays quiet.
            if _pending_risk.get("level") in ("MEDIUM", "HIGH") and _res.get("ok"):
                _res["text"] = _risk_summary(_pending_risk) + "\nProceeding...\n" + (_res.get("text") or "")
        return _res
    # Registry tools must never be forwarded to StudioMCP blindly: it only
    # knows ~28 native names, so a queue tool sent there comes back as a
    # confusing "unknown tool" instead of actionable guidance (seen live with
    # get_context_summary answering in 0.05s). Two cases:
    #  - StudioMCP natively knows this exact spelling (overlap): fall through
    #    and let it execute (preserves setups without the plugin).
    #  - Otherwise: instant plugin_offline guidance, no burnt waits, no MCP hop.
    if canonical in STUDIO_QUEUE_TOOLS or canonical in _QUEUE_EXTRA_TOOLS:
        try:
            _live = set(getattr(mgr, "index", {}) or {})
        except Exception:
            _live = set()
        if name not in _live and canonical not in _live:
            if _queue_server_on[0]:
                if _queue_last_poll[0] <= 0:
                    _why = ("the Studio plugin was never seen polling - install it "
                            "(run install-plugin.bat), restart Studio fully, then in the "
                            "command bar run game:GetService(\"HttpService\").HttpEnabled = true")
                else:
                    _age = int(time.time() - _queue_last_poll[0])
                    _why = (f"the Studio plugin last polled {_age}s ago - it stopped "
                            f"(Studio closed or place changed?). Reopen Studio with a place loaded")
            else:
                _why = ("embedded queue not running - restart the bridge "
                        "(start.bat) so the Studio plugin has a queue to poll")
            return {"ok": False, "tool": name, "executionId": "rl_noplugin", "status": "error",
                    "durationMs": 0, "kind": "plugin_offline", "error_code": "PLUGIN_OFFLINE",
                    "error": _ai_readable_error("plugin_offline", _why, name),
                    "verification": {"checked": False}}
    if not mgr.any_alive():
        return {"ok": False, "error": _ai_readable_error("mcp_offline", "no MCP server alive", name), "kind": "mcp_offline"}
    # Studio usability check before calling studio tools
    NEEDS_STUDIO = set(STUDIO_ROUTED_TOOLS) | {"get_studio_state", "list_roblox_studios", "take_snapshot",
        "run_in_sandbox", "get_snapshot", "get_context_summary", "generate_terrain"}
    if name in NEEDS_STUDIO:
        st = probe_studio()
        if st.get("app") is False:
            return {"ok": False, "error": _ai_readable_error("studio_offline", "no Roblox Studio instance connected", name), "kind": "studio_offline"}
        if st.get("place") is False:
            # get_studio_state itself can still run to tell user; others need place
            if name not in ("get_studio_state","list_roblox_studios"):
                return {"ok": False, "error": _ai_readable_error("studio_offline", "Studio open but no place loaded — open a place", name), "kind": "studio_offline"}
    try:
        result = mgr.call(name, arguments, timeout)
        out = {"ok": True, "text": result["text"], "images": result["images"]}
        # Native Studio paths leak internal package prefixes (sabuiltin_*).
        # Scrub user-facing text the same way error paths already do.
        try:
            out["text"] = re.sub(r"sabuiltin_[^.\s]*\.", "", str(out.get("text") or ""))
        except Exception:
            pass
        # Provenance. For a namespaced addon the model asked for
        # "blender/get_scene_info" but upstream ran "get_scene_info"; carry the
        # EXACT upstream name plus the owning server so an image-carrying
        # result can be labelled with the tool that really ran (the extension's
        # image branch and its learned "this tool returns screenshots" memory
        # both key off the name), and so the bridge's own later errors can
        # quote a spelling upstream recognises.
        try:
            _prov = mgr.provenance(name)
        except Exception:
            _prov = None
        if _prov:
            out["tool"] = _prov["tool"]
            out["server"] = _prov["server"]
        return out
    except TimeoutError as e:
        raw = str(e)
        kind = "timeout"
        return {"ok": False, "error": _ai_readable_error(kind, raw, name), "kind": kind}
    except Exception as e:
        raw = str(e)
        # Race backstop for the routing above: liveness flipped mid-call and
        # Studio answered "unknown tool" for a registry name. Never surface
        # that raw - it reads as a model mistake instead of a missing plugin.
        if "unknown tool" in raw.lower() and (name in ROLINK_TOOL_NAMES
                or canonical in STUDIO_QUEUE_TOOLS or canonical in _QUEUE_EXTRA_TOOLS):
            return {"ok": False, "tool": name, "executionId": "rl_noplugin", "status": "error",
                    "durationMs": 0, "kind": "plugin_offline", "error_code": "PLUGIN_OFFLINE",
                    "error": _ai_readable_error("plugin_offline",
                        f"Studio answered 'unknown tool' for '{name}' - it only knows ~28 native "
                        "commands. Install the RoLink Studio plugin (run install-plugin.bat), "
                        "restart Studio fully, then retry", name),
                    "verification": {"checked": False}}
        kind = _classify_bridge_error(raw)
        return {"ok": False, "error": _ai_readable_error(kind, raw, name), "kind": kind}

def handle_call_tool(name, arguments, timeout):
    """Canonical bridge execution: validate → ensure alive → execute → normalize."""
    return safe_call(name, arguments, timeout)

async def run_tool_task(ws, name, args, timeout, rid):
    """Execute one tool off the socket read loop and send its result back.

    Kept as a standalone task (not awaited inline in handler) so a long tool
    never starves the connection's ability to answer app-level pings - see the
    call_tool branch in handler() for the full rationale."""
    t0 = time.monotonic()
    res = await asyncio.to_thread(safe_call, name, args, timeout)
    elapsed = time.monotonic() - t0
    tag = "gr" if res.get("ok") else "rd"
    summary = (res.get("text") or res.get("error") or "")[:80].replace("\n", " ")
    slow = "  [SLOW]" if elapsed > 5 else ""
    # Routine per-call traces are technical noise for a non-dev user watching
    # the console; they still land in bridge_debug.log. A failed/slow call
    # DOES surface on the terminal - that's the signal a user should notice.
    log(f"<- {name} ({elapsed:.1f}s){slow}: {summary}", tag, terminal=not res.get("ok") or elapsed > 5)
    if not res.get("ok"):
        # Same truncation problem as the confirm gate above: keep the full
        # error in the log file (capped) so a pasted terminal screenshot is
        # never the only record of what actually failed.
        try:
            log(f"[{name}] full error: {(res.get('error') or '')[:2000]}",
                "dim", terminal=False)
        except Exception:
            pass
    try:
        await ws.send(json.dumps({"type": "tool_result", "id": rid, **res}))
    except websockets.ConnectionClosed:
        pass


async def broadcast_status():
    """Push a fresh status snapshot to every currently-connected extension tab.

    Needed because the socket now starts listening (see _boot_and_diagnose in
    main()) before every MCP server has necessarily finished launching in the
    background - an extension that connects in that window gets an early,
    incomplete "connected" snapshot (e.g. an addon server not started yet).
    The extension's own periodic poll only reads a passively cached copy of
    the LAST message it received (background.js never re-probes on its own),
    so without a follow-up push that stale snapshot can persist forever (seen
    live 2026-07-11: Blender not yet alive at connect-time froze the "Start
    Roblox agent" button in its fully-disabled, non-degraded state even long
    after Blender was actually up). background.js already handles a second
    "connected" message arriving at any time (updates its cache and re-renders
    the bar), so re-sending this exact shape once startup truly settles is
    enough to self-correct with zero extension-side changes needed.
    """
    if not clients:
        return
    try:
        _st = await asyncio.to_thread(probe_studio)
        _proc = await asyncio.to_thread(_roblox_studio_app_running)
        payload = json.dumps({
            "type": "connected",
            "mcp_alive": mgr.any_alive(),
            "studio": _st["place"], "studio_app": _st["app"],
            # Whether a Roblox Studio WINDOW process exists at all - lets the
            # extension word the corrective step correctly ("open the MCP
            # panel in your already-open Studio" vs "launch Studio").
            "studio_proc": _proc,
            "servers": mgr.health(),
            "tools": mgr.list_tools(),
            "port": PORT,
            "catalog_total": len(ROLINK_TOOL_NAMES),
            "catalog_loaded": _CATALOG_OK,
            "plugin": {"alive": _plugin_alive(),
                       "version": _plugin_version[0] or None,
                       "stale": _queue_last_poll[0] > 0 and not _plugin_version[0],
                       "age_s": round(time.time() - _queue_last_poll[0], 1) if _queue_last_poll[0] > 0 else None},
        })
    except Exception:
        return
    for ws in list(clients):
        try:
            await ws.send(payload)
        except Exception:
            pass


async def handler(ws):
    peer = getattr(ws, "remote_address", ("?",))[0]
    clients.add(ws)
    log(f"extension connected  ({peer})  [{len(clients)} client(s)]", "gr")
    try:
        _st = await asyncio.to_thread(probe_studio)
        await ws.send(json.dumps({
            "type": "connected",
            "mcp_alive": mgr.any_alive(),
            "studio": _st["place"], "studio_app": _st["app"],
            "studio_proc": await asyncio.to_thread(_roblox_studio_app_running),
            "servers": mgr.health(),
            "tools": mgr.list_tools(),
            "port": PORT,
            "catalog_total": len(ROLINK_TOOL_NAMES),
            "catalog_loaded": _CATALOG_OK,
            "plugin": {"alive": _plugin_alive(),
                       "version": _plugin_version[0] or None,
                       "stale": _queue_last_poll[0] > 0 and not _plugin_version[0],
                       "age_s": round(time.time() - _queue_last_poll[0], 1) if _queue_last_poll[0] > 0 else None},
        }))
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            mtype = msg.get("type")
            rid = msg.get("id")

            if mtype == "ping":
                await ws.send(json.dumps({"type": "pong", "id": rid}))

            elif mtype == "studio_status":
                studio = await asyncio.to_thread(probe_studio)
                await ws.send(json.dumps({
                    "type": "studio_status", "id": rid,
                    "studio": studio["place"], "studio_app": studio["app"],
                    "studio_proc": await asyncio.to_thread(_roblox_studio_app_running),
                    "mcp_alive": mgr.any_alive(),
                }))

            elif mtype == "list_tools":
                try:
                    tools = await asyncio.to_thread(mgr.list_tools, True)
                except Exception as e:
                    tools = mgr.list_tools()
                    log(f"list_tools error: {e}", "yl")
                _st = await asyncio.to_thread(probe_studio)
                await ws.send(json.dumps({
                    "type": "tools", "id": rid,
                    "tools": tools, "mcp_alive": mgr.any_alive(),
                    "studio": _st["place"], "studio_app": _st["app"],
                    "studio_proc": await asyncio.to_thread(_roblox_studio_app_running),
                    "servers": mgr.health(),
                }))

            elif mtype == "call_tool":
                name = msg.get("name", "")
                args = msg.get("arguments") or {}
                timeout = float(msg.get("timeout", 120000)) / 1000.0
                log(f"-> tool  {name}({', '.join(args.keys())})", "cy", terminal=False)
                # Run the tool as a BACKGROUND task instead of awaiting it here.
                # Awaiting inline parks this read loop for the WHOLE tool call, so
                # a long tool (e.g. wait_job_finished > 25s) means the client's
                # app-level pings are never read/answered - its half-open-socket
                # watchdog then force-closes the connection and the in-flight call
                # is dropped as "bridge unreachable" (reported live). As a task,
                # the loop stays free to answer pings/status while the tool runs.
                # The extension only ever has ONE call_tool in flight (its agent
                # loop awaits each result before sending the next), so this never
                # overlaps tool executions.
                asyncio.create_task(run_tool_task(ws, name, args, timeout, rid))

            elif mtype == "list_mcp_servers":
                # The settings page's view of the config: exact spawn specs,
                # per-server health and the presets that are not installed yet.
                # Env VALUES are never included (see server_meta).
                try:
                    info = await asyncio.to_thread(list_mcp_servers)
                except Exception as e:
                    info = {"ok": False, "error": str(e), "servers": [], "presets": []}
                await ws.send(json.dumps({"type": "mcp_servers", "id": rid, **info}))

            elif mtype == "add_preset":
                # Opt-in only: this is the ONE path that writes a preset into
                # config.json, and it is reachable only from an explicit click
                # in the extension. Unlike add_server it does NOT restart the
                # whole process - dropping every live MCP child (including an
                # attached Studio session) to add one addon is a lot of
                # collateral. The new server is loaded in place and finishes
                # its handshake in the background; the process restart stays as
                # the fallback if the in-place load cannot find the entry.
                ok, err, info = await asyncio.to_thread(
                    config_add_preset,
                    msg.get("preset") or msg.get("preset_id"),
                    msg.get("server_id"), msg.get("env"))
                restarting = False
                if ok:
                    try:
                        _loaded, _lerr = await asyncio.to_thread(
                            mgr.install_server, info["server_id"])
                        restarting = not _loaded
                        if not _loaded:
                            err = _lerr or err
                    except Exception as e:
                        restarting = True
                        log(f"in-place preset load failed ({e}); restarting instead", "yl")
                ack = {
                    "type": "server_changed", "id": rid,
                    "ok": ok, "error": err, "restarting": restarting,
                    "servers": mgr.health(),
                }
                if ok and info:
                    ack.update({"server_id": info["server_id"], "preset": info["preset"],
                                "env_keys": info.get("env_keys") or [],
                                "available": info.get("available"),
                                "hint": info.get("hint") or ""})
                await ws.send(json.dumps(ack))
                if ok:
                    # Give the ack a beat to flush over the socket, then either
                    # restart (fallback) or push a fresh status so the freshly
                    # installed server shows up in the UI.
                    if restarting:
                        async def _do_restart():
                            await asyncio.sleep(0.4)
                            restart_self()
                        asyncio.create_task(_do_restart())
                    else:
                        async def _do_refresh():
                            await asyncio.sleep(1.5)
                            await broadcast_status()
                        asyncio.create_task(_do_refresh())

            elif mtype in ("add_server", "remove_server"):
                # Adding/removing an addon MCP server rewrites config.json, which
                # the bridge only reads at launch - so we ack, then restart the
                # whole process to pick it up cleanly. The primary Roblox server
                # is protected inside config_add/remove_server.
                if mtype == "add_server":
                    ok, err = await asyncio.to_thread(
                        config_add_server,
                        msg.get("server_id"), msg.get("command"),
                        msg.get("args"), msg.get("env"))
                else:
                    ok, err = await asyncio.to_thread(
                        config_remove_server, msg.get("server_id"))
                await ws.send(json.dumps({
                    "type": "server_changed", "id": rid,
                    "ok": ok, "error": err, "restarting": ok,
                }))
                if ok:
                    # Give the ack a beat to flush over the socket, then restart.
                    async def _do_restart():
                        await asyncio.sleep(0.4)
                        restart_self()
                    asyncio.create_task(_do_restart())

            elif mtype == "restart_mcp":
                sid = msg.get("server")
                try:
                    await asyncio.to_thread(mgr.restart, sid)
                    ok, err = True, None
                except Exception as e:
                    ok, err = False, str(e)
                await ws.send(json.dumps({
                    "type": "mcp_status", "id": rid,
                    "alive": mgr.any_alive(), "ok": ok, "error": err,
                    "servers": mgr.health(), "tools": mgr.list_tools(),
                }))

            else:
                await ws.send(json.dumps({
                    "type": "error", "id": rid,
                    "error": f"unknown message type: {mtype}",
                }))
    except websockets.ConnectionClosed:
        pass
    except Exception as e:
        log(f"handler error: {e}", "rd")
    finally:
        clients.discard(ws)
        log(f"extension disconnected  [{len(clients)} client(s)]", "yl")


async def server_watch():
    """Poll every MCP server and restart any that died unexpectedly (e.g. the
    StudioMCP proxy crashing on its own - see stop()'s taskkill /T fix and the
    stderr logging above for why this used to happen silently). Without this,
    a dead server only got noticed on the NEXT real tool call, which is what
    made "Studio looks connected but nothing responds" possible."""
    # Crash-LOOP detection thresholds: LOOP_N deaths within LOOP_WINDOW seconds
    # means something is killing (or instantly crashing) the server every time
    # we bring it back - the silent restart cycle the auto-restart otherwise
    # hides completely. We still keep restarting (the cause may be transient,
    # e.g. the user is about to start Blender), but the terminal now NAMES the
    # problem: exit code, the child's last stderr lines, and - for a port-bound
    # server - who is squatting the port. Banner re-prints at most every
    # LOOP_WARN_COOLDOWN so the terminal stays readable.
    LOOP_N = 3
    LOOP_WINDOW = 60
    LOOP_WARN_COOLDOWN = 120
    while True:
        await asyncio.sleep(5)
        for sid, client in list(mgr.clients.items()):
            try:
                if not client.is_alive():
                    now = time.time()
                    # restart_times holds RESTART ATTEMPTS (appended just before
                    # each start below), never per-poll sightings - appending on
                    # every 5s poll would keep the window full forever and the
                    # "slow down" branch would then block restarts permanently.
                    client.restart_times = [t for t in client.restart_times if now - t < LOOP_WINDOW]
                    looping = len(client.restart_times) >= LOOP_N
                    if looping and now - client.loop_warned_at > LOOP_WARN_COOLDOWN:
                        client.loop_warned_at = now
                        log(f"[{sid}] CRASH LOOP: died {len(client.restart_times)} times in the last "
                            f"{LOOP_WINDOW}s (last exit code: {client.last_exit}). Something is killing it "
                            f"or it cannot start.", "rd")
                        if client.start_error:
                            log(f"[{sid}] {client.start_error}", "rd")
                        elif client.stderr_tail:
                            log(f"[{sid}] last error output (usually the real reason):", "rd")
                            for ln in client.stderr_tail:
                                log(f"[{sid}]   {ln}", "yl")
                        else:
                            log(f"[{sid}] the server printed no error output before dying.", "yl")
                        # Port forensics: name the process squatting a port this
                        # server needs. For the primary Roblox proxy that is
                        # Studio's MCP port; a squatter there (seen live: a
                        # 'ropilot' app) makes the proxy die/misbehave forever.
                        if sid == "roblox":
                            owner = _port_owner(STUDIO_MCP_PORT)
                            if owner:
                                pid, name, path = owner
                                if "roblox" not in (name or "").lower() and "studio" not in (path or "").lower():
                                    log(f"[{sid}] port {STUDIO_MCP_PORT} is held by '{name}' (pid {pid}, {path}) - "
                                        f"close that program, it is squatting Studio's MCP port.", "rd")
                        log(f"[{sid}] common causes: its app is not running (e.g. Blender + addon), a port "
                            f"conflict, an antivirus killing it, or a bad command in config.json. "
                            f"Auto-restart continues in the background.", "yl")
                    if looping and client.restart_times and now - client.restart_times[-1] < 15:
                        # Clearly hopeless right now: drop to a ~15s cadence so a
                        # broken command isn't hammer-spawned every 5 seconds,
                        # while still retrying forever (the cause may clear, e.g.
                        # the user finally opens Blender).
                        continue
                    client.restart_times.append(now)
                    log(f"[{sid}] found dead - auto-restarting...", "yl")
                    await asyncio.to_thread(client.start)
                    mgr.rebuild_index()
                    await broadcast_status()  # tell any connected extension right away
            except Exception as e:
                log(f"[{sid}] auto-restart failed: {e}", "rd")


def _current_studio_exe():
    """The StudioMCP.exe our launcher would currently pick (newest version
    folder paired with a real RobloxStudioBeta.exe), or None. Reused here only
    to detect a Studio update happening mid-session: Roblox's own bug report
    ("Studio MCP turning off after update") says the toggle resets to OFF
    whenever Studio auto-updates - restarting our proxy can't fix that (Studio
    itself refuses the connection while its toggle is off), so the terminal
    should say "re-enable the toggle" instead of "wait for auto-recovery"
    when a version bump coincides with the disconnect."""
    if _studio_scan is None:
        return None
    try:
        return _studio_scan.find_studio_mcp()
    except Exception:
        return None


async def studio_watch(initial_app, initial_place=None):
    """Poll Studio attachment and log transitions, so the terminal confirms in
    GREEN the moment Studio attaches (e.g. after the user toggles its MCP server)
    and warns again if it later drops. Best-effort; never raises.

    Also auto-recovers from a real disconnect: two bugs reported on the Roblox
    devforum leave StudioMCP.exe alive (our client stays "alive" - the process
    never dies, so server_watch's dead-process restart never fires) but stuck
    talking to nothing - (1) StudioMCP keeps a stale named-pipe handle keyed by
    Studio's old PID after Studio is closed and reopened, and never rediscovers
    the new one; (2) MCP silently disconnects every 5-15 minutes on some
    machines. The documented user workaround for both is "toggle Studio's MCP
    server off/on" / "reopen the MCP panel" - which just forces StudioMCP to
    redo its handshake. Restarting OUR proxy process is the equivalent from
    this side (taskkill + fresh launch_studio_mcp.py), so do it automatically
    once a drop looks real (sustained, not a momentary blip) instead of leaving
    the user to notice and toggle it themselves."""
    prev_app = initial_app
    prev_place = initial_place
    disconnected_since = None
    last_auto_restart = 0.0
    empty_since = None       # when the roblox catalogue was first seen empty
    last_reclaim = 0.0       # cooldown for the zombie-StudioMCP port reclaim
    place_transitions = []
    known_studio_exe = await asyncio.to_thread(_current_studio_exe)
    update_suspected = False
    # Only auto-restart a disconnect that follows a real connection (matches
    # the two known bugs above) - never spam-restart while Studio simply isn't
    # open yet at all (prev_app starting False/None is the common cold-start
    # case and restarting there would just be noise every cooldown).
    ever_connected = initial_app is True
    while True:
        await asyncio.sleep(4)
        # If StudioMCP launched while Studio was closed, its catalogue is EMPTY
        # and stays that way: start()'s 12s retry loop has long given up, and
        # nothing else ever re-asks for tools/list (probe_studio can't - the
        # probe tools themselves are part of the missing catalogue, which is
        # why it short-circuits to "not connected" on an empty cache). So a
        # Studio opened AFTER that window was never detected until the user
        # restarted the whole bridge (seen live 2026-07-11). Re-ask here on
        # every poll while the catalogue is empty; the moment Studio attaches,
        # tools appear, the index rebuilds, and the normal probe below flips
        # the state to connected on this same iteration.
        rc0 = mgr.clients.get("roblox")
        if rc0 is not None and rc0.is_alive() and not rc0.tools_cache:
            got = False
            try:
                got = bool(await asyncio.to_thread(rc0.refresh_tools, 3))
            except Exception:
                got = False
            if got:
                mgr.rebuild_index()
                log(f"Roblox Studio's tools appeared ({len(rc0.tools_cache)}) - Studio attached.", "gr")
                empty_since = None
            else:
                now0 = time.time()
                if empty_since is None:
                    empty_since = now0
                # First: a PROVEN port hijack (stderr showed StudioMCP talking to
                # a foreign host, e.g. ropilot). Hard evidence, so recover fast
                # and unconditionally - no need to wait out the sustained-empty
                # window the ambiguous zombie case below uses.
                if (rc0.saw_foreign_ws_host and now0 - last_reclaim > 180):
                    last_reclaim = now0
                    killed, sname = await asyncio.to_thread(_kill_port_squatter)
                    if killed:
                        try:
                            await asyncio.to_thread(mgr.restart, "roblox")
                        except Exception as e:
                            log(f"roblox proxy restart after squatter kill failed: {e}", "rd")
                        _print_squatter_hint(sname)
                        await broadcast_status()
                # Otherwise: catalogue stuck empty WITH a Studio window open often
                # means a zombie StudioMCP.exe (not ours) still owns port 13469 and
                # swallowed Studio's one-shot registration - a state no manual
                # restart combination can escape (see _reclaim_studio_port).
                # Sustained-empty threshold + cooldown so a Studio that is
                # merely slow to boot never triggers a spurious kill.
                elif (now0 - empty_since > 20 and now0 - last_reclaim > 180
                        and await asyncio.to_thread(_roblox_studio_app_running) is True):
                    last_reclaim = now0
                    if await asyncio.to_thread(_reclaim_studio_port, rc0):
                        try:
                            await asyncio.to_thread(mgr.restart, "roblox")
                        except Exception as e:
                            log(f"roblox proxy restart after zombie kill failed: {e}", "rd")
                        _print_reregister_hint()
                        await broadcast_status()
        else:
            empty_since = None
        try:
            st = await asyncio.to_thread(probe_studio)
        except Exception:
            continue
        app, place = st["app"], st["place"]
        if app is not None and app != prev_app:
            if app is True:
                # Roblox-only count, not mgr.list_tools() (sums every server,
                # e.g. + Blender) - this message is specifically about Roblox
                # attaching, so it must not borrow addon tool counts (same
                # class of bug as the startup banner, see roblox_total above).
                rc = mgr.clients.get("roblox")
                roblox_now = len(rc.tools_cache) if rc else 0
                log(f"Roblox Studio connected - {roblox_now} native tools "
                    f"(+ {len(ROLINK_TOOL_NAMES)} RoLink catalog tools via the Studio plugin).", "gr")
                ever_connected = True
                disconnected_since = None
                update_suspected = False
            else:
                cur_exe = await asyncio.to_thread(_current_studio_exe)
                if cur_exe and known_studio_exe and cur_exe != known_studio_exe:
                    # A newer Studio version folder appeared since we last saw
                    # one - restarting the proxy will NOT fix this (Studio
                    # itself refuses the MCP connection while its own toggle
                    # is off), so tell the user the actual fix instead of
                    # letting the generic auto-recovery below spin uselessly.
                    ver = os.path.basename(os.path.dirname(cur_exe))
                    log(f"Roblox Studio appears to have UPDATED (new version: {ver}). "
                        "Studio often turns its MCP toggle back OFF after an update - open "
                        "Roblox Studio > Assistant Settings > MCP Servers and re-enable "
                        "'Enable Studio as MCP server'.", "yl")
                    update_suspected = True
                else:
                    log("Roblox Studio disconnected - re-enable its MCP server (toggle off/on).", "yl")
                    update_suspected = False
                known_studio_exe = cur_exe or known_studio_exe
                if ever_connected and disconnected_since is None:
                    disconnected_since = time.time()
            prev_app = app
            # studio_watch only used to LOG transitions - an extension sitting
            # on the pre-start standby screen (no tool calls happening, so
            # nothing else round-trips to the bridge) never saw Studio connect
            # or disconnect mid-session until it happened to poll for an
            # unrelated reason. Push it immediately instead of leaving that
            # extension staring at a stale snapshot indefinitely.
            await broadcast_status()
        # Set once per iteration: BOTH the app-drop branch and the place-churn
        # block below use it. It used to be assigned only inside the app-drop
        # branch, so any iteration that skipped that branch crashed the whole
        # watcher with UnboundLocalError on the churn line (seen live: the task
        # died right after a successful reconnect, silently ending ALL Studio
        # monitoring and status broadcasts until the bridge was restarted).
        now = time.time()
        if app is False and ever_connected and disconnected_since is not None and not update_suspected:
            # ~20s sustained (5 polls) before treating it as a real drop, not a
            # momentary blip; 90s cooldown between recovery attempts so a
            # Studio that is genuinely closed for a while doesn't get hammered.
            # Skipped entirely when a version bump was the likely cause (see
            # above) - restarting our proxy cannot flip Studio's own toggle
            # back on, so retrying would just be noise every 90s.
            if now - disconnected_since > 20 and now - last_auto_restart > 90:
                last_auto_restart = now
                # Which recovery applies depends on whether a Studio WINDOW is
                # actually running (validated live 2026-07-11, both directions):
                #  - Studio RUNNING but not attached: Studio's MCP plugin only
                #    registers ONCE, at Studio boot or on a toggle flip. It
                #    never retries by itself, and restarting OUR proxy cannot
                #    reach into Studio to re-register it - worse, a restart
                #    that lands while Studio is booting kills the listener at
                #    the exact moment the plugin makes its single attempt,
                #    which is precisely how this state got created. So: do NOT
                #    touch the proxy; tell the user the one action that works.
                #  - No Studio running: a restart is safe (nothing to collide
                #    with) and clears genuinely stuck/stale proxy state.
                if await asyncio.to_thread(_roblox_studio_app_running) is True:
                    log("Roblox Studio is RUNNING but its MCP plugin has not registered with the "
                        "bridge yet.", "yl")
                    log("If Studio is still STARTING UP, give it a minute (its plugin registers "
                        "late in boot).", "yl")
                    log("If Studio is fully loaded and this stays yellow: in Roblox Studio, simply "
                        "OPEN Assistant Settings > MCP Servers - opening that panel makes the "
                        "plugin re-register (validated twice live). If that's not enough, toggle "
                        "'Enable Studio as MCP server' OFF then ON there.", "yl")
                else:
                    log("Roblox Studio proxy looks stuck (known StudioMCP disconnect bug) - "
                        "restarting it to recover.", "yl")
                    try:
                        await asyncio.to_thread(mgr.restart, "roblox")
                        await broadcast_status()
                    except Exception as e:
                        log(f"auto-restart of roblox proxy failed: {e}", "rd")
        # PLACE-level churn: `app` can stay stuck reporting True the whole time
        # (seen live 2026-07-11 - Studio fully closed, list_roblox_studios kept
        # answering with a leftover studio entry for 4+ minutes, so the app-drop
        # trigger above never fires) while `place` flip-flops "loaded"/"closed"
        # every ~10-20s forever. That is not a user opening/closing places that
        # fast - it is the same class of stuck-proxy bug, just visible at the
        # place layer instead of the app layer. A fresh StudioMCP.exe process
        # cannot carry over stale cached state, so the same restart applies.
        place_transitions[:] = [t for t in place_transitions if now - t < 90]
        if len(place_transitions) >= 4 and now - last_auto_restart > 90:
            # Same running-Studio guard as the app-drop recovery above: with a
            # real Studio window up, a proxy restart can only collide with the
            # plugin's one-shot registration; the churn is Studio-side state.
            if await asyncio.to_thread(_roblox_studio_app_running) is not True:
                last_auto_restart = now
                log(f"Roblox Studio's place status flipped {len(place_transitions)} times in the last "
                    "90s (known StudioMCP stuck-proxy bug) - restarting the proxy to recover.", "yl")
                try:
                    await asyncio.to_thread(mgr.restart, "roblox")
                    await broadcast_status()
                except Exception as e:
                    log(f"auto-restart of roblox proxy failed: {e}", "rd")
                place_transitions.clear()
        if place is not None and place != prev_place:
            # Debounce: StudioMCP's binding to Studio blips every few seconds
            # on some machines (self-healing in ~1-4s - seen live as "Bound
            # studio ... disconnected" stderr). A probe landing in that window
            # can misread EITHER direction - most confusingly, reporting
            # "place loaded" from a stale cached response while the place is
            # actually still closed (seen live). Recheck once before trusting
            # a transition, in either direction.
            await asyncio.sleep(1.2)
            try:
                confirm = (await asyncio.to_thread(probe_studio))["place"]
            except Exception:
                confirm = None
            if confirm is None or confirm != place:
                continue  # didn't hold up on recheck - treat as noise, not a real change
            if place is True:
                log("Place loaded in Studio.", "gr")
            else:
                log("Place closed (Studio app still connected).", "yl")
            prev_place = place
            place_transitions.append(time.time())
            await broadcast_status()


async def _supervised(name, coro_factory):
    """Run a watcher coroutine forever, restarting it if it ever raises.

    Both watchers are designed to never raise, but one line proved that wrong
    in practice (an UnboundLocalError killed studio_watch SILENTLY - asyncio
    only prints 'Task exception was never retrieved' at shutdown, so all
    Studio monitoring and status broadcasts just stopped until the user
    restarted the bridge). A crash in a watcher must never be silent or
    permanent: log it loudly, wait a beat, start a fresh instance.
    """
    while True:
        try:
            await coro_factory()
            return  # normal completion (doesn't happen today, but respect it)
        except Exception as e:
            log(f"{name} crashed: {type(e).__name__}: {e} - restarting it in 5s "
                f"(please report this).", "rd")
            await asyncio.sleep(5)


# ══════════════════════════════════════════════════════════════════════════
#  EMBEDDED STUDIO QUEUE  (third-party MCP path, :3001)
#  The Studio plugin (studio-plugin/RoLink.lua) polls GET /queue/next and
#  POSTs /queue/result. Endpoint shapes mirror mcp-server's queue API so the
#  plugin works against either server. Pure stdlib: no Node needed. If :3001
#  is already taken, this disables itself loudly instead of fighting.
# ══════════════════════════════════════════════════════════════════════════
QUEUE_PORT = int(os.environ.get("ROLINK_QUEUE_PORT", "3001"))
_queue_cmds = {}  # id -> {id, tool, command, args, projectId, status, result, error, event, created}
_queue_lock = threading.Lock()
_queue_seq = [0]
_queue_last_poll = [0.0]
_queue_server_on = [False]
# Version handshake: the plugin sends ?pv= with every poll. A mismatch means
# bridge and plugin came from different zips - the #1 cause of mystery
# failures (old plugin + new bridge or vice versa).
_plugin_version = [""]
# Set the first time a poll arrives WITHOUT ?pv=: that plugin predates the
# 2.1.5 handshake, so version-mismatch logic can never see it. Warn loudly
# instead of letting it fail cryptically.
_plugin_stale_warned = [False]
# Circuit breaker: consecutive queue timeouts fail fast until a FRESH poll
# (newer than the last timeout) or a success resets the count.
_queue_consec_timeouts = [0]
_queue_last_timeout = [0.0]
# Claim expiry: a poller that takes a command but never reports (crashed /
# duplicate copy) must not wedge the queue for a minute.
_CLAIM_TIMEOUT_S = 25.0


def _queue_new_id():
    # Execution id — the ONLY correlation the AI sees (rl_*). Queue id and
    # execution id are identical so Studio logs, bridge logs and AI chips agree.
    with _queue_lock:
        _queue_seq[0] += 1
        import random as _rnd
        return f"rl_{int(time.time() * 1000) % 1000000:06d}_{_rnd.randrange(36**4, 36**5):04x}"


def _make_envelope(tool, cid, status, t0, result=None, code=None, message=None):
    """Terminal ExecutionEnvelope dict. Always includes ok/text for back-compat."""
    dur = int((time.time() - t0) * 1000)
    if status == "success":
        text = result if isinstance(result, str) else json.dumps(result, default=str)
        return {"ok": True, "tool": tool, "executionId": cid, "status": "success",
                "durationMs": dur, "text": (text or "")[:12000], "images": [],
                "verification": {"checked": False}}
    kind = "timeout" if status == "timeout" else ("plugin_offline" if code == "PLUGIN_OFFLINE" else "execution_error")
    if code == "STUCK_EXECUTION":
        kind = "stuck-execution"
    return {"ok": False, "tool": tool, "executionId": cid, "status": status,
            "durationMs": dur, "kind": kind,
            "error": _ai_readable_error(kind if kind != "execution_error" else "execution_error",
                                       f"[{code}] {message}" if code else str(message), tool),
            "error_code": code or "STUDIO_EXECUTION_FAILED"}


def queue_enqueue(tool, command, args, projectId="default"):
    cid = _queue_new_id()
    with _queue_lock:
        # Hygiene: drop long-settled commands so a long session never degrades
        # (dict scans + memory stay flat).
        try:
            now = time.time()
            for k in [k for k, c in _queue_cmds.items()
                      if c.get("status") in ("done", "failed") and now - c.get("created", now) > 300]:
                _queue_cmds.pop(k, None)
            while len(_queue_cmds) > 500:
                _queue_cmds.pop(next(iter(_queue_cmds)), None)
        except Exception:
            pass
        _queue_cmds[cid] = {
            "id": cid, "tool": tool, "command": command,
            "args": args if isinstance(args, dict) else {},
            "projectId": projectId or "default",
            "status": "queued", "result": None, "error": None,
            "event": threading.Event(), "created": time.time(),
        }
    return cid


def queue_take(projectId=None):
    now = time.time()
    with _queue_lock:
        # Single-flight: never hand out a second command while one claim is
        # unexpired. Overlapping claims produced the 2 in_flight stall (both
        # holding the plugin, neither reporting). The plugin also guards with
        # __RL_BUSY; this is the server-side backstop.
        for c in _queue_cmds.values():
            if c.get("status") == "claimed" and now - c.get("claimed_at", 0) < _CLAIM_TIMEOUT_S:
                return None
        for cid, cmd in _queue_cmds.items():
            # Terminal states never re-queue: a failed command re-claimed here
            # would execute again on every poll (infinite error loop that also
            # starves every command behind it — seen live with atomic batches).
            if cmd["status"] in ("done", "failed"):
                continue
            if projectId and cmd.get("projectId") not in (None, projectId):
                continue
            if cmd["status"] == "claimed" and now - cmd.get("claimed_at", 0) < _CLAIM_TIMEOUT_S:
                continue
            cmd["status"] = "claimed"
            cmd["claimed_at"] = now
            return {k: cmd[k] for k in ("id", "tool", "command", "args", "projectId")}
    return None


def queue_complete(cid, result, error, timings=None):
    with _queue_lock:
        cmd = _queue_cmds.get(cid)
        if cmd is None:
            return False
        if cmd.get("status") in ("done", "failed"):
            try:
                log(f"[queue] late result for {cid} (already settled, dropped)", "dim", terminal=False)
            except Exception:
                pass
            return True  # already settled (e.g. client timeout cancelled it)
        cmd["status"] = "failed" if error else "done"
        cmd["result"] = result
        cmd["error"] = error
        try:
            el = (timings or {}).get("elapsed")
            cmd["elapsed"] = float(el) if el is not None else None
        except Exception:
            cmd["elapsed"] = None
        try:
            cmd["event"].set()
        except Exception:
            pass
    return True


def queue_wait(cid, timeout_s):
    with _queue_lock:
        cmd = _queue_cmds.get(cid)
        if cmd is None:
            return None, "unknown command id"
        ev = cmd["event"]
    if not ev.wait(timeout=max(0.1, float(timeout_s or 30))):
        return None, "timeout waiting for plugin result"
    with _queue_lock:
        cmd = _queue_cmds.get(cid)
    if cmd is None:
        return None, "unknown command id"
    return cmd.get("result"), cmd.get("error")


def queue_cancel(cid, reason="client timeout - superseded"):
    """Retire a command so it can never execute late (no ghost replay) and
    never block fresher work. Returns True if it was still pending."""
    with _queue_lock:
        cmd = _queue_cmds.get(cid)
        if cmd is None or cmd.get("status") == "done":
            return False
        cmd["status"] = "done"
        cmd["error"] = reason
        try:
            cmd["event"].set()
        except Exception:
            pass
    return True


def _plugin_alive():
    return (time.time() - _queue_last_poll[0]) < 30.0


class _QueueHandler(__import__("http.server", fromlist=["BaseHTTPRequestHandler"]).BaseHTTPRequestHandler):
    server_version = "RoLinkQueue/2.1"

    def log_message(self, *a):
        pass

    def _send(self, obj, code=200):
        try:
            body = json.dumps(obj).encode("utf-8")
        except Exception:
            body = b'{"ok": false, "error": "serialize failed"}'
            code = 500
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def _body(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except Exception:
            n = 0
        if n <= 0 or n > 10 * 1024 * 1024:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8", "replace"))
        except Exception:
            return {}

    def do_GET(self):
        from urllib.parse import urlparse, parse_qs
        u = urlparse(self.path)
        qs = parse_qs(u.query or "")
        if u.path == "/health":
            self._send({"ok": True, "service": "rolink-queue",
                        "tools": len(ROLINK_TOOL_NAMES), "plugin": _plugin_alive()})
        elif u.path == "/queue/next":
            _queue_last_poll[0] = time.time()
            _pv = (qs.get("pv") or [""])[0]
            if _pv and _pv != _plugin_version[0]:
                _plugin_version[0] = _pv
                if _pv != BRIDGE_VERSION:
                    log(f"VERSION MISMATCH: Studio plugin v{_pv} talking to bridge v{BRIDGE_VERSION} - "
                        f"update both from the same release zip or expect strange failures.", "yl")
                else:
                    log(f"Studio plugin v{_pv} connected.", "gr", terminal=False)
            elif not _pv and not _plugin_stale_warned[0]:
                # A poll with no version at all: plugin predates the handshake
                # (older than 2.1.5). It will fail in confusing ways - say so now.
                _plugin_stale_warned[0] = True
                action_banner([
                    "Your Studio plugin is OUTDATED (no version reported).",
                    "Re-run install-plugin.bat, FULLY quit Studio, reopen it.",
                    "Studio Output must print the NEW version on load.",
                ])
            pid = (qs.get("projectId") or ["default"])[0]
            self._send({"ok": True, "command": queue_take(pid),
                        "bridge_version": BRIDGE_VERSION})
        elif u.path == "/queue/status":
            with _queue_lock:
                vals = list(_queue_cmds.values())
            self._send({"ok": True,
                        "depth": sum(1 for c in vals if c["status"] == "queued"),
                        "claimed": sum(1 for c in vals if c["status"] == "claimed"),
                        "done": sum(1 for c in vals if c["status"] == "done"),
                        "failed": sum(1 for c in vals if c["status"] == "failed"),
                        "total": len(vals)})
        else:
            self._send({"ok": False, "error": "not found"}, 404)

    def do_POST(self):
        data = self._body()
        if self.path == "/queue/result":
            cid = data.get("id")
            if not cid:
                self._send({"ok": False, "error": "id required"}, 400)
            elif queue_complete(cid, data.get("result"), data.get("error"),
                                data.get("timings") if isinstance(data.get("timings"), dict) else None):
                self._send({"ok": True})
            else:
                self._send({"ok": False, "error": "not found"}, 404)
        elif self.path == "/queue/enqueue":
            body = data if isinstance(data, dict) else {}
            cid = queue_enqueue(body.get("tool", ""), body.get("command", ""),
                                body.get("args", {}), body.get("projectId", "default"))
            self._send({"ok": True, "id": cid})
        elif self.path == "/metrics":
            self._send({"ok": True})
        else:
            self._send({"ok": False, "error": "not found"}, 404)


def start_queue_server():
    """Bind :3001 in a daemon thread. Returns True when WE own the port."""
    try:
        from http.server import ThreadingHTTPServer
        srv = ThreadingHTTPServer(("127.0.0.1", QUEUE_PORT), _QueueHandler)
    except OSError as e:
        log(f"queue port {QUEUE_PORT} busy ({e}) - embedded Studio queue disabled; "
            f"the Studio plugin needs a queue on :{QUEUE_PORT} (start mcp-server or free the port).", "yl")
        return False
    t = threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 0.2}, daemon=True)
    t.start()
    _queue_server_on[0] = True
    log(f"Studio queue listening on http://127.0.0.1:{QUEUE_PORT} (plugin polls /queue/next)", "cy")
    return True


# Studio-native spellings the model may use -> canonical registry names.
# Applied ONLY to decide the plugin-queue route; the StudioMCP path below
# always keeps the ORIGINAL name (so list_commands and friends never break).
_TOOL_ALIASES = {
    "run_code": "execute_luau",
    "get_snapshot": "take_snapshot",
    "set_property": "set_properties",
    "get_logs": "export_session_log",
    "perf_stats": "get_performance_stats",
    "translate_code": "validate_command",
    "validate_code": "validate_command",
    "run_sandbox_tests": "run_in_sandbox",
    "run_sandbox_tests": "run_in_sandbox",
    "plan": "plan_game",
    "get_context": "get_context_summary",
    "use_template": "apply_template",
    "create_template": "add_template",
    "style_profile": "train_model",
    "personalize_code": "train_model",
    "generate_tests": "generate_test",
    "search_assets": "search_asset",
    "generate_gdd": "plan_game",
    "compile_visual": "compile_visual_graph",
    "analytics_report": "report_analytics",
    "analytics_suggestions": "suggest_design",
    "collab_join": "session_users",
    "collab_list": "session_users",
    "collab_broadcast": "session_users",
    "get_instance_tree": "get_instances",
    "search_scripts": "script_search",
    "inspect_instance": "get_instances",
    "heal_code": "refactor_code",
    "rollback_list": "rollback",
}

# Registry tools executed IN Studio via the queue (everything except the
# bridge-local handlers and batch fan-out, which never leave this process).
STUDIO_QUEUE_TOOLS = frozenset(
    [t for t in ROLINK_TOOL_NAMES if t and t not in LOCAL_HANDLERS and t != "batch_queue"]
)

# Native plugin tools that live OUTSIDE the 140 registry (real search
# implementations, not aliases): routed + advertised exactly like registry
# tools, so the registry file and all 140-counts stay untouched.
_QUEUE_EXTRA_TOOLS = frozenset(("script_search", "script_grep", "search_game_tree", "inspect_keyframe_track"))
_QUEUE_EXTRA_DESC = {
    "script_search": ("Tool. Full-text search across Script/ModuleScript/LocalScript "
                      "sources. Args: pattern* (or query/keyword), path?/scope?, limit? (default 20)."),
    "script_grep": ("Tool. Line-oriented content search like script_search. "
                    "Args: pattern* (or query/keyword), path?/scope?, limit?."),
    "search_game_tree": ("Tool. Find instances by name (default), class, or attribute. "
                         "Args: query*, searchType? (name/class/attribute), mode?."),
    "inspect_keyframe_track": ("Tool. Numeric KeyframeSequence dump: every keyframe time plus pose "
                               "position (studs) and rotation (degrees). Args: path* "
                               "(e.g. Workspace/RoLinkAnimations/M1). Use instead of "
                               "export_animation_clip for motion verification."),
}
_PLUGIN_STATUS_DESC = ("Tool. Instant in-Studio plugin health "
                       "(queue up, polling, version, pending). Call FIRST when "
                       "a Studio command fails - never hammer a failing call.")
_LOCAL_EXTRA_DESC = {
    "get_studio_state": ("Tool. Aggregated Studio truth: connectivity, place, playState "
                         "(edit/play), current Selection, plugin/bridge versions, pending tasks. "
                         "Ask this when reasoning about reality - never assume. No args except projectId?."),
    "search_asset": ("Tool. LIVE Roblox Creator Store / Library search (bridge-side, no Studio "
                     "needed). Args: keyword* (also query/q), limit? 1-20 default 8, category? "
                     "Model|MeshPart|Decal|Audio|Plugin|Video|FontFamily. Returns "
                     "{assets:[{id,name,description,creator,assetType,url,hasScripts?,scriptCount?,isFree?,priceCents?}], source} - "
                     "REAL: inspect access/script metadata, then import with import_asset{assetId}; executable sources are stripped. Never invent an asset id."),
    "get_memory": ("Tool. Structured project memory: one section (architecture, services, "
                   "remotes, instances, conventions, ui, dependencies, bugs, tasks, decisions) "
                   "or a table of contents. Pull only the section the task needs."),
    "update_memory": ("Tool. Write project memory: section*, content* (max 20000 chars), "
                      "mode replace|append. Record architecture, decisions, bugs, conventions as you learn them."),
}


def _local_tool_entry(name):
    """Advertised form of a catalog/extra/built-in tool (server "local").
    Returns None for names we do not own. Single source of truth for both
    the padding below and the single-ownership override."""
    if name == "plugin_status":
        return {"name": name, "description": _PLUGIN_STATUS_DESC, "server": "local"}
    if name in _LOCAL_EXTRA_DESC:
        return {"name": name, "description": _LOCAL_EXTRA_DESC[name], "server": "local"}
    if name in _QUEUE_EXTRA_TOOLS:
        return {"name": name, "description": _QUEUE_EXTRA_DESC.get(name, "RoLink tool"),
                "server": "local"}
    if name in ROLINK_TOOL_NAMES:
        _p = TOOL_PROMPTS.get(name, {}) if isinstance(TOOL_PROMPTS, dict) else {}
        _desc = (_p.get("args_guide") or "").strip()
        _desc = ("Tool. " + _desc)[:600] if _desc else "RoLink local/studio tool"
        return {"name": name, "description": _desc, "server": "local"}
    return None


def _queue_call(name, args, timeout):
    """Enqueue for the Studio plugin and wait. Never raises. Always terminal envelope."""
    if not _queue_server_on[0]:
        return {"ok": False, "tool": name, "executionId": "rl_noqueue", "status": "error",
                "durationMs": 0, "kind": "plugin_offline", "error_code": "PLUGIN_OFFLINE",
                "error": _ai_readable_error("plugin_offline", "embedded queue not running", name),
                "verification": {"checked": False}}
    if not _plugin_alive():
        if _queue_last_poll[0] <= 0:
            _why = ("the Studio plugin was never seen polling - install it "
                    "(run install-plugin.bat), restart Studio fully, then in the "
                    "command bar run game:GetService(\"HttpService\").HttpEnabled = true")
        else:
            _age = int(time.time() - _queue_last_poll[0])
            _why = (f"the Studio plugin last polled {_age}s ago - it stopped "
                    f"(Studio closed or place changed?). Reopen Studio with a place loaded")
        return {"ok": False, "tool": name, "executionId": "rl_noplugin", "status": "error",
                "durationMs": 0, "kind": "plugin_offline", "error_code": "PLUGIN_OFFLINE",
                "error": _ai_readable_error("plugin_offline", _why, name),
                "verification": {"checked": False}}
    project = (args.get("projectId", "default") if isinstance(args, dict) else "default") or "default"
    # Large script writes hang the plugin recompile: fail fast with a chunk
    # hint instead of burning a 60s queue timeout (WaveSystem stall).
    if name == "set_script_content" and isinstance((args or {}).get("content"), str):
        _n = len(args["content"])
        if _n > 100000:
            return {"ok": False, "tool": name, "executionId": "rl_rejected", "status": "error",
                    "durationMs": 0, "kind": "validation_error", "error_code": "VALIDATION",
                    "error": _ai_readable_error("validation_error", f"content too large ({_n} chars, max 100000) - split into smaller writes", name),
                    "verification": {"checked": False}}
    # Code-carrying tools: the plugin runs cmd.command as Luau (Node's
    # convention), so the code itself must travel as the command payload -
    # sending the tool name would "succeed" without running anything.
    _CODE_FIELDS = {"execute_luau": "code", "run_in_sandbox": "code",
                    "refactor_code": "code"}
    _cf = _CODE_FIELDS.get(name)
    _payload = args.get(_cf) if (_cf and isinstance(args.get(_cf), str)) else name
    # Studio ops are local and fast: cap the wait well under the extension's
    # 120s budget so a dead poller fails in a minute, not two.
    _wait = max(1.0, min(float(timeout or 30), 60.0))
    cid = queue_enqueue(name, _payload, args, project)
    t0 = time.time()
    log(f"[{name}] queued for Studio plugin ({cid})", "cy", terminal=False)
    result, err = queue_wait(cid, _wait)
    if err == "timeout waiting for plugin result":
        _queue_consec_timeouts[0] += 1
        _queue_last_timeout[0] = time.time()
        queue_cancel(cid)
        try:
            with _queue_lock:
                _vals = list(_queue_cmds.values())
            _pend = sum(1 for c in _vals if c.get("status") in ("queued", "claimed"))
            _ages = [time.time() - c.get("claimed_at", time.time())
                     for c in _vals if c.get("status") == "claimed" and c.get("claimed_at")]
            _oldest = f", oldest claim {_ages and max(_ages):.0f}s" if _ages else ""
            _flight = [f"{c.get('tool', '?')}" for c in _vals if c.get("status") == "claimed"]
            _tools = f", in_flight: {', '.join(_flight[:3])}" if _flight else ""
            _snap = f" (queue: {_pend} pending{_oldest}{_tools})"
        except Exception:
            _snap = ""
        # Plugin still polling but a claim never resolved = hung execution,
        # not a missing install. Keep plugin_offline only for dead pollers.
        # Terminal envelope: the AI must NEVER treat this as success.
        if _plugin_alive():
            env = _make_envelope(name, cid, "timeout", t0, code="STUCK_EXECUTION",
                                 message=f"no plugin answer in {_wait:.0f}s{_snap}")
            env["kind"] = "stuck-execution"
            return env
        env = _make_envelope(name, cid, "timeout", t0, code="PLUGIN_OFFLINE",
                             message=f"no plugin answer in {_wait:.0f}s{_snap}")
        env["kind"] = "plugin_offline"
        return env
    _queue_consec_timeouts[0] = 0
    if err:
        return _make_envelope(name, cid, "error", t0, code="STUDIO_EXECUTION_FAILED", message=str(err))
    with _queue_lock:
        _el = (_queue_cmds.get(cid) or {}).get("elapsed")
    if _el is not None:
        log(f"[{name}] plugin executed in {_el:.2f}s", "dim", terminal=False)
    return _make_envelope(name, cid, "success", t0, result=result)


async def main():
    print(f"\n{C['cy']}  RoLink Bridge v{BRIDGE_VERSION}{C['reset']}  {C['dim']}- Roblox Studio - ws://{HOST}:{PORT}{C['reset']}\n")
    log(f"===== BRIDGE START  v{BRIDGE_VERSION}  pid={os.getpid()}  log={LOG_PATH} =====", "cy")
    if _CATALOG_OK:
        log(f"tool catalog: {len(ROLINK_TOOL_NAMES)} extended tools loaded", "gr")
    else:
        action_banner([
            "The 140-tool catalog did NOT load - only live Studio tools",
            "will be listed. Re-extract the release zip into a CLEAN",
            f"folder (this run: {_CATALOG_ERROR or 'empty catalog'}).",
        ])
    # Third-party MCP path: embedded Studio queue for the RoLink Studio plugin
    # (no Node needed). Started before the MCP servers so a poll arriving
    # during boot already finds a live queue.
    _queue_up = await asyncio.to_thread(start_queue_server)
    if not _queue_up:
        log("continuing without the embedded Studio queue (StudioMCP-only mode)", "yl")
    await asyncio.to_thread(_kill_orphan_studio_mcp)
    killed_squatter = await asyncio.to_thread(check_studio_port)
    mgr.load_config()

    # Shared "we already told the user the corrective step" flag. Two producers
    # can print the 'toggle Studio's MCP server' action banner: the early
    # _early_studio_guidance task (fast, doesn't wait for start_all's ~48s grace
    # loop) and the post-start_all diagnostic block in _boot_and_diagnose. This
    # flag lets whichever fires first suppress the other, so the user never sees
    # the same instruction twice. Mutable dict so both nested coroutines share it.
    _guidance_shown = {"v": False}

    async def _early_studio_guidance():
        """Print the corrective action banner WITHOUT waiting for start_all()'s
        full ~48s grace loop.

        RobloxClient.start() retries tools/list for up to ~48s to catch a Studio
        that attaches a little late - correct for a Studio that IS coming, but it
        also means a user whose Studio is simply closed or whose MCP toggle is off
        waits ~48s before the terminal tells them what to do (the extension, which
        reads status over the socket, already says it immediately). So after a
        short grace we check independently and, if still not connected, show the
        step now. If Studio then attaches, studio_watch prints the green
        'connected' line - so an early banner is at worst redundant, never wrong
        (the user confirmed a premature toggle hint during boot is harmless).

        Deliberately does NOT try to distinguish 'Studio closed' from 'MCP toggle
        off': probe_studio can't tell them apart (both read app=False, see its
        docstring), and the banner wording already covers both, so there is no
        finer detection to preserve here. A proven port-squatter case is left to
        _boot_and_diagnose / studio_watch, which print their own, more specific
        hint."""
        if PRIMARY_SERVER_ID not in mgr.clients:
            return
        await asyncio.sleep(12)  # give a fast, normal attach the chance to win
        if _guidance_shown["v"]:
            return
        rc = mgr.clients.get(PRIMARY_SERVER_ID)
        if rc is None or getattr(rc, "saw_foreign_ws_host", False):
            return
        if rc.tools_cache:
            # Tools present - either connected, or an attach is mid-flight; defer
            # to the authoritative probe / studio_watch rather than second-guess.
            st = await asyncio.to_thread(probe_studio)
            if st["app"] is not False:
                return
        _guidance_shown["v"] = True
        action_banner([
            "Open your place in Roblox Studio.",
            "Go to: Assistant Settings > MCP Servers",
            "       > 'Enable Studio as MCP server'",
            "It can take up to ~10s; this window will turn green.",
        ])

    async def _boot_and_diagnose():
        """Launch every configured MCP server and print the boot diagnostic
        banner. Runs as a background task AFTER the socket below is already
        listening, so a slow or absent Roblox Studio never delays the
        extension's ability to connect and use OTHER MCP servers (e.g.
        Blender) right away - only the terminal banner and Roblox's own
        auto-recovery loop wait on this. (mgr.start_all() itself also
        launches every server in parallel now, for the same reason.)"""
        try:
            await asyncio.to_thread(mgr.start_all)
        except Exception as e:
            log(f"server startup error: {e}", "rd")
            log("The bridge will keep running; it retries on the first tool call.", "yl")
        total = len(mgr.list_tools())
        # Roblox-only count for the corrective message below: list_tools() sums
        # every configured server (Roblox + addons like Blender), so printing
        # `total` there falsely blamed addon tools on "NO Roblox Studio connected"
        # (seen live: 49 = 27 Roblox + 22 Blender, message only about Roblox).
        roblox_client = mgr.clients.get("roblox")
        roblox_total = len(roblox_client.tools_cache) if roblox_client else 0

        # Port-hijack check (ropilot etc.), done at boot: the child's stderr has
        # by now had its ~12s grace loop to reveal it connected to a foreign host
        # on the MCP port. This is proof the port is squatted even when the
        # one-shot check_studio_port() at startup missed it (a background helper
        # grabbing the port a beat after that check ran - seen live 2026-07-13).
        if (roblox_client is not None and roblox_total == 0
                and roblox_client.saw_foreign_ws_host):
            killed, sname = await asyncio.to_thread(_kill_port_squatter)
            if killed:
                try:
                    await asyncio.to_thread(mgr.restart, "roblox")
                    roblox_total = len(roblox_client.tools_cache)
                    total = len(mgr.list_tools())
                except Exception as e:
                    log(f"roblox proxy restart after squatter kill failed: {e}", "rd")
                _print_squatter_hint(sname)

        # Set True if we kill a leftover StudioMCP zombie below and print the
        # re-register hint - so the diagnostic block further down doesn't ALSO
        # print its own near-identical action banner (the same de-duplication
        # killed_squatter already does for the ropilot-squatter path).
        reclaimed_zombie = False
        # Zombie-port deadlock check, done at boot too (not just studio_watch):
        # with Studio ALREADY open, _kill_orphan_studio_mcp was skipped by its
        # safety guard, so a leftover StudioMCP.exe may still own the port and
        # our fresh proxy just spent its 12s grace loop talking to nothing.
        if (roblox_client is not None and roblox_total == 0
                and await asyncio.to_thread(_roblox_studio_app_running) is True
                and await asyncio.to_thread(_reclaim_studio_port, roblox_client)):
            try:
                await asyncio.to_thread(mgr.restart, "roblox")
                roblox_total = len(roblox_client.tools_cache)
                total = len(mgr.list_tools())
            except Exception as e:
                log(f"roblox proxy restart after zombie kill failed: {e}", "rd")
            reclaimed_zombie = True
            _print_reregister_hint()

        # A tool count alone only proves StudioMCP (the proxy) is up - it advertises
        # its catalogue even with NO Studio attached. The authoritative "a Studio is
        # actually connected" signal is the list_roblox_studios probe. So we probe
        # FIRST and only show the green "ready" line when Studio is really attached;
        # otherwise we show just the corrective step (no misleading green success).
        # Probe even when total == 0: StudioMCP advertises an EMPTY catalogue when
        # Studio's MCP server toggle is off (or no place is open), so 0 tools is the
        # most common "needs a corrective step" state, not a success.
        _st = await asyncio.to_thread(probe_studio)
        # Even when Studio (and its place) were ALREADY open before the bridge
        # started, the freshly-launched StudioMCP proxy needs a moment to (re)bind
        # to Studio's own MCP port - so an instant probe right after launch often
        # reads app=False for a beat before flipping True a few seconds later
        # (studio_watch would catch it, but only after printing a scary yellow
        # "not connected" block first). Give it the same grace period the tools
        # probe already gets before deciding it is a real problem.
        if _st["app"] is False:
            with _Spinner("    waiting for Roblox Studio to attach..."):
                for _ in range(8):
                    await asyncio.sleep(1)
                    _st = await asyncio.to_thread(probe_studio)
                    if _st["app"] is not False:
                        break
        # A single app=True reading can be a STALE positive: StudioMCP.exe can
        # answer list_roblox_studios with a leftover studio entry from a PREVIOUS
        # session even though no Studio window is actually open right now (seen
        # live 2026-07-11: bridge booted with Studio fully closed, still printed
        # "Roblox Studio connected" from the very first probe). studio_watch
        # already distrusts a single reading for PLACE transitions the same way -
        # apply the identical confirm-before-trusting step here for APP, so the
        # boot banner can't announce a connection that isn't really there.
        if _st["app"] is True:
            await asyncio.sleep(1.5)
            confirm = await asyncio.to_thread(probe_studio)
            if confirm["app"] is not True:
                _st = confirm
        if roblox_client is not None and (roblox_total == 0 or _st["app"] is False):
            if killed_squatter or reclaimed_zombie or _guidance_shown["v"]:
                # The action banner was ALREADY shown - either right after a kill
                # (check_studio_port / _print_reregister_hint for a zombie) or by
                # the early _early_studio_guidance task. Repeating the full
                # explanation here in a different color, seconds later, reads as a
                # second unrelated problem to a non-technical user (seen live
                # 2026-07-13: the toggle instruction and this block blurred
                # together). Just confirm we're still waiting, no new instructions.
                log("    still waiting for you to toggle Studio's MCP server "
                    "(see the action box above)...", "yl")
            else:
                _guidance_shown["v"] = True
                # No squatter: Studio is simply closed, or its MCP option is off.
                # Match the exact steps the extension itself tells the user
                # (Assistant Settings > MCP Servers), not a paraphrase - a
                # differently-worded instruction here reads as a second,
                # unrelated problem instead of the same one step.
                if roblox_total > 0:
                    log(f"    {roblox_total} Roblox tools loaded, but NO Roblox Studio is connected yet.", "yl")
                    log("    (This can be a slow attach that clears itself within ~10-15s -", "yl")
                    log("    watch for a green 'Roblox Studio connected' line right after.)", "yl")
                action_banner([
                    "Open your place in Roblox Studio.",
                    "Go to: Assistant Settings > MCP Servers",
                    "       > 'Enable Studio as MCP server'",
                    "It can take up to ~10s; this window will turn green.",
                ])
        elif _st["app"] is True:
            log(f"ready {total} tools available - Roblox Studio connected", "gr")
            if _queue_server_on[0]:
                log("Studio queue :3001 up" + (" - plugin polling (third-party MCP live)"
                    if _plugin_alive() else " - waiting for the Studio plugin poll"), "gr" if _plugin_alive() else "yl")
                if not _plugin_alive():
                    try:
                        _ist = _installed_plugin_state()
                        if not _ist.get("exact_present"):
                            log("installed plugin: no RoLink.lua in %s - run install-plugin.bat with Studio fully closed" % (_ist.get("dir") or "?"), "yl")
                        elif _ist.get("copy_count", 1) != 1:
                            log("installed plugin: %d *RoLink*.lua copies %s - keep only RoLink.lua, delete the rest" % (_ist["copy_count"], [_c["name"] for _c in _ist["copies"]]), "yl")
                        elif not _ist.get("exact_matches_repo"):
                            log("installed plugin differs from THIS folder (repo %s bytes) - reinstall with Studio fully closed" % (_ist.get("repo_size") or "?"), "yl")
                    except Exception:
                        pass
        else:
            log(f"ready {total} tools available ({len(mgr.clients)} MCP server(s))", "gr")
        asyncio.create_task(_supervised(
            "studio_watch", lambda: studio_watch(_st["app"], _st["place"])))

    async def _early_status_pushes():
        """A few follow-up status broadcasts shortly after boot.

        mgr.start_all() still doesn't RETURN until every server's thread has
        joined - including Roblox's, which can take up to ~48s (StudioMCP's
        own internal "waiting for tools" retry loop, seen live). So a single
        broadcast placed after start_all() would be just as slow as the old
        blocking behavior for the exact case this is meant to fix: an addon
        server (e.g. Blender) that's ready in 1-13s while Roblox is still
        slowly timing out. Poll-and-broadcast a few times instead, cheaply,
        so any extension that connected during that window self-corrects
        quickly instead of staying stuck on its first, incomplete snapshot.
        """
        for interval in (2, 2, 4, 6, 6):  # cumulative: 2s, 4s, 8s, 14s, 20s after boot
            await asyncio.sleep(interval)
            await broadcast_status()

    # Free our own port from a leftover bridge (double-launch / X-closed window /
    # prior crash) BEFORE binding, so relaunching start.bat "just works" instead
    # of dying on WinError 10048. Only ever kills a proven bridge.py; anything
    # else falls through to the friendly bind-error below.
    if await asyncio.to_thread(_reclaim_bridge_port):
        await asyncio.sleep(0.6)  # let Windows release the socket before we bind

    try:
        server_ctx = await websockets.serve(
            handler, HOST, PORT, ping_interval=20, ping_timeout=20,
            max_size=16 * 1024 * 1024)
    except OSError as e:
        # errno 10048 (Win) / EADDRINUSE: something we could NOT auto-kill still
        # owns the port - another app, or a python whose cmdline we couldn't read.
        if getattr(e, "errno", None) in (98, 10048) or "10048" in str(e):
            owner = await asyncio.to_thread(_port_owner, PORT)
            who = f" by '{owner[1]}' (pid {owner[0]})" if owner else ""
            log(f"could not start: port {PORT} is already in use{who}.", "rd")
            log(f"    A previous bridge may still be running, or another app took "
                f"the port. Close it, then relaunch. To find it:", "yl")
            log(f"      netstat -ano | findstr {PORT}", "yl")
            log(f"      taskkill /F /PID <the pid from the last column>", "yl")
            log(f"    Or set a different port before start.bat:  set RL_BRIDGE_PORT=17614", "yl")
            return
        raise

    async with server_ctx:
        log(f"listening on ws://{HOST}:{PORT}  - load the extension and open a supported AI chat", "cy")
        asyncio.create_task(_supervised("server_watch", server_watch))
        asyncio.create_task(_boot_and_diagnose())
        asyncio.create_task(_early_studio_guidance())
        asyncio.create_task(_early_status_pushes())
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log("shutting down...", "yl")
        for c in mgr.clients.values():
            c.stop()
    finally:
        log("===== BRIDGE STOP =====", "cy")
