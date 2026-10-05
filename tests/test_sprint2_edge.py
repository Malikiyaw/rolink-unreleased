# tests/test_sprint2_edge.py - Sprint 2 edge pins (NEW, source-touching forbidden).
#   python -m unittest tests.test_sprint2_edge -v
# Covers: (1) unknown verify tool fails honestly w/ detail; (2) evidence
# result/verify-detail caps hold under huge outputs; (3) non-dict args /
# verify.args rejected; (4) run_task prompt example tools all registered
# (all three mirrors); (5) six non-empty prompt fields + three mirrors
# agree; (6) code-fields run_task == sorted zod string-paths from registry;
# (7) atomic with 0 succeeded never calls rollback and says "nothing to
# revert"; (8) a step depending on a FAILED step never runs (tool failure
# and verify failure alike); (9) verify never runs once its own step failed
# (no 'verify' key on the evidence row, verify tool never dispatched).
# Offline: steps use local-only tools; websockets stub precedes bridge import.
import json
import os
import re
import sys
import types
import unittest

if "websockets" not in sys.modules:
    fake = types.ModuleType("websockets")
    fake.ConnectionClosed = type("ConnectionClosed", (Exception,), {})
    fake.serve = lambda *a, **kw: None
    sys.modules["websockets"] = fake

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

import bridge

RESULT_CAP = 2000
VERIFY_DETAIL_CAP = 500
PROMPT_FIELDS = ("persona", "when_to_use", "args_guide",
                 "example_call", "output", "pitfalls")


def run(goal="edge", steps=None, mode="best_effort"):
    return bridge.safe_call("run_task", {"goal": goal, "steps": steps if steps is not None else [],
                                         "mode": mode, "projectId": "test"}, 60)


def body(res):
    return json.loads(res.get("text") or res.get("error") or "{}")


def T(id, tool, args=None, depends_on=None, verify=None):
    s = {"id": id, "tool": tool}
    s["args"] = args if args is not None else {}
    if depends_on:
        s["depends_on"] = depends_on
    if verify is not None:
        s["verify"] = verify
    return s


def load_json(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
        return json.load(f)


def read(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
        return f.read()


class VerifyUnknownToolTest(unittest.TestCase):
    def test_unknown_verify_tool_fails_honestly_with_detail(self):
        r = run(goal="verify-unknown", steps=[
            T("t", "get_time", verify={"tool": "definitely_not_a_tool_xyz"})])
        self.assertTrue(r["ok"], r.get("error"))
        b = body(r)
        self.assertEqual(b["status"], "stopped-at-first-failure")
        ev = b["evidence"][0]
        self.assertFalse(ev["ok"])
        self.assertIn("verify", ev)
        self.assertFalse(ev["verify"]["ok"])
        self.assertEqual(ev["verify"]["tool"], "definitely_not_a_tool_xyz")
        detail = ev["verify"].get("detail", "")
        self.assertTrue(detail, "verify failure must carry a detail string")
        self.assertIn("unknown tool", detail.lower(),
                      "unknown verify tool must be reported honestly, got: %r" % detail[:200])
        self.assertIn("verify failed", (ev.get("error") or "").lower())


class EvidenceCapTest(unittest.TestCase):
    def test_normal_evidence_result_is_bounded(self):
        r = run(goal="cap-normal", steps=[T("t", "get_time")])
        self.assertTrue(r["ok"], r.get("error"))
        b = body(r)
        for ev in b["evidence"]:
            if "result" in ev:
                self.assertLessEqual(len(ev["result"]), RESULT_CAP)

    def test_huge_result_is_truncated_to_cap(self):
        orig = bridge.safe_call
        huge = "X" * 100000

        def fake(tool, args=None, timeout=None):
            if tool == "get_time":
                return {"ok": True, "text": huge}
            return orig(tool, args, timeout)

        bridge.safe_call = fake
        try:
            r = bridge._local_run_task({"goal": "cap-huge", "steps": [
                {"id": "t", "tool": "get_time", "args": {}}], "projectId": "test"})
        finally:
            bridge.safe_call = orig
        self.assertTrue(r["ok"], r.get("error"))
        b = body(r)
        self.assertIn("result", b["evidence"][0])
        self.assertLessEqual(len(b["evidence"][0]["result"]), RESULT_CAP)
        self.assertEqual(b["evidence"][0]["result"], huge[:RESULT_CAP])

    def test_huge_verify_detail_is_truncated_to_cap(self):
        orig = bridge.safe_call
        huge = "Y" * 100000

        def fake(tool, args=None, timeout=None):
            if tool == "get_time":
                return {"ok": True, "text": huge}
            return orig(tool, args, timeout)

        bridge.safe_call = fake
        try:
            r = bridge._local_run_task({"goal": "cap-verify", "steps": [
                {"id": "t", "tool": "get_time", "args": {},
                 "verify": {"tool": "get_time", "expect": "zzz-no-such-substring"}}],
                "projectId": "test"})
        finally:
            bridge.safe_call = orig
        b = body(r)
        ev = b["evidence"][0]
        self.assertFalse(ev["ok"])
        self.assertIn("detail", ev["verify"])
        self.assertLessEqual(len(ev["verify"]["detail"]), VERIFY_DETAIL_CAP)

    def test_no_evidence_entry_carries_unbounded_text(self):
        r = run(goal="cap-scan", steps=[
            T("t", "validate_command", {"tool": "get_time"})])
        self.assertTrue(r["ok"], r.get("error"))
        b = body(r)
        blob = json.dumps(b["evidence"])
        self.assertLessEqual(len(blob), len(b["evidence"]) * (RESULT_CAP + 2000))


class ArgsShapeTest(unittest.TestCase):
    def test_non_dict_step_args_rejected(self):
        for bad in ("nope", ["x"], 42):
            r = run(steps=[{"id": "a", "tool": "get_time", "args": bad}])
            self.assertFalse(r["ok"], repr(bad))
            self.assertIn("'args' must be an object", r["error"], repr(bad))

    def test_non_dict_verify_args_rejected(self):
        for bad in ("nope", ["x"], 42):
            r = run(steps=[{"id": "a", "tool": "get_time",
                            "args": {}, "verify": {"tool": "get_time", "args": bad}}])
            self.assertFalse(r["ok"], repr(bad))
            self.assertIn("verify 'args' must be an object", r["error"], repr(bad))


# ---------- prompt mirrors -------------------------------------------------

def _decode_ts_string(quote, raw):
    if quote == '"':
        return json.loads('"' + raw + '"')
    # TS single-quoted literal: unescape TS/JS string escapes
    return (raw.replace("\\'", "'")
               .replace('\\"', '"')
               .replace("\\n", "\n")
               .replace("\\t", "\t")
               .replace("\\\\", "\\"))


def _extract_ts_field(block, field):
    m = re.search(re.escape(field) + r":\s*(['\"])((?:\\.|(?!\1).)*?)\1", block, re.S)
    if not m:
        return None
    return _decode_ts_string(m.group(1), m.group(2))


def _extract_js_field(block, field):
    m = re.search('"' + field + r'"\s*:\s*"((?:[^"\\]|\\.)*)"', block)
    if not m:
        return None
    return json.loads('"' + m.group(1) + '"')


def ts_prompt():
    src = read(os.path.join("mcp-server", "src", "tools", "toolPrompts.ts"))
    start = src.find("run_task: {")
    self_check(start >= 0)
    block = src[start:start + 8000]
    return {f: _extract_ts_field(block, f) for f in PROMPT_FIELDS}


def self_check(cond):
    if not cond:
        raise AssertionError("run_task block not found in mirror source")


def json_prompt():
    return load_json(os.path.join("generated", "tool-prompts.json"))["prompts"]["run_task"]


def js_prompt():
    src = read(os.path.join("rolink-extension", "core", "tool-prompts.js"))
    start = src.find('"run_task"')
    self_check(start >= 0)
    block = src[start:start + 8000]
    return {f: _extract_js_field(block, f) for f in PROMPT_FIELDS}


class PromptRegistryTest(unittest.TestCase):
    def test_example_call_tools_all_registered(self):
        registry = set(load_json(os.path.join("tests", "__registry__.json")))
        sources = {
            "toolPrompts.ts": ts_prompt()["example_call"],
            "tool-prompts.json": json_prompt()["example_call"],
            "tool-prompts.js": js_prompt()["example_call"],
        }
        for name, example in sources.items():
            self.assertIsInstance(example, str, name)
            tools = re.findall(r'"tool"\s*:\s*"([^"]+)"', example)
            self.assertTrue(tools, "%s run_task example_call names no tools" % name)
            for t in tools:
                self.assertIn(t, registry,
                              "%s example_call tool %r missing from tests/__registry__.json" % (name, t))

    def test_run_task_prompt_has_six_non_empty_fields(self):
        entry = json_prompt()
        for field in PROMPT_FIELDS:
            self.assertIn(field, entry, "run_task prompt missing field %r" % field)
            self.assertIsInstance(entry[field], str, field)
            self.assertTrue(entry[field].strip(), "run_task prompt field %r is empty" % field)

    def test_three_prompt_mirrors_agree(self):
        ts, js, jsjson = ts_prompt(), js_prompt(), json_prompt()
        for field in PROMPT_FIELDS:
            self.assertIsNotNone(ts[field], "toolPrompts.ts missing %r" % field)
            self.assertIsNotNone(js[field], "tool-prompts.js missing %r" % field)
            self.assertIn(field, jsjson, "tool-prompts.json missing %r" % field)
            self.assertEqual(ts[field], js[field],
                             "toolPrompts.ts vs tool-prompts.js disagree on %r" % field)
            self.assertEqual(ts[field], jsjson[field],
                             "toolPrompts.ts vs tool-prompts.json disagree on %r" % field)


# ---------- code-fields vs registry zod paths ------------------------------

def _zod_string_paths():
    src = read(os.path.join("mcp-server", "src", "tools", "registry.ts"))
    i = src.find('name: "run_task"')
    if i < 0:
        raise AssertionError("run_task not found in registry.ts")
    seg = src[i:i + 8000]
    start = seg.find("z.object(", seg.find("inputSchema:"))
    end = seg.find("handler:")
    schema = seg[start:end].rstrip().rstrip(",")

    class P:
        def __init__(self, s):
            self.s = s
            self.i = 0

        def ws(self):
            while self.i < len(self.s) and self.s[self.i] in " \t\r\n":
                self.i += 1

        def peek(self, t):
            self.ws()
            return self.s.startswith(t, self.i)

        def eat(self, t):
            self.ws()
            if not self.s.startswith(t, self.i):
                raise AssertionError("expected %r at %r" % (t, self.s[self.i:self.i + 40]))
            self.i += len(t)

    def skip_balanced(p, open_c, close_c):
        depth = 1
        while depth:
            c = p.s[p.i]
            if c == open_c:
                depth += 1
            elif c == close_c:
                depth -= 1
            p.i += 1

    def strip_wrappers(p):
        while True:
            p.ws()
            if p.s.startswith(".", p.i):
                m = re.match(r"\.\w+\(", p.s[p.i:])
                if m:
                    p.i += m.end()
                    skip_balanced(p, "(", ")")
                    continue
            break

    def parse_schema(p):
        p.ws()
        if p.peek("z.object"):
            p.eat("z.object")
            p.eat("(")
            p.eat("{")
            fields = []
            while not p.peek("}"):
                m = re.match(r"\s*(\w+)\s*:\s*", p.s[p.i:])
                key = m.group(1)
                p.i += m.end()
                fields.append((key, parse_schema(p)))
                p.ws()
                if p.peek(","):
                    p.eat(",")
            p.eat("}")
            p.eat(")")
            strip_wrappers(p)
            return ("object", fields)
        if p.peek("z.array"):
            p.eat("z.array")
            p.eat("(")
            inner = parse_schema(p)
            p.eat(")")
            strip_wrappers(p)
            return ("array", inner)
        if p.peek("z.record"):
            p.eat("z.record")
            p.eat("(")
            skip_balanced(p, "(", ")")
            strip_wrappers(p)
            return ("record", None)
        if p.peek("z.enum"):
            p.eat("z.enum")
            p.eat("(")
            skip_balanced(p, "(", ")")
            strip_wrappers(p)
            return ("enum", None)
        if p.peek("z.string"):
            p.eat("z.string")
            p.eat("(")
            p.eat(")")
            strip_wrappers(p)
            return ("string", None)
        raise AssertionError("unknown schema at %r" % schema[p.i:p.i + 60])

    def walk(node, prefix, out):
        kind, payload = node
        if kind == "string":
            out.append(prefix)
        elif kind == "object":
            for key, child in payload:
                walk(child, key if not prefix else prefix + "." + key, out)
        elif kind == "array":
            inner_kind, inner = payload
            if inner_kind == "object":
                for key2, child2 in inner:
                    walk(child2, prefix + "[]." + key2, out)
            # array of z.string (depends_on) is not a string-valued field

    out = []
    walk(parse_schema(P(schema)), "", out)
    return sorted(out)


class CodeFieldsTest(unittest.TestCase):
    def test_run_task_fields_match_sorted_zod_paths(self):
        cf = load_json(os.path.join("generated", "code-fields.json"))
        fields = cf["toolFields"]["run_task"]
        self.assertEqual(fields, sorted(fields),
                         "run_task code-fields must be sorted, got %r" % (fields,))
        expected = _zod_string_paths()
        self.assertEqual(fields, expected,
                         "code-fields run_task must equal sorted zod string-paths from registry.ts: %r vs %r"
                         % (fields, expected))
        for needle in ("goal", "projectId", "steps[].id", "steps[].tool",
                       "steps[].verify.tool", "steps[].verify.expect"):
            self.assertIn(needle, fields)


class AtomicNothingToRevertTest(unittest.TestCase):
    def test_atomic_zero_succeeded_skips_rollback(self):
        orig = bridge.safe_call
        calls = []

        def fake(tool, args=None, timeout=None):
            calls.append(tool)
            if tool == "take_snapshot":
                return {"ok": True, "text": json.dumps(
                    {"result": {"snapshot": "rolink-snapshot v1\na\nb"}})}
            return orig(tool, args, timeout)

        bridge.safe_call = fake
        try:
            r = bridge._local_run_task({"goal": "atomic-empty", "steps": [
                {"id": "t", "tool": "definitely_not_a_tool_xyz", "args": {}}],
                "mode": "atomic", "projectId": "test"})
        finally:
            bridge.safe_call = orig
        self.assertNotIn("rollback", calls,
                         "atomic with zero succeeded steps must not call rollback")
        b = body(r)
        self.assertEqual(b["succeeded"], 0)
        self.assertEqual(b["undoneSteps"], 0)
        self.assertTrue(b["rolledBack"], "nothing-to-revert is a successful no-op revert")
        self.assertIn("nothing to revert",
                      b["verification"]["detail"])
        self.assertTrue(b["verification"]["passed"])


class DependsOnFailedNeverRunsTest(unittest.TestCase):
    def test_dependent_step_of_failed_step_never_runs(self):
        r = run(goal="dep-fail", steps=[
            T("a", "definitely_not_a_tool_xyz"),
            T("b", "get_time", depends_on=["a"]),
            T("c", "get_time", depends_on=["b"]),
        ])
        b = body(r)
        self.assertEqual(b["status"], "stopped-at-first-failure")
        self.assertEqual(b["succeeded"], 0)
        ids = [e["id"] for e in b["evidence"]]
        self.assertEqual(ids, ["a"],
                         "dependent steps of a failed step must never execute: %r" % ids)

    def test_dependent_never_runs_even_when_independents_would_succeed(self):
        # The gate is the dependency's failure, not "whatever follows step 0":
        # an independent step that succeeds first must still run and count,
        # while the dependent of the failed step must never be dispatched.
        # (validate_command cannot be used to fail a step: it is a *reporting*
        # tool and answers {"allowed": false} with ok=True.)
        r = run(goal="dep-fail2", steps=[
            T("ok1", "get_time"),
            T("bad", "definitely_not_a_tool_xyz"),
            T("good", "get_time", depends_on=["bad"]),
        ])
        self.assertTrue(r["ok"], r.get("error"))
        b = body(r)
        self.assertEqual(b["status"], "stopped-at-first-failure")
        ids = [e["id"] for e in b["evidence"]]
        self.assertEqual(ids, ["ok1", "bad"], ids)
        self.assertNotIn("good", ids)
        self.assertEqual(b["succeeded"], 1)

    def test_dependent_never_runs_when_dependency_fails_verification(self):
        # Same gate when the dependency fails at the verify stage rather than
        # at the tool call: 'good' must still never run.
        r = run(goal="dep-verify-fail", steps=[
            T("bad", "get_time", verify={"tool": "get_time",
                                         "expect": "zzz-no-such-substring"}),
            T("good", "get_time", depends_on=["bad"]),
        ])
        b = body(r)
        self.assertEqual(b["status"], "stopped-at-first-failure")
        self.assertEqual([e["id"] for e in b["evidence"]], ["bad"])
        self.assertEqual(b["succeeded"], 0)


class VerifyNotRunAfterStepFailureTest(unittest.TestCase):
    """Case 8: a verify block must never execute once its own step failed."""

    def test_verify_is_skipped_when_its_step_failed(self):
        # A failing tool call means the world state is not what verify expects,
        # so running verify anyway would fabricate evidence about a step that
        # never landed. Pin both the spy (never dispatched) and the envelope
        # (no 'verify' key at all on the row).
        orig = bridge.safe_call
        calls = []

        def spy(tool, args=None, timeout=None):
            calls.append(tool)
            return orig(tool, args, timeout)

        bridge.safe_call = spy
        try:
            r = run(goal="verify-skipped", steps=[
                T("bad", "definitely_not_a_tool_xyz",
                  verify={"tool": "get_time", "expect": "T"})])
        finally:
            bridge.safe_call = orig
        self.assertTrue(r["ok"], r.get("error"))
        b = body(r)
        ev = b["evidence"][0]
        self.assertFalse(ev["ok"])
        self.assertNotIn("verify", ev,
                         "verify must not run for a step that failed: %r" % ev)
        self.assertNotIn("get_time", calls,
                         "verify tool was dispatched for a failed step: %r" % calls)

    def test_verify_is_skipped_for_an_intermediate_step_failure(self):
        # Same guarantee when the failing step is not the last one: the row for
        # the failed step carries no verify verdict at all.
        orig = bridge.safe_call
        calls = []

        def spy(tool, args=None, timeout=None):
            calls.append(tool)
            return orig(tool, args, timeout)

        bridge.safe_call = spy
        try:
            r = run(goal="verify-skipped2", steps=[
                T("ok1", "get_time"),
                T("bad", "definitely_not_a_tool_xyz",
                  verify={"tool": "get_time", "expect": "T"})])
        finally:
            bridge.safe_call = orig
        self.assertTrue(r["ok"], r.get("error"))
        b = body(r)
        self.assertEqual([e["id"] for e in b["evidence"]], ["ok1", "bad"])
        self.assertNotIn("verify", b["evidence"][1])
        self.assertEqual(calls.count("get_time"), 1,
                         "get_time must run only as the ok1 step, never as bad's verify: %r" % calls)


if __name__ == "__main__":
    unittest.main(verbosity=2)
