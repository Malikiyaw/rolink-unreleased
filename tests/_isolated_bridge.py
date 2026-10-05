# tests/_isolated_bridge.py - load a private bridge.py instance per queue port.
#
# bridge.py reads ROLINK_QUEUE_PORT at module import (module-level constant),
# and CPython caches one bridge in sys.modules. Tests that each need their own
# port would otherwise all get whichever instance imported first. This loader
# execs bridge.py again under a unique module name so each caller gets its own
# fresh module object with its own QUEUE_PORT, queue state, and HTTP server.
# (In-place importlib.reload would NOT work: the previous instance's queue
# HTTP server would stay bound to its old port via the old module object.)
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
if HERE not in sys.path:
    sys.path.insert(0, HERE)


def load_bridge(port):
    os.environ["ROLINK_QUEUE_PORT"] = str(port)
    name = "_rolink_bridge_{}".format(port)
    spec = importlib.util.spec_from_file_location(
        name, os.path.join(ROOT, "bridge.py"))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod
