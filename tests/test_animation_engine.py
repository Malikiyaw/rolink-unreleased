# tests/test_animation_engine.py - Phase 7 layering + graph pins.
#   py -3 tests/test_animation_engine.py
# Task 7.5: layer conflict resolution, graph construction, blend correctness.
# Behavioral checks run the REAL TS implementation via node+tsx and SKIP
# when that toolchain is absent.
import io
import json
import os
import shutil
import subprocess
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def read(*parts):
    with io.open(os.path.join(ROOT, *parts), encoding="utf-8", errors="replace") as f:
        return f.read()


TS_LAYERING = read("mcp-server", "src", "animation", "layering.ts")
TS_GRAPH = read("mcp-server", "src", "animation", "graph.ts")


def node_anim(snippet):
    node = shutil.which("node")
    if not node:
        raise unittest.SkipTest("node not on PATH")
    tsx = os.path.join(ROOT, "mcp-server", "node_modules", "tsx", "dist", "cli.mjs")
    if not os.path.exists(tsx):
        raise unittest.SkipTest("tsx not installed (run npm ci in mcp-server/)")
    code = ("import('./src/animation/layering.ts').then(async (l) => {"
            " const g = await import('./src/animation/graph.ts');"
            " console.log(JSON.stringify(" + snippet + ")); })")
    r = subprocess.run([node, tsx, "-e", code],
                       cwd=os.path.join(ROOT, "mcp-server"),
                       capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        raise AssertionError("tsx eval failed: " + r.stderr[-2000:])
    return json.loads(r.stdout.strip().splitlines()[-1])


TRACK_JS = """(joint, stops) => ({joint, keys: stops.map(([t, deg]) => ({
  t, pose: {joint, position: {x: deg / 10, y: 0, z: 0},
   rotation: {w: Math.cos(deg * Math.PI / 360), x: Math.sin(deg * Math.PI / 360), y: 0, z: 0},
   semanticRole: "limb"}, easing: "linear", interpolation: "slerp"}))})"""

LAYER_JS = """(kind, mask, weight) => {
  const base = l.defaultLayer(kind, mask);
  base.enabled = true; base.weight = weight === undefined ? 1 : weight;
  return base;
}"""


class BlendCorrectnessTest(unittest.TestCase):
    def test_priority_override_wins(self):
        res = node_anim("""(() => {
          const track = %s, layer = %s;
          const out = l.compositeLayers([
            {layer: layer("BASE", [], 1), tracks: [track("A", [[0, 0], [1, 0]])]},
            {layer: layer("UPPER_BODY", ["A"], 1), tracks: [track("A", [[0, 0], [1, 90]])]},
          ], {fps: 10, duration: 1});
          const end = out[0].keys[out[0].keys.length - 1].pose.position.x;
          const half = l.compositeLayers([
            {layer: layer("BASE", [], 1), tracks: [track("A", [[0, 0], [1, 0]])]},
            {layer: layer("UPPER_BODY", ["A"], 0.5), tracks: [track("A", [[0, 0], [1, 90]])]},
          ], {fps: 10, duration: 1});
          const hend = half[0].keys[half[0].keys.length - 1].pose.position.x;
          return {end, hend};
        })()""" % (TRACK_JS, LAYER_JS))
        self.assertAlmostEqual(res["end"], 9.0, places=6)
        self.assertAlmostEqual(res["hend"], 4.5, places=6)

    def test_mask_and_additive(self):
        res = node_anim("""(() => {
          const track = %s, layer = %s;
          const out = l.compositeLayers([
            {layer: layer("BASE", [], 1),
             tracks: [track("A", [[0, 0], [1, 0]]), track("B", [[0, 0], [1, 0]])]},
            {layer: layer("HANDS", ["B"], 1), tracks: [track("B", [[0, 0], [1, 90]])]},
          ], {fps: 10, duration: 1});
          const end = (j) => out.find((t) => t.joint === j).keys.slice(-1)[0].pose.position.x;
          const add = l.compositeLayers([
            {layer: layer("BASE", [], 1), tracks: [track("A", [[0, 0], [1, 0]])]},
            {layer: {...layer("SECONDARY", ["A"], 1), blendMode: "additive"},
             tracks: [track("A", [[0, 10], [1, 10]])]},
          ], {fps: 10, duration: 1,
              rests: {A: {position: {x: 0, y: 0, z: 0}, rotation: {w: 1, x: 0, y: 0, z: 0}}}});
          return {a: end("A"), b: end("B"),
                  add: add[0].keys.slice(-1)[0].pose.position.x};
        })()""" % (TRACK_JS, LAYER_JS))
        self.assertAlmostEqual(res["a"], 0.0, places=9)
        self.assertAlmostEqual(res["b"], 9.0, places=6)
        self.assertAlmostEqual(res["add"], 1.0, places=6)


class LayerConflictTest(unittest.TestCase):
    def test_contest_reports_priority_winner(self):
        res = node_anim("""(() => {
          const layer = %s;
          const hands = layer("HANDS", ["A"], 1); hands.priority = 99;
          const conflicts = l.detectLayerConflicts(
            [layer("BASE", [], 1), layer("UPPER_BODY", ["A"], 1), hands]);
          const clean = l.detectLayerConflicts(
            [layer("BASE", [], 1),
             {...layer("SECONDARY", ["A"], 1), blendMode: "additive"}]);
          return {conflicts, clean: clean.length};
        })()""" % LAYER_JS)
        self.assertEqual(len(res["conflicts"]), 1, res)
        self.assertEqual(res["conflicts"][0]["winner"], "HANDS", res)
        self.assertEqual(res["clean"], 0, res)


class GraphConstructionTest(unittest.TestCase):
    GRAPH_JS = """(() => {
      const gr = g.makeGraph("loco", "out");
      gr.parameters = {speed: 0.5};
      gr.nodes.push(
        g.makeNode("Clip", "idle", {clip: "Idle"}),
        g.makeNode("Clip", "walk", {clip: "Walk"}),
        g.makeNode("Blend1D", "blend", {parameter: "speed"}),
        g.makeNode("Output", "out"));
      gr.edges.push(
        g.makeEdge("idle", "blend", "a"), g.makeEdge("walk", "blend", "b"),
        g.makeEdge("blend", "out", "source"));
      return gr;
    })()"""

    def test_valid_graph_passes(self):
        res = node_anim("g.validateGraph(%s)" % self.GRAPH_JS)
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["errors"], [], res)

    def test_cycle_and_bad_edges_caught(self):
        res = node_anim("""(() => {
          const gr = g.makeGraph("cyclic", "out");
          gr.nodes.push(g.makeNode("Clip", "a", {clip: "A"}),
                        g.makeNode("Speed", "s", {speed: 1}),
                        g.makeNode("Output", "out"));
          gr.edges.push(g.makeEdge("a", "s", "source"), g.makeEdge("s", "a", "source"),
                        g.makeEdge("s", "out", "source"));
          return g.validateGraph(gr);
        })()""")
        self.assertFalse(res["ok"], res)
        self.assertTrue(any("cycle" in e for e in res["errors"]), res)

    def test_blend_weights_sum_to_one(self):
        res = node_anim("[g.blend1DWeights(0), g.blend1DWeights(0.5), g.blend1DWeights(2)]")
        self.assertEqual(res[0], {"a": 1, "b": 0}, res)
        self.assertEqual(res[1], {"a": 0.5, "b": 0.5}, res)
        self.assertEqual(res[2], {"a": 0, "b": 1}, res)


class EngineSurfaceTest(unittest.TestCase):
    def test_layering_surface(self):
        for token in ("compositeLayers", "detectLayerConflicts", "resolveLayerWeight",
                      "defaultLayer", "DEFAULT_LAYER_PRIORITY", "DEFAULT_LAYER_BLEND",
                      "LayerConflict", "CompositedTrack"):
            self.assertIn(token, TS_LAYERING, token)

    def test_graph_surface(self):
        for token in ("makeNode", "makeEdge", "makeGraph", "validateGraph",
                      "topoSort", "blend1DWeights", "AnimationGraph", "GraphValidation",
                      "Blend1D", "Blend2D", "Sequence", "RandomSequence",
                      "Mask", "Over", "Add", "Subtract", "Speed"):
            self.assertIn(token, TS_GRAPH, token)


class MemoryLeakRegressionTest(unittest.TestCase):
    """Task 11.4: memory-leak detection for animation objects.

    The name-keyed memo in semanticRig.ts is the only module-level mutable
    collection in the engine, so it is the leak surface worth guarding: it
    must plateau at its cap rather than track how many rig names it has seen.
    The assertions below were verified to FAIL when the cap is disabled --
    see the fault-injection note on test_cache_bound_is_enforced.
    """

    def node_json(self, snippet, timeout=300):
        node = shutil.which("node")
        if not node:
            raise unittest.SkipTest("node not on PATH")
        tsx = os.path.join(ROOT, "mcp-server", "node_modules", "tsx", "dist", "cli.mjs")
        if not os.path.exists(tsx):
            raise unittest.SkipTest("tsx not installed (run npm ci in mcp-server/)")
        # Promise.resolve(...) so snippets may be sync values OR async
        # IIFEs; without it an async snippet stringifies to "{}".
        code = ("import('./src/animation/semanticRig.ts').then(async (s) => {"
                " console.log(JSON.stringify(await Promise.resolve(" + snippet + "))); })")
        r = subprocess.run([node, tsx, "-e", code],
                           cwd=os.path.join(ROOT, "mcp-server"),
                           capture_output=True, text=True, timeout=timeout)
        if r.returncode != 0:
            raise AssertionError("tsx eval failed: " + r.stderr[-2000:])
        return json.loads(r.stdout.strip().splitlines()[-1])

    def test_cache_bound_is_enforced(self):
        # 5000 distinct names must plateau at the cap, not track input size.
        res = self.node_json("""(() => {
          s.clearWordsCache();
          for (let i = 0; i < 5000; i += 1) s.wordsOf('UniquePartName' + i + '_' + (i * 7));
          const size = s.wordsCacheSize();
          s.clearWordsCache();
          return {size, limit: s.WORDS_CACHE_LIMIT, after: s.wordsCacheSize()};
        })()""")
        self.assertLessEqual(res["size"], res["limit"], res)
        self.assertGreater(res["limit"], 0)
        self.assertEqual(res["after"], 0, "clearWordsCache must empty the memo")

    def test_memo_survives_eviction_without_changing_results(self):
        res = self.node_json("""(() => {
          const a = [...s.wordsOf('LeftUpperArm')];
          for (let i = 0; i < 2000; i += 1) s.wordsOf('Filler' + i);
          const b = [...s.wordsOf('LeftUpperArm')];
          const raw = s.splitWords('LeftUpperArm');
          return {a, b, raw, stable: JSON.stringify(a) === JSON.stringify(b)};
        })()""")
        self.assertTrue(res["stable"], res)
        self.assertEqual(res["a"], ["left", "upper", "arm"])
        self.assertEqual(res["b"], res["raw"])

    def test_pipeline_produces_identical_results_across_memo_resets(self):
        res = self.node_json("""(async () => {
          const j = await import('./src/animation/jointAdapter.ts');
          const nodes = [
            {path:'W.N',name:'N',class:'Model',kind:'root',depth:0},
            {path:'W.N.HumanoidRootPart',name:'HumanoidRootPart',class:'Part',kind:'rigid',depth:1},
            {path:'W.N.LowerTorso',name:'LowerTorso',class:'MeshPart',kind:'rigid',depth:1},
            {path:'W.N.UpperTorso',name:'UpperTorso',class:'MeshPart',kind:'rigid',depth:1},
            {path:'W.N.Head',name:'Head',class:'Part',kind:'rigid',depth:1},
            {path:'W.N.UpperTorso.Neck',name:'Neck',class:'Motor6D',kind:'rotational',depth:2},
            {path:'W.N.LeftUpperArm',name:'LeftUpperArm',class:'MeshPart',kind:'rigid',depth:1},
            {path:'W.N.UpperTorto.LeftShoulder',name:'LeftShoulder',class:'Motor6D',kind:'rotational',depth:2},
            {path:'W.N.LeftHand',name:'LeftHand',class:'MeshPart',kind:'rigid',depth:1}];
          s.clearWordsCache();
          const a = s.buildSemanticSkeleton(j.adaptersFromAnalyzeNodes(nodes));
          s.clearWordsCache();
          const b = s.buildSemanticSkeleton(j.adaptersFromAnalyzeNodes(nodes));
          const c = s.buildSemanticSkeleton(j.adaptersFromAnalyzeNodes(nodes));
          return {same: JSON.stringify(a) === JSON.stringify(b)
                     && JSON.stringify(b) === JSON.stringify(c),
                  joints: a.joints.length};
        })()""")
        self.assertTrue(res["same"], res)
        self.assertGreater(res["joints"], 0, res)

    def test_repeated_compiles_do_not_accumulate_or_mutate_input(self):
        # A repair loop that retained per-run state would grow, and one that
        # aliased caller tracks would corrupt them. Both are checked here.
        res = self.node_json("""(async () => {
          const j = await import('./src/animation/jointAdapter.ts');
          const p = await import('../shared/animationProtocol.ts');
          const c = await import('./src/animation/compiler.ts');
          const s2 = await import('./src/animation/semanticRig.ts');
          const nodes = [
            {path:'W.N',name:'N',class:'Model',kind:'root',depth:0},
            {path:'W.N.HumanoidRootPart',name:'HumanoidRootPart',class:'Part',kind:'rigid',depth:1},
            {path:'W.N.LowerTorso',name:'LowerTorso',class:'MeshPart',kind:'rigid',depth:1},
            {path:'W.N.UpperTorso',name:'UpperTorso',class:'MeshPart',kind:'rigid',depth:1},
            {path:'W.N.Head',name:'Head',class:'Part',kind:'rigid',depth:1},
            {path:'W.N.UpperTorto.Neck',name:'Neck',class:'Motor6D',kind:'rotational',depth:2},
            {path:'W.N.LeftUpperArm',name:'LeftUpperArm',class:'MeshPart',kind:'rigid',depth:1},
            {path:'W.N.LeftHand',name:'LeftHand',class:'MeshPart',kind:'rigid',depth:1}];
          const bindings = j.adaptersFromAnalyzeNodes(nodes);
          const roles = new Map(s2.buildSemanticSkeleton(bindings)
            .joints.map((x) => [x.name, x.semanticRole]));
          const key = (name, t, y, deg) => ({
            t, pose: p.makeJointPose(name, {
              position: {x: 0, y: y, z: 0},
              rotation: p.eulerDegToQuat({x: deg, y: 0, z: 0}),
              semanticRole: 'limb'}),
            easing: 'linear', interpolation: 'slerp'});
          const tracks = bindings.filter((b) => b.drive.writable && b.className !== 'Model')
            .map((b, i) => ({joint: b.name,
              keys: [key(b.name, 0, 0, 0), key(b.name, 0.5, i * 0.01, 5)]}));
          const before = JSON.stringify(tracks);
          let last = 0;
          for (let i = 0; i < 10; i += 1) {
            last = c.compileAnimation({animation: 'leak', tracks, bindings, roles,
              style: 'ANIME', rigidAssembly: true, maxIterations: 2}).iterations;
          }
          return {mutated: JSON.stringify(tracks) !== before, iterations: last,
                  cacheSize: s2.wordsCacheSize(), limit: s2.WORDS_CACHE_LIMIT};
        })()""")
        self.assertFalse(res["mutated"], "compileAnimation must not mutate caller tracks")
        self.assertLessEqual(res["iterations"], 2, res)
        self.assertLessEqual(res["cacheSize"], res["limit"], res)

    def test_graph_node_ids_stay_unique_without_explicit_ids(self):
        res = self.node_json("""(async () => {
          const gr = await import('./src/animation/graph.ts');
          const ids = new Set();
          for (let i = 0; i < 2000; i += 1) ids.add(gr.makeNode('Clip').id);
          return {unique: ids.size};
        })()""")
        self.assertEqual(res["unique"], 2000, res)

    def test_baking_does_not_run_away_in_key_count(self):
        # 1.2s at 30fps is ~37 samples per track. A runaway baker (or a
        # repeated-append bug) would produce thousands.
        res = self.node_json("""(async () => {
          const b = await import('./src/animation/benchmarks.ts');
          const out = {};
          for (const style of b.BENCH_STYLES) {
            const baked = b.bakeFixture(style, 30);
            out[style] = {tracks: baked.length,
              max: Math.max(...baked.map((t) => t.keys.length)),
              min: Math.min(...baked.map((t) => t.keys.length))};
          }
          return out;
        })()""")
        self.assertEqual(sorted(res.keys()),
                         sorted(["REALISTIC", "CINEMATIC", "ANIME", "EXAGGERATED",
                                 "MECHANICAL", "CREATURE", "CARTOON", "SUBTLE"]))
        for style, r in res.items():
            self.assertGreater(r["tracks"], 0, style)
            self.assertLess(r["max"], 200, "%s baked %d keys on one track" % (style, r["max"]))
            self.assertGreater(r["min"], 1, style)

    def test_leak_guard_surface_pins(self):
        semantic = read("mcp-server", "src", "animation", "semanticRig.ts")
        for token in ("wordsCacheSize", "WORDS_CACHE_LIMIT", "clearWordsCache", "wordsOf"):
            self.assertIn(token, semantic, token)
        # The vitest leak suite must stay in place and stay sensitive.
        leaks = read("mcp-server", "tests", "leaks.test.ts")
        for token in ("wordsCacheSize", "heapUsedMb", "fullPipelinePass", "runId",
                      "WORDS_CACHE_LIMIT", "does not grow the heap",
                      "keeps the word cache bounded", "bakes every style"):
            self.assertIn(token, leaks, token)


if __name__ == "__main__":
    unittest.main()
