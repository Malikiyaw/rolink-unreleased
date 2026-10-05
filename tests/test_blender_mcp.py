# SPDX-License-Identifier: GPL-3.0-or-later
# tests/test_blender_mcp.py - the opt-in Blender (MCP for Blender) integration.
#
#   python3 tests/test_blender_mcp.py
#
# Everything here runs against FAKES: no Blender, no uv, no stdio child, no
# WebSocket, and - importantly - no write to the repo's config.json. The two
# paths that WOULD launch a real child (install_server, and the add_preset
# message that calls it) run inside no_spawn(), which replaces
# subprocess.Popen with a recorder that refuses the launch: the test still
# proves the code reached Popen, and nothing is ever started. The
# preset/config tests point bridge.CONFIG_PATH at a temp file and restore it.
#
# What is pinned, and why:
#   1. The preset's spawn spec is EXACT. A typo in command/args/env does not
#      fail loudly; it produces a server that starts, advertises nothing, and
#      leaves the user staring at "blender offline". The concrete values are
#      pinned in exactly ONE assertion block on purpose - that is the contract
#      with upstream, and a silent edit to the registry has to fail there.
#      Every other test that needs args/env derives it from
#      bridge.MCP_SERVER_PRESETS instead of restating it, so one preset change
#      is a one-line test edit rather than five simultaneous breakages.
#   2. Opt-in means opt-in: importing the bridge, booting it, listing tools and
#      listing servers must never add or touch blender.
#   3. Every blender tool is advertised as "blender/<upstream name>" while the
#      dispatch keeps the EXACT upstream name, because upstream rejects the
#      prefix.
#   4. Health/metadata is broadcast to every extension tab and into the
#      model-facing status, so it must carry env NAMES and never env VALUES.
#   5. The background<->bridge protocol (list_mcp_servers / add_preset) is
#      driven through the real handler with a fake socket.
#   6. The extension side (options page, popup, manifest) is namespace-aware:
#      its validation must accept both "blender/get_scene_info" and the bare
#      upstream spelling, and the settings page must actually be reachable.

import asyncio
import contextlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import types
import unittest
from unittest import mock

# Stub `websockets` so bridge.py can be imported without the dependency.
if "websockets" not in sys.modules:
    fake_ws = types.ModuleType("websockets")
    fake_ws.ConnectionClosed = type("ConnectionClosed", (Exception,), {})
    fake_ws.serve = lambda *a, **kw: None
    sys.modules["websockets"] = fake_ws

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

import bridge  # noqa: E402


# ── fakes ──────────────────────────────────────────────────────────────────
class FakeClient:
    """Stand-in for MCPClient: a tools_cache, liveness and a call recorder.
    No subprocess, no handshake - exactly what the routing code touches."""

    def __init__(self, sid, tools, alive=True, start_error=None):
        self.id = sid
        self.tools_cache = [{"name": t} for t in tools]
        self._alive = alive
        self.start_error = start_error
        self.calls = []

    def is_alive(self):
        return self._alive

    def start(self):
        return None

    def stop(self):
        return None

    def restart(self):
        return None

    def call_tool(self, name, arguments, timeout):
        self.calls.append((name, arguments, timeout))
        # Mirror the shape of a real upstream reply, images included: the
        # image branch must carry the exact upstream tool name, not the alias.
        images = [{"data": "ZmFrZQ==", "mimeType": "image/png"}] if "screenshot" in name else []
        return {"text": f"ran {name}", "images": images}


class FakeSocket:
    """Minimal stand-in for a websockets connection: replays queued frames and
    records every reply the handler sends."""

    def __init__(self, messages=()):
        self.remote_address = ("127.0.0.1", 5555)
        self.sent = []
        self._queue = list(messages)

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self._queue:
            raise StopAsyncIteration
        return self._queue.pop(0)

    async def send(self, payload):
        self.sent.append(json.loads(payload))

    def frames(self, kind):
        return [m for m in self.sent if m.get("type") == kind]

    def last(self, kind):
        got = self.frames(kind)
        return got[-1] if got else None


@contextlib.contextmanager
def no_spawn():
    """Refuse every subprocess launch for the duration of the body.

    MCPClient.start really does Popen(["uvx", "--python", "3.11",
    "mcp-for-blender"]), so the tests that exercise the in-place install path
    (install_server, and the add_preset message that calls it) would otherwise
    pull a real `uvx` - and the whole upstream package tree - onto whatever
    machine runs the suite. Popen is replaced with a recorder that notes the
    argv it was asked for and then raises FileNotFoundError, which is exactly
    what MCPClient.start already handles as "the launcher is not installed":
    the failure path under test is the real one, and the refusal is recorded
    so a test can assert the code genuinely reached Popen.

    Yields the list of recorded argvs (empty if nothing tried to launch)."""
    attempts = []

    def _refuse(argv=None, *a, **kw):
        attempts.append(list(argv or kw.get("args") or []))
        raise FileNotFoundError(2, "the test suite never spawns a real process")

    real_popen = subprocess.Popen
    try:
        with mock.patch("bridge.subprocess.Popen", _refuse):
            yield attempts
    finally:
        subprocess.Popen = real_popen


def wait_for_spawn(attempts, timeout=5.0):
    """Block until the background start thread has actually reached Popen.

    install_server returns as soon as the client is registered and finishes its
    handshake in a thread, so without this wait the patch could be lifted while
    a real `uvx` was still about to be launched. Returns the recorded argv, or
    None if nothing tried to start within `timeout`."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if attempts:
            return attempts[0]
        time.sleep(0.01)
    return None


@contextlib.contextmanager
def with_config(payload):
    """Point bridge at a temp config.json, run the body, restore. Yields the
    path so a test can assert what was (or was not) written."""
    tmp = tempfile.mkdtemp(prefix="rolink-blender-")
    path = os.path.join(tmp, "config.json")
    if payload is not None:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)
    old = bridge.CONFIG_PATH
    bridge.CONFIG_PATH = path
    try:
        yield path
    finally:
        bridge.CONFIG_PATH = old
        shutil.rmtree(tmp, ignore_errors=True)


def read_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


BLENDER_TOOLS = ["get_scene_info", "execute_blender_code", "get_blender_screenshot"]


# ── 1. the preset spec is exact ────────────────────────────────────────────
class PresetDefinitionTest(unittest.TestCase):
    def test_preset_matches_upstream_documented_setup(self):
        p = bridge.MCP_SERVER_PRESETS.get("mcp-for-blender")
        self.assertIsNotNone(p, "mcp-for-blender preset is missing")
        self.assertEqual(p["server_id"], "blender")
        self.assertEqual(p["command"], "uvx")
        # THE pin. This is the only place in the suite that hard-codes the spawn
        # spec, deliberately: it is the contract with upstream's documented
        # setup, so a silent edit to the registry must fail HERE rather than be
        # silently adopted by every derived expectation below. `--python 3.11`
        # is not decoration - upstream needs a 3.11 interpreter and uvx picks
        # one silently otherwise.
        self.assertEqual(list(p["args"]), ["--python", "3.11", "mcp-for-blender"])
        # Upstream defaults are localhost:9876; the preset pins the IPv4 literal
        # because the Blender addon binds IPv4 only and a ::1 resolution on
        # Windows is a silent connect failure. Safe mode and the telemetry
        # opt-out are pinned for the same reason: the addon's socket has no
        # authentication, so the upstream guard must be on by default instead
        # of something a user has to know to ask for.
        self.assertEqual(dict(p["env"]), {
            "BLENDER_HOST": "127.0.0.1",
            "BLENDER_PORT": "9876",
            "BLENDER_MCP_SAFE_MODE": "1",
            "DISABLE_TELEMETRY": "true",
            "UV_PYTHON_PREFERENCE": "only-managed",
        })
        self.assertIn("uvx", p["requires"])
        self.assertTrue(p["homepage"].startswith("https://"))

    def test_preset_is_namespaced_and_public_form_is_copy(self):
        self.assertEqual(bridge.SERVER_NAMESPACES.get("blender"), "blender")
        preset = bridge.MCP_SERVER_PRESETS["mcp-for-blender"]
        # Snapshot the registry BEFORE the published copy is touched: after the
        # mutations below, comparing the registry against itself would be
        # vacuous, so the pre-mutation value is what the copy check compares to.
        args_before, env_before = list(preset["args"]), dict(preset["env"])
        pub = bridge.public_preset("mcp-for-blender")
        self.assertEqual(pub["namespace"], "blender")
        # Derived, not re-hardcoded: public_preset must hand out the registry's
        # spawn spec verbatim. The concrete values are pinned once, by
        # test_preset_matches_upstream_documented_setup.
        self.assertEqual(pub["args"], list(preset["args"]))
        # A caller mutating the published form must not corrupt the registry.
        pub["args"].append("--port")
        pub["env"]["BLENDER_PORT"] = "1"
        self.assertEqual(bridge.MCP_SERVER_PRESETS["mcp-for-blender"]["args"], args_before)
        self.assertEqual(bridge.MCP_SERVER_PRESETS["mcp-for-blender"]["env"], env_before)
        self.assertEqual(bridge.MCP_SERVER_PRESETS["mcp-for-blender"]["env"]["BLENDER_PORT"], "9876")

    def test_availability_reports_a_missing_launcher_instead_of_guessing(self):
        real_which = bridge.shutil.which
        try:
            bridge.shutil.which = lambda c: None
            av = bridge.preset_availability("mcp-for-blender")
            self.assertFalse(av["available"])
            self.assertEqual(av["missing"], ["uvx"])
            self.assertIn("uv", av["hint"].lower())
            bridge.shutil.which = lambda c: "C:/fake/" + c
            self.assertTrue(bridge.preset_availability("mcp-for-blender")["available"])
        finally:
            bridge.shutil.which = real_which

    def test_unknown_preset_is_not_silently_accepted(self):
        self.assertFalse(bridge.preset_availability("nope")["available"])
        with with_config({"mcpServers": {}}) as path:
            ok, err, info = bridge.config_add_preset("nope")
            self.assertFalse(ok)
            self.assertIn("unknown MCP preset", err)
            self.assertIsNone(info)
            self.assertEqual(read_json(path), {"mcpServers": {}})


# ── 2. opt-in: a default install is untouched ──────────────────────────────
class DefaultInstallUntouchedTest(unittest.TestCase):
    def test_shipped_config_declares_only_the_primary_server(self):
        cfg = read_json(os.path.join(ROOT, "config.json"))
        self.assertEqual(list(cfg["mcpServers"]), ["roblox"],
                         "the default config must not ship a blender entry")
        self.assertNotIn("blender", json.dumps(cfg))

    def test_booting_the_bridge_never_creates_a_blender_client(self):
        with with_config({"mcpServers": {"roblox": {"command": "launch_studio_mcp.py", "args": []}}}) as path:
            mgr = bridge.MCPManager()
            mgr.load_config()
            self.assertEqual(list(mgr.clients), ["roblox"])
            self.assertNotIn("blender", mgr.clients)
            # And nothing was written behind our back.
            self.assertEqual(read_json(path)["mcpServers"], {"roblox": {"command": "launch_studio_mcp.py", "args": []}})

    def test_preset_written_file_is_exact_and_keeps_the_primary(self):
        with with_config({"mcpServers": {"roblox": {"command": "launch_studio_mcp.py", "args": []}}}) as path:
            ok, err, info = bridge.config_add_preset("mcp-for-blender")
            self.assertTrue(ok, err)
            self.assertEqual(info["server_id"], "blender")
            self.assertEqual(sorted(info["env_keys"]),
                             ["BLENDER_HOST", "BLENDER_MCP_SAFE_MODE",
                              "BLENDER_PORT", "DISABLE_TELEMETRY",
                              "UV_PYTHON_PREFERENCE"])
            written = read_json(path)["mcpServers"]
            self.assertIn("roblox", written, "adding a preset must not drop the primary server")
            # Exactly these 7 keys: no fewer (a dropped key silently changes how
            # the server is launched) and no more (an unexpected key would be fed
            # straight into the spawn spec). command/preset/namespace/safeMode/
            # startupTimeoutMs stay literal - they are the bridge's own contract
            # rather than upstream's, and drift there is a silent behaviour
            # change. args/env are derived from the registry; their concrete
            # values are pinned by test_preset_matches_upstream_documented_setup.
            preset = bridge.MCP_SERVER_PRESETS["mcp-for-blender"]
            self.assertEqual(written["blender"], {
                "command": "uvx",
                "args": list(preset["args"]),
                "preset": "mcp-for-blender",
                "namespace": "blender",
                "safeMode": True,
                "startupTimeoutMs": 90000,
                "env": dict(preset["env"]),
            })

    def test_preset_cannot_take_over_the_primary_server(self):
        with with_config({"mcpServers": {"roblox": {"command": "launch_studio_mcp.py", "args": []}}}) as path:
            ok, err, _ = bridge.config_add_preset("mcp-for-blender", server_id="roblox")
            self.assertFalse(ok)
            self.assertIn("primary server", err)
            self.assertNotIn("blender", read_json(path)["mcpServers"])

    def test_server_id_that_cannot_be_a_namespace_is_refused(self):
        with with_config({"mcpServers": {}}) as path:
            ok, err, _ = bridge.config_add_preset("mcp-for-blender", server_id="my blender")
            self.assertFalse(ok)
            self.assertIn("must not contain", err)
            self.assertEqual(read_json(path)["mcpServers"], {})

    def test_re_adding_a_preset_is_idempotent(self):
        with with_config({"mcpServers": {}}) as path:
            bridge.config_add_preset("mcp-for-blender")
            first = read_json(path)
            ok, err, _ = bridge.config_add_preset("mcp-for-blender")
            self.assertTrue(ok, err)
            self.assertEqual(read_json(path), first)

    def test_env_overrides_are_merged_and_never_echoed_back(self):
        with with_config({"mcpServers": {}}):
            ok, err, info = bridge.config_add_preset("mcp-for-blender", env={"BLENDER_PORT": "9999", "SECRET_TOKEN": "s3cr3t"})
            self.assertTrue(ok, err)
            self.assertNotIn("s3cr3t", json.dumps(info), "preset info must not echo env values")
            # The caller's key joins the preset's own five; the override only
            # changes a value, never the key set. info reports NAMES, sorted, so
            # "BLENDER_PORT is not set" is diagnosable and s3cr3t never is.
            self.assertEqual(info["env_keys"], ["BLENDER_HOST", "BLENDER_MCP_SAFE_MODE",
                                                "BLENDER_PORT", "DISABLE_TELEMETRY",
                                                "SECRET_TOKEN", "UV_PYTHON_PREFERENCE"])
            written = read_json(bridge.CONFIG_PATH)["mcpServers"]["blender"]["env"]
            self.assertEqual(written["BLENDER_PORT"], "9999")
            self.assertEqual(written["BLENDER_HOST"], "127.0.0.1")


# ── 3. namespacing + exact upstream dispatch ───────────────────────────────
class _BlenderFixture:
    """Shared wiring: a manager holding a namespaced blender server next to an
    unnamespaced Roblox server, and a second namespaced server for the
    ambiguous-name case. Not a TestCase - see NamespaceRoutingTest /
    SafeCallNamespaceTest."""

    def _build(self, extra_clients=(), namespaces=None):
        self.mgr = bridge.MCPManager()
        self.blender = FakeClient("blender", BLENDER_TOOLS)
        self.roblox = FakeClient("roblox", ["create_instance", "get_instances"])
        self.mgr.clients = {"roblox": self.roblox, "blender": self.blender}
        for sid, client, ns in extra_clients:
            self.mgr.clients[sid] = client
            if ns:
                self.mgr.namespaces[sid] = ns
        for sid, ns in (namespaces or {}).items():
            self.mgr.namespaces[sid] = ns
        self.mgr.rebuild_index()
        self._orig = bridge.mgr
        bridge.mgr = self.mgr

    def _restore(self):
        bridge.mgr = self._orig


class NamespaceRoutingTest(unittest.TestCase, _BlenderFixture):
    def setUp(self):
        self._build()

    def tearDown(self):
        self._restore()

    def test_every_blender_tool_is_advertised_under_blender(self):
        names = {e["name"] for e in self.mgr.list_tools()}
        for tool in BLENDER_TOOLS:
            self.assertIn(f"blender/{tool}", names)
            self.assertNotIn(tool, names, "an unprefixed blender name would be a collision magnet")
        # Unnamespaced servers keep the historical bare-name behaviour.
        self.assertIn("create_instance", names)
        self.assertIn("get_instances", names)

    def test_namespaced_listing_still_reports_the_upstream_server(self):
        entry = next(e for e in self.mgr.list_tools() if e["name"] == "blender/get_scene_info")
        self.assertEqual(entry["server"], "blender")

    def test_listing_before_the_index_is_built_is_still_namespaced(self):
        # Regression: the advertised-key reverse map is built by rebuild_index,
        # and list_tools used to fall back to the BARE upstream name when it was
        # missing. That is not cosmetic - a bare blender "get_scene_info" is
        # exactly the collision the namespace exists to prevent, and config
        # order can then hand that name to a Roblox command. Found by a real
        # subprocess end-to-end run, which the pure fakes could not see.
        fresh = bridge.MCPManager()
        fresh.clients = {"roblox": FakeClient("roblox", ["create_instance"]),
                         "blender": FakeClient("blender", BLENDER_TOOLS)}
        self.assertEqual(fresh.index, {}, "precondition: no index built yet")
        names = {e["name"] for e in fresh.list_tools() if e.get("server") == "blender"}
        self.assertIn("blender/get_scene_info", names)
        self.assertNotIn("get_scene_info", names)

    def test_namespaced_call_dispatches_the_exact_upstream_name(self):
        self.mgr.call("blender/execute_blender_code", {"code": "bpy.ops.mesh.primitive_cube_add()"}, 5)
        self.assertEqual(self.blender.calls[-1][0], "execute_blender_code")
        self.assertEqual(self.roblox.calls, [])

    def test_bare_upstream_name_resolves_to_the_namespaced_key(self):
        # A model that copies a name out of the project's own docs writes the
        # bare spelling; it must still reach the right server.
        self.assertEqual(self.mgr.advertised_key_for("get_scene_info"), "blender/get_scene_info")
        self.mgr.call("get_blender_screenshot", {}, 5)
        self.assertEqual(self.blender.calls[-1][0], "get_blender_screenshot")

    def test_ambiguous_bare_name_is_refused_not_guessed(self):
        # A second namespaced server exporting the same upstream name: the bare
        # spelling is now genuinely ambiguous, and guessing would silently run
        # the wrong app's tool.
        self._restore()
        self._build(extra_clients=[("b3d", FakeClient("b3d", ["get_scene_info"]), "b3d")])
        self.assertIsNone(self.mgr.advertised_key_for("get_scene_info"))
        self.assertEqual(self.mgr.upstream_candidates("get_scene_info"),
                         ["b3d/get_scene_info", "blender/get_scene_info"])

    def test_config_namespace_overrides_the_preset_default(self):
        mgr = bridge.MCPManager()
        with with_config({"mcpServers": {"roblox": {"command": "x", "args": []},
                                        "studio-blender": {"command": "uvx", "args": ["mcp-for-blender"],
                                                           "namespace": "b3d"}}}):
            mgr.load_config()
            mgr.clients["studio-blender"] = FakeClient("studio-blender", ["get_scene_info"])
            mgr.rebuild_index()
            names = {e["name"] for e in mgr.list_tools()}
            self.assertIn("b3d/get_scene_info", names)
            self.assertEqual(bridge.effective_namespace("studio-blender"), "b3d")

    def test_provenance_reports_the_exact_upstream_tool(self):
        prov = self.mgr.provenance("blender/get_scene_info")
        self.assertEqual(prov, {"server": "blender", "tool": "get_scene_info"})

    def test_colliding_namespaces_stay_both_reachable(self):
        mgr = bridge.MCPManager()
        mgr.namespaces["a"] = mgr.namespaces["b"] = "blender"
        mgr.clients = {"a": FakeClient("a", ["get_scene_info"]),
                       "b": FakeClient("b", ["get_scene_info"])}
        mgr.rebuild_index()
        self.assertEqual(len(mgr.index), 2, "one namespaced server must not shadow the other")

    def test_install_server_loads_in_place_without_a_process_restart(self):
        with with_config({"mcpServers": {"roblox": {"command": "x", "args": []},
                                        "blender": {"command": "uvx", "args": ["mcp-for-blender"]}}}):
            mgr = bridge.MCPManager()
            # install_server launches the configured command in a background
            # thread, so Popen is refused for the duration (no_spawn): the code
            # path is exercised for real, no `uvx` is ever started. The wait is
            # what makes that safe - install_server returns before the thread
            # runs, so without it the patch could be lifted mid-launch.
            with no_spawn() as attempts:
                ok, err = mgr.install_server("blender")
                self.assertTrue(ok, err)
                self.assertIn("blender", mgr.clients)
                self.assertIsInstance(mgr.clients["blender"], bridge.MCPClient)
                self.assertIsNotNone(wait_for_spawn(attempts),
                                     "install_server never reached Popen")
            # A client for an id that is not in the config is a failure, not a
            # silent no-op the caller would report as success.
            self.assertEqual(mgr.install_server("ghost"), (False, "server 'ghost' is not in the config"))


# ── 4. safe_call: namespace-aware validation ───────────────────────────────
class SafeCallNamespaceTest(unittest.TestCase, _BlenderFixture):
    """Drives the real safe_call entry point the bridge's call_tool uses."""

    def setUp(self):
        self._build()
        self._probe = bridge.probe_studio
        bridge.probe_studio = lambda: {"app": True, "place": True}

    def tearDown(self):
        bridge.probe_studio = self._probe
        self._restore()

    def test_ambiguous_bare_name_is_a_validation_error_naming_both(self):
        self._restore()
        self._build(extra_clients=[("b3d", FakeClient("b3d", ["get_scene_info"]), "b3d")])
        bridge.probe_studio = lambda: {"app": True, "place": True}
        res = bridge.safe_call("get_scene_info", {}, 5)
        self.assertFalse(res["ok"])
        self.assertEqual(res["kind"], "validation_error")
        self.assertIn("blender/get_scene_info", res["error"])
        self.assertIn("b3d/get_scene_info", res["error"])
        self.assertEqual(self.blender.calls, [])

    def test_namespaced_call_succeeds_and_reports_upstream_name(self):
        res = bridge.safe_call("blender/get_scene_info", {}, 5)
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["tool"], "get_scene_info")
        self.assertEqual(res["server"], "blender")
        self.assertEqual(self.blender.calls[-1][0], "get_scene_info")

    def test_image_result_keeps_the_exact_upstream_tool_name(self):
        res = bridge.safe_call("blender/get_blender_screenshot", {}, 5)
        self.assertTrue(res["ok"], res)
        self.assertEqual(len(res["images"]), 1)
        # The name attached to an image-carrying result is the one upstream
        # actually ran - that is what the extension labels the capture with and
        # what its learned "this tool returns screenshots" memory keys off.
        self.assertEqual(res["tool"], "get_blender_screenshot")

    def test_bare_upstream_spelling_reaches_the_right_server(self):
        res = bridge.safe_call("get_blender_screenshot", {}, 5)
        self.assertTrue(res["ok"], res)
        self.assertEqual(self.blender.calls[-1][0], "get_blender_screenshot")

    def test_bridge_owned_names_are_never_hijacked_by_an_addon(self):
        # Blender exports generically named tools. If one of them collides with
        # a tool the bridge answers ITSELF, the bare name must keep meaning the
        # bridge's tool - otherwise adding Blender silently removes a RoLink
        # command. The namespaced spelling stays available and exact.
        self.blender.tools_cache = [{"name": "get_time"}, {"name": "get_scene_info"}]
        self.mgr.rebuild_index()
        names = {e["name"] for e in self.mgr.list_tools()}
        self.assertIn("blender/get_time", names, "the addon tool is still reachable, namespaced")
        res = bridge.safe_call("get_time", {}, 5)
        self.assertTrue(res["ok"], res)
        # Answered locally, so there is no upstream provenance at all - the
        # signature of the bridge's own handler having run.
        self.assertNotIn("server", res)
        self.assertIn("epoch", res["text"], "this must be the bridge's own get_time")
        self.assertEqual(self.blender.calls, [], "the addon must not have been dispatched to")
        # ...and the explicit namespaced spelling goes to the addon.
        res2 = bridge.safe_call("blender/get_time", {}, 5)
        self.assertTrue(res2["ok"], res2)
        self.assertEqual(self.blender.calls[-1][0], "get_time")

    def test_collision_prefixed_spelling_is_refused_with_the_real_name(self):
        res = bridge.safe_call("roblox/create_instance", {"className": "Part"}, 5)
        self.assertFalse(res["ok"])
        self.assertEqual(res["kind"], "validation_error")
        self.assertIn('the command is "create_instance"', res["error"])
        self.assertEqual(self.roblox.calls, [], "a bogus prefix must not reach a server")

    def test_genuinely_unknown_name_still_gets_suggestions(self):
        res = bridge.safe_call("blender/get_scene_inf", {}, 5)
        self.assertFalse(res["ok"])
        self.assertEqual(res["kind"], "validation_error")


# ── 5. health / metadata never leaks env values ────────────────────────────
class HealthMetadataTest(unittest.TestCase):
    SECRET = "sk-do-not-leak-1234"

    def setUp(self):
        preset = bridge.MCP_SERVER_PRESETS["mcp-for-blender"]
        self.cfg = {
            "mcpServers": {
                "roblox": {"command": "launch_studio_mcp.py", "args": []},
                # An installed blender entry: the preset's own spawn spec (args
                # taken from the registry, so the broadcast below is checked
                # against the spec that is really installed) plus a personal API
                # key, because that is what these rows carry in practice.
                "blender": {"command": preset["command"], "args": list(preset["args"]),
                            "preset": "mcp-for-blender",
                            "env": {"BLENDER_HOST": "127.0.0.1", "BLENDER_PORT": "9876",
                                    "SKETCHFAB_API_KEY": self.SECRET}},
            }
        }
        self.mgr = bridge.MCPManager()
        self.mgr.clients = {
            "roblox": FakeClient("roblox", ["create_instance"]),
            "blender": FakeClient("blender", BLENDER_TOOLS, alive=False,
                                  start_error="command not found: 'uvx' - is it installed and on PATH?"),
        }
        self.mgr.rebuild_index()
        self._orig = bridge.mgr
        bridge.mgr = self.mgr

    def tearDown(self):
        bridge.mgr = self._orig

    def test_health_carries_namespace_and_env_names_but_no_values(self):
        with with_config(self.cfg):
            rows = {r["id"]: r for r in self.mgr.health()}
            self.assertIn("blender", rows)
            self.assertFalse(rows["blender"]["alive"])
            meta = rows["blender"]["meta"]
            self.assertEqual(meta["namespace"], "blender")
            self.assertEqual(meta["command"], "uvx")
            # Derived: what must be broadcast is the args the config actually
            # holds, which are the preset's - not a re-typed literal. The
            # concrete values are pinned by
            # test_preset_matches_upstream_documented_setup.
            self.assertEqual(meta["args"], list(bridge.MCP_SERVER_PRESETS["mcp-for-blender"]["args"]))
            self.assertEqual(meta["env_keys"], ["BLENDER_HOST", "BLENDER_PORT", "SKETCHFAB_API_KEY"])
            self.assertEqual(meta["preset"], "mcp-for-blender")
            # The launch failure is surfaced: "blender ○" alone is unactionable.
            self.assertIn("uvx", rows["blender"]["error"])
            # No secret anywhere in the serialized payload.
            self.assertNotIn(self.SECRET, json.dumps(self.mgr.health()))

    def test_roblox_health_shape_is_backwards_compatible(self):
        with with_config(self.cfg):
            row = next(r for r in self.mgr.health() if r["id"] == "roblox")
            for key in ("id", "alive", "tools"):
                self.assertIn(key, row)
            self.assertTrue(row["alive"])

    def test_list_mcp_servers_reports_config_plus_install_state(self):
        with with_config(self.cfg):
            info = bridge.list_mcp_servers()
            self.assertTrue(info["ok"])
            ids = [s["id"] for s in info["servers"]]
            self.assertEqual(ids, ["roblox", "blender"])
            self.assertTrue(info["servers"][0]["primary"])
            self.assertFalse(info["servers"][1]["primary"])
            self.assertTrue(info["servers"][1]["alive"] is False)
            self.assertEqual(info["servers"][1]["tools"], 3)
            self.assertNotIn("env", info["servers"][1], "values must never be echoed")
            self.assertNotIn(self.SECRET, json.dumps(info))
            preset = next(p for p in info["presets"] if p["id"] == "mcp-for-blender")
            self.assertTrue(preset["installed"])
            self.assertEqual(preset["server_id"], "blender")

    def test_preset_is_reported_uninstalled_when_absent_from_config(self):
        with with_config({"mcpServers": {"roblox": {"command": "x", "args": []}}}):
            info = bridge.list_mcp_servers()
            preset = next(p for p in info["presets"] if p["id"] == "mcp-for-blender")
            self.assertFalse(preset["installed"])
            self.assertIn("available", preset)


# ── 6. background <-> bridge protocol ─────────────────────────────────────
class BridgeProtocolTest(unittest.TestCase):
    """Drives the real handler() with a fake socket - the exact code path the
    service worker talks to."""

    def setUp(self):
        self.cfg = {"mcpServers": {"roblox": {"command": "launch_studio_mcp.py", "args": []}}}
        self.mgr = bridge.MCPManager()
        self.mgr.clients = {"roblox": FakeClient("roblox", ["create_instance"])}
        self.mgr.rebuild_index()
        self._orig = (bridge.mgr, bridge.probe_studio, bridge._roblox_studio_app_running,
                      bridge.broadcast_status)
        bridge.mgr = self.mgr
        bridge.probe_studio = lambda: {"app": None, "place": None}
        bridge._roblox_studio_app_running = lambda: False

        async def _noop():
            return None
        bridge.broadcast_status = _noop

    def tearDown(self):
        (bridge.mgr, bridge.probe_studio, bridge._roblox_studio_app_running,
         bridge.broadcast_status) = self._orig

    def _run(self, messages):
        ws = FakeSocket([json.dumps(m) for m in messages])
        asyncio.run(asyncio.wait_for(bridge.handler(ws), timeout=20))
        return ws

    def test_list_mcp_servers_is_answered(self):
        with with_config(self.cfg):
            ws = self._run([{"type": "list_mcp_servers", "id": 7}])
            frame = ws.last("mcp_servers")
            self.assertIsNotNone(frame, ws.sent)
            self.assertEqual(frame["id"], 7)
            self.assertTrue(frame["ok"])
            self.assertEqual([s["id"] for s in frame["servers"]], ["roblox"])
            self.assertTrue(any(p["id"] == "mcp-for-blender" for p in frame["presets"]))

    def test_add_preset_acks_without_a_process_restart(self):
        with with_config(self.cfg) as path:
            # add_preset writes the spec and loads it in place, which launches
            # `uvx --python 3.11 mcp-for-blender` in a background thread. Popen
            # is refused (no_spawn) so the ack below is proven with no real
            # child, and the wait keeps the refusal in force until the launch
            # has actually been attempted.
            with no_spawn() as attempts:
                ws = self._run([{"type": "add_preset", "preset": "mcp-for-blender", "id": 9}])
                self.assertIsNotNone(wait_for_spawn(attempts), "add_preset never reached Popen")
            frame = ws.last("server_changed")
            self.assertIsNotNone(frame, ws.sent)
            self.assertTrue(frame["ok"], frame)
            self.assertEqual(frame["preset"], "mcp-for-blender")
            self.assertEqual(frame["server_id"], "blender")
            # Loaded in place: no execv, so an attached Studio session and every
            # other MCP child survive the opt-in.
            self.assertFalse(frame["restarting"])
            self.assertIn("blender", self.mgr.clients)
            self.assertIn("blender", read_json(path)["mcpServers"])

    def test_add_preset_failure_is_reported_without_writing_anything(self):
        with with_config(self.cfg) as path:
            ws = self._run([{"type": "add_preset", "preset": "made-up", "id": 11}])
            frame = ws.last("server_changed")
            self.assertFalse(frame["ok"])
            self.assertIn("unknown MCP preset", frame["error"])
            self.assertEqual(list(read_json(path)["mcpServers"]), ["roblox"])

    def test_add_preset_restart_flag_when_the_entry_cannot_be_loaded(self):
        with with_config(self.cfg):
            # No in-place install (e.g. a future bridge build that cannot hot
            # load): the ack must still tell the extension to wait for a
            # reconnect instead of pretending nothing changed.
            original = self.mgr.install_server
            self.mgr.install_server = lambda sid: (False, "cannot hot-load")
            try:
                with no_spawn() as attempts:
                    ws = self._run([{"type": "add_preset", "preset": "mcp-for-blender", "id": 13}])
            finally:
                self.mgr.install_server = original
            self.assertEqual(attempts, [], "the stubbed install must not launch anything")
            frame = ws.last("server_changed")
            self.assertTrue(frame["ok"])
            self.assertTrue(frame["restarting"])


# ── 7. extension side: reachable settings + namespace-aware validation ────
def ext(*parts):
    with open(os.path.join(ROOT, "rolink-extension", *parts), encoding="utf-8") as f:
        return f.read()


def ext_code(*parts):
    """The file with comments and string literals blanked out, so a check for
    a hard-coded value cannot be satisfied (or tripped) by prose in a comment."""
    src = ext(*parts)
    src = re.sub(r"/\*.*?\*/", " ", src, flags=re.S)
    src = re.sub(r"//[^\n]*", " ", src)
    src = re.sub(r"'(?:\\.|[^'\\])*'", "''", src)
    src = re.sub(r'"(?:\\.|[^"\\])*"', '""', src)
    src = re.sub(r"`(?:\\.|[^`\\])*`", "``", src)
    return src


class ExtensionSurfaceTest(unittest.TestCase):
    def test_manifest_declares_the_settings_page(self):
        # Without options_ui/options_page the options page exists but is
        # unreachable: no button, no chrome://extensions entry.
        manifest = json.loads(ext("manifest.json"))
        self.assertIn(manifest.get("manifest_version"), (2, 3))
        opts = manifest.get("options_ui") or {}
        self.assertTrue(opts or manifest.get("options_page"),
                        "options.html is unreachable without options_ui/options_page")
        self.assertEqual(opts.get("page", manifest.get("options_page")), "options.html")

    def test_background_handles_the_bridge_protocol_messages(self):
        bg_js = ext("background.js")
        for case in ("list_mcp_servers", "add_preset", "add_server", "remove_server", "version"):
            self.assertIn(f'case "{case}"', bg_js, f"background.js must answer {case}")

    def test_background_forwards_the_preset_and_refreshes_after_reconnect(self):
        bg_js = ext("background.js")
        self.assertIn('type: "add_preset"', bg_js)
        self.assertIn('type: "list_mcp_servers"', bg_js)
        self.assertIn('msg.type === "mcp_servers"', bg_js)

    def test_options_page_offers_the_preset_button(self):
        html, js = ext("options.html"), ext("options.js")
        # The container the cards render into, and the opt-in click. The cards
        # themselves come from the bridge, so the page has no preset id in it.
        self.assertIn('id="mcpPresets"', html)
        self.assertIn('type: "add_preset"', js)
        self.assertIn("data-preset", js)
        self.assertIn("Nothing is installed or launched until you click OK", js)

    def test_popup_settings_button_reaches_the_options_page(self):
        self.assertIn("openOptionsPage", ext("popup.js"))

    def test_options_page_ids_all_exist(self):
        # The options page is hand-written HTML + hand-written JS with no build
        # step, so a renamed id fails silently at runtime (the button simply does
        # nothing) rather than at load. Cheap structural check, and it covers
        # the new preset container too.
        html, js = ext("options.html"), ext("options.js")
        declared = set(re.findall(r'id="([\w-]+)"', html))
        fetched = set(re.findall(r'getElementById\("([\w-]+)"\)', js))
        self.assertEqual(fetched - declared, set(),
                         "options.js reaches for ids the options page does not declare")
        self.assertEqual(declared - fetched, set(),
                         "options.html declares ids no script ever uses")

    def test_extension_validation_is_namespace_aware(self):
        main_js = ext("core", "main.js")
        # A namespaced addon name must survive validation and reach the bridge
        # as the advertised key, and the bare upstream spelling must be
        # resolved to it instead of being refused as unknown.
        self.assertIn("function advertisedKey", main_js)
        self.assertIn("isNamespaced =", main_js)
        self.assertIn("upstreamName =", main_js)
        # The rewritten key is what gets SENT, not just what validates.
        self.assertIn("name: wireName", main_js)
        # The exact upstream tool name from the result envelope labels the image.
        self.assertIn("upstreamName(wireName, r.tool)", main_js)

    def test_in_page_menu_offers_presets_and_reaches_the_settings_page(self):
        main_js, bg_js = ext("core", "main.js"), ext("background.js")
        # The in-page panel is a summary; the settings page must be one click
        # away from it, and a content script cannot open chrome-extension://
        # itself, so the request has to be proxied by the worker.
        self.assertIn('rl-open-settings', main_js)
        self.assertIn('type: "open_options"', main_js)
        self.assertIn('case "open_options"', bg_js)
        self.assertIn("openOptionsPage", bg_js)
        self.assertIn("rl-mcp-add-preset", main_js)

    def test_no_extension_surface_hardcodes_the_preset_spawn_spec(self):
        # The bridge owns command/args/env. A copy in the extension is free to
        # drift, and a drifted copy is how "Blender works for me" becomes
        # "Blender is broken" for everyone else. Comments are exempt: naming
        # uvx while explaining WHY a launcher matters is documentation, not a
        # second source of truth.
        for name in ("popup.js", "options.js", os.path.join("core", "main.js")):
            code = ext_code(name)
            self.assertNotIn("uvx", code, f"{name} must read the preset's command from the bridge")
            self.assertNotIn("mcp-for-blender", code, f"{name} must read the preset from the bridge")
            self.assertNotIn("BLENDER_PORT", code, f"{name} must not restate the preset's env")


# ── 8. the extension actually parses and resolves namespaces ──────────────
# The string checks above can only prove a helper EXISTS. These run the real
# JavaScript in a headless Chromium-family browser: every extension file is
# parsed for real, and the namespace resolution extracted from core/main.js is
# executed against the exact cases the bridge can hand it. Skipped (not failed)
# where no such browser is installed.
JS_BROWSER_CANDIDATES = [
    os.environ.get("ROLINK_JS_BROWSER"),
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
]


def find_js_browser():
    for cand in JS_BROWSER_CANDIDATES:
        if not cand:
            continue
        if os.path.isfile(cand):
            return cand
        found = shutil.which(cand)
        if found:
            return found
    return None


def main_js_namespace_helpers():
    """The contiguous helper block from core/main.js that implements namespace
    resolution, lifted verbatim. Sliced between two stable declarations rather
    than re-typed, so this exercises the shipped code - if the helpers move, the
    slice fails loudly instead of quietly testing a stale copy."""
    src = ext("core", "main.js")
    start = src.index("const bareToolName =")
    anchor = src.index("const upstreamName =")
    end = src.index("\n  };\n", anchor) + len("\n  };\n")
    return src[start:end]


@unittest.skipUnless(find_js_browser(), "no headless Chromium-family browser for the JS checks")
class ExtensionRuntimeTest(unittest.TestCase):
    JS_FILES = ("background.js", "options.js", "popup.js", os.path.join("core", "main.js"))

    def _run_js(self, driver):
        """Evaluate `driver` (a JS function body) in a throwaway page and return
        whatever it returns as JSON."""
        browser = find_js_browser()
        tmp = tempfile.mkdtemp(prefix="rolink-jscheck-")
        page = os.path.join(tmp, "check.html")
        payload = json.dumps({
            "sources": {name: ext(name) for name in self.JS_FILES},
            "helpers": main_js_namespace_helpers(),
            "driver": driver,
        })
        with open(page, "w", encoding="utf-8") as f:
            f.write(
                "<!doctype html><meta charset='utf-8'><body><div id='out'></div><script>\n"
                "var P = " + payload + ";\n"
                "function __syntax(src) { try { new Function(src); return 'OK'; }"
                " catch (e) { return e.name + ': ' + e.message; } }\n"
                "var __out = {};\n"
                "__out.syntax = {};\n"
                "for (var k in P.sources) __out.syntax[k] = __syntax(P.sources[k]);\n"
                "__out.result = (new Function('P', P.helpers + '\\n' + P.driver))(P);\n"
                "document.getElementById('out').textContent = JSON.stringify(__out);\n"
                "</script></body>"
            )
        udd = os.path.join(tmp, "profile")
        try:
            proc = subprocess.run(
                [browser, "--headless=new", "--disable-gpu", "--no-first-run",
                 "--no-default-browser-check", "--disable-extensions",
                 f"--user-data-dir={udd}", "--dump-dom", page.replace("\\", "/").join(("file:///", ""))],
                capture_output=True, text=True, timeout=120,
            )
        except (OSError, subprocess.SubprocessError) as e:
            self.skipTest(f"could not run the headless browser: {e}")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        m = re.search(r'<div id="out">(.*?)</div>', proc.stdout, re.S)
        self.assertIsNotNone(m, f"no result from the headless browser:\n{proc.stdout[:800]}\n{proc.stderr[:400]}")
        return json.loads(m.group(1).replace("&quot;", '"').replace("&amp;", "&"))

    def test_every_extension_file_parses(self):
        out = self._run_js("return null;")
        for name, verdict in out["syntax"].items():
            self.assertEqual(verdict, "OK", f"{name} does not parse: {verdict}")

    def test_namespace_resolution_behaviour(self):
        cases = [
            # (toolNames, input, expected, why)
            (["blender/get_scene_info", "create_instance"], "blender/get_scene_info",
             "blender/get_scene_info", "an exact namespaced name is left alone"),
            (["blender/get_scene_info", "create_instance"], "get_scene_info",
             "blender/get_scene_info", "a bare upstream name reaches its namespaced key"),
            (["blender/get_blender_screenshot"], "get_blender_screenshot",
             "blender/get_blender_screenshot", "image tools resolve the same way"),
            (["blender/get_scene_info", "create_instance"], "not_a_tool", "not_a_tool",
             "an unknown name is not rewritten into something that looks real"),
            (["get_scene_info", "blender/get_scene_info", "b3d/get_scene_info"], "get_scene_info",
             "get_scene_info", "an advertised bare name beats namespaced lookalikes"),
            (["blender/get_scene_info", "b3d/get_scene_info"], "get_scene_info", "get_scene_info",
             "ambiguous with no bare name: left for the bridge to report, never guessed"),
            (["run_code", "execute_luau"], "run_code", "run_code",
             "a documented alias stays an alias (canonicalisation is the bridge's job)"),
        ]
        # The helper block closes over A from the enclosing scope, so it is
        # evaluated once per tool list with a fresh A bound to it.
        driver = (
            "var out = [];\n"
            + json.dumps([[t, i, e, w] for t, i, e, w in cases]).replace("][", "],[") + ".forEach(function (c) {\n"
            "  try {\n"
            "    var A = { toolNames: new Set(c[0]) };\n"
            "    var gotKey = (new Function('A', P.helpers + '\\nreturn advertisedKey(arguments[1]);'))(A, c[1]);\n"
            "    var gotNs = (new Function('P2', P.helpers + '\\nreturn isNamespaced(P2);'))(c[1]);\n"
            "    out.push({ input: c[1], want: c[2], got: gotKey, ns: gotNs, why: c[3] });\n"
            "  } catch (e) { out.push({ input: c[1], want: c[2], got: e.name + ': ' + e.message, why: c[3] }); }\n"
            "});\n"
            "return out;"
        )
        out = self._run_js(driver)
        for row in out["result"]:
            self.assertEqual(row["got"], row["want"], f'{row["input"]}: {row["why"]}')

    def test_upstream_name_prefers_what_the_bridge_reports(self):
        driver = (
            "var f = new Function('A', P.helpers + '\\nreturn upstreamName;');\n"
            "var up = f({ toolNames: new Set([]) });\n"
            "return [\n"
            "  up('blender/get_blender_screenshot'),\n"
            "  up('blender/get_blender_screenshot', 'get_blender_screenshot'),\n"
            "  up('blender/x', 'y'),\n"
            "  up('create_instance'),\n"
            "  up('')\n"
            "];"
        )
        out = self._run_js(driver)
        self.assertEqual(out["result"], [
            "get_blender_screenshot",   # namespace stripped when nothing is reported
            "get_blender_screenshot",   # the bridge's exact upstream name wins
            "y",                        # an explicit report always wins
            "create_instance",          # an unnamespaced tool is unchanged
            "",                         # never throws on an empty name
        ])


if __name__ == "__main__":
    unittest.main(verbosity=2)
