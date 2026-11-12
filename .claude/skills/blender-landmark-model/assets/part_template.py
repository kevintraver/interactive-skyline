"""<PART> of <LANDMARK>: <what this part covers, e.g. "the three legs and the core from the ground to 80 m">.

Written by one part-modeler while others write their parts at the same time. Shared numbers, colors and
the glow rules live in spec.py, which only the orchestrator edits: use its materials, and if a new one is
really needed, say so in your report and use the closest existing one meanwhile.

Build and look at just this part:
    python <skill>/scripts/run_blender.py build_<stem>.py -- --only <part> --out work/<part> --allow-errors
    python <skill>/scripts/run_blender.py <skill>/scripts/render_views.py --blend work/<part>/<stem>.blend -- --out work/<part>/renders
"""
import math  # noqa: F401

import landmark_kit as kit
from spec import *  # noqa: F401,F403  (dimensions, COLORS, glow)


def build(b: kit.Builder) -> None:
    raise NotImplementedError("<PART>")
