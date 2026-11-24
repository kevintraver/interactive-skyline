"""A two-part model that exercises aircraft_kit.py (plan 03, F3.2): tests/unit/flight/aircraftKit.test.js loads it.

    python .claude/skills/blender-landmark-model/scripts/run_blender.py models/aircraft/build_kit_fixture.py \
        -- --out tests/fixtures/flight/kit-two-parts.glb

Base: a 2 x 3 x 1 m box on the origin. Flap: a 1 m x 1 m x 0.1 m plate hinged on its leading edge at the base's
aft top edge, a child of Base. Three lamps: NAV above the flap, TURNOFF above the base, STROBE under the base
(which the base hides from the flap's underside). The numbers are a test fixture's, not an aircraft's.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import aircraft_kit as ak  # noqa: E402

COLORS = {"Paint": "F2F2F0", "Metal": "A0A4A8"}


def build(out: str) -> dict:
    ak.reset_scene()
    model = ak.Model("KitFixture")
    b = ak.PartBuilder(COLORS)
    b.block((0.0, 0.0), 1.0, 1.5, 0.0, 1.0, "Paint")
    model.part(b, "Base", pivot=(0.0, 0.0, 0.0), axis=(0.0, 0.0, 1.0))
    f = ak.PartBuilder(COLORS, smooth_deg=30.0)
    f.block((0.0, -2.0), 0.5, 0.5, 0.95, 1.05, "Metal", top="Paint")
    model.part(f, "Flap", pivot=(0.0, -1.5, 1.0), axis=(1.0, 0.0, 0.0), parent="Base")
    lamps = [
        ak.Lamp("nav", (0.0, -2.0, 2.0), (0.0, 0.0, -1.0), 120.0, 0),
        ak.Lamp("strobe", (0.0, 0.0, -0.5), (0.0, 0.0, 1.0), 179.0, 2),
        ak.Lamp("turnoff", (0.0, 0.0, 2.0), (0.0, 0.0, -1.0), 170.0, 5),
    ]
    stats = model.bake_lights(lamps)
    report = model.check(max_tris=100)
    if report["errors"]:
        raise RuntimeError("; ".join(report["errors"]))
    model.export(out)
    return {"stats": stats, "tris": report["tris"]}


if __name__ == "__main__":
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    out = os.path.abspath(args[args.index("--out") + 1]) if "--out" in args else os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "kit-two-parts.glb")
    print(build(out))
    print("wrote", out, os.path.getsize(out), "bytes")
