"""The airframe (plan 03, F3.3): public/models/aircraft/airframe.glb, rig.json, and the build's mesh report.

Built by models/aircraft/build_airframe.py in headless Blender. Checked here from the files alone: the overall
length, span and tail height against the manufacturer's figures (within 1%), the triangle budget, the file size,
the moving parts as named nodes with their pivots, the rig table's shape, the baked light attributes, and that
nothing is named after an airline or a maker.
"""
import importlib.util
import json
import math
import struct
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "public" / "models" / "aircraft"
GLB = OUT / "airframe.glb"
RIG = OUT / "rig.json"
REPORT = ROOT / "models" / "aircraft" / "airframe.report.json"


@pytest.fixture(scope="module")
def spec():
    loader = importlib.util.spec_from_file_location("aircraft_spec_af", ROOT / "models" / "aircraft" / "spec.py")
    module = importlib.util.module_from_spec(loader)
    sys.modules[loader.name] = module
    loader.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def glb():
    data = GLB.read_bytes()
    assert data[:4] == b"glTF"
    n = struct.unpack_from("<I", data, 12)[0]
    doc = json.loads(data[20:20 + n])
    bin_len = struct.unpack_from("<I", data, 20 + n)[0]
    doc["_bin"] = data[28 + n:28 + n + bin_len]
    doc["_size"] = len(data)
    return doc


@pytest.fixture(scope="module")
def rig():
    return json.loads(RIG.read_text())


def accessor(doc, index):
    acc = doc["accessors"][index]
    view = doc["bufferViews"][acc["bufferView"]]
    comps = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[acc["type"]]
    dtype = {5126: np.float32, 5123: np.uint16, 5125: np.uint32, 5121: np.uint8}[acc["componentType"]]
    start = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
    itemsize = np.dtype(dtype).itemsize
    stride = view.get("byteStride", itemsize * comps)
    raw = np.frombuffer(doc["_bin"], dtype=np.uint8, count=stride * (acc["count"] - 1) + itemsize * comps,
                        offset=start)
    rows = np.lib.stride_tricks.as_strided(raw, shape=(acc["count"], itemsize * comps), strides=(stride, 1))
    return np.ascontiguousarray(rows).view(dtype).reshape(acc["count"], comps)


def world_offsets(doc):
    """Node name -> world translation (every node's rest rotation is identity), and name -> node."""
    out, by_name = {}, {}
    def visit(i, base):
        node = doc["nodes"][i]
        assert "rotation" not in node or np.allclose(node["rotation"], [0, 0, 0, 1], atol=1e-6), node["name"]
        assert "scale" not in node or np.allclose(node["scale"], [1, 1, 1]), node["name"]
        t = base + np.array(node.get("translation", [0, 0, 0]), dtype=float)
        out[node["name"]] = t
        by_name[node["name"]] = node
        for c in node.get("children", []):
            visit(c, t)
    for root in doc["scenes"][doc.get("scene", 0)]["nodes"]:
        visit(root, np.zeros(3))
    return out, by_name


def world_points(doc, skip=("ShadowProxy",)):
    offsets, nodes = world_offsets(doc)
    pts = []
    for name, node in nodes.items():
        if "mesh" not in node or name in skip:
            continue
        for prim in doc["meshes"][node["mesh"]]["primitives"]:
            pts.append(accessor(doc, prim["attributes"]["POSITION"]) + offsets[name])
    return np.vstack(pts)


def triangles(doc, names):
    _, nodes = world_offsets(doc)
    total = 0
    for name in names:
        for prim in doc["meshes"][nodes[name]["mesh"]]["primitives"]:
            total += doc["accessors"][prim["indices"]]["count"] // 3
    return total


def test_length_span_and_tail_height_within_one_percent(glb, spec):
    p = world_points(glb)
    length = p[:, 2].max() - p[:, 2].min()
    span = p[:, 0].max() - p[:, 0].min()
    pitch = math.radians(float(spec.GROUND_ATTITUDE))      # nose down, negative
    ground_height = p[:, 1] * math.cos(pitch) + (-p[:, 2]) * math.sin(pitch)  # forward is -Z
    tail = ground_height.max() - ground_height.min()        # the lowest points are the main tyres
    assert length == pytest.approx(float(spec.LENGTH_OVERALL), rel=0.01)
    assert span == pytest.approx(float(spec.SPAN_WINGLETS), rel=0.01)
    assert tail == pytest.approx(float(spec.TAIL_HEIGHT), rel=0.01)
    assert tail == pytest.approx(float(spec.TAIL_HEIGHT_OEW), rel=0.01)


def test_the_origin_is_the_main_gear_contact_point(glb, spec):
    p = world_points(glb)
    assert p[:, 1].min() == pytest.approx(0.0, abs=0.01)    # main tyres touch y = 0
    assert abs(p[:, 0].max() + p[:, 0].min()) < 0.02        # symmetric about the centre line
    assert -p[:, 2].min() == pytest.approx(float(spec.STATIONS["main_gear"]), abs=0.05)


def test_triangle_budget_and_file_size(glb, spec):
    _, nodes = world_offsets(glb)
    meshes = [n for n, node in nodes.items() if "mesh" in node]
    parts = [n for n in meshes if n != "ShadowProxy"]
    assert triangles(glb, parts) < float(spec.BUDGET["airframe_tris"])
    assert "ShadowProxy" in meshes
    assert triangles(glb, ["ShadowProxy"]) <= float(spec.BUDGET["shadow_tris"])
    assert glb["_size"] <= float(spec.BUDGET["glb_bytes"])


MOVING = (["FlapInboard", "FlapInboardAft", "FlapOutboard", "FlapOutboardAft", "Aileron", "ReverserSleeve",
           "MainGear"] + [f"Slat{i}" for i in range(1, 5)] + [f"Krueger{i}" for i in range(1, 3)]
          + [f"Spoiler{i}" for i in range(1, 7)])


def test_moving_parts_are_named_nodes_with_light_attributes(glb):
    _, nodes = world_offsets(glb)
    expected = {f"{p}_{s}" for p in MOVING for s in "LR"} | {"NoseGear", "Body", "Wing_L", "Wing_R",
                                                               "Engine_L", "Engine_R", "ShadowProxy"}
    assert expected <= set(nodes), sorted(expected - set(nodes))
    for name, node in nodes.items():
        if "mesh" not in node or name == "ShadowProxy":
            continue
        for prim in glb["meshes"][node["mesh"]]["primitives"]:
            attrs = prim["attributes"]
            assert {"_LIGHTS0", "_LIGHTS1"} <= set(attrs), name
            for a in ("_LIGHTS0", "_LIGHTS1"):
                acc = glb["accessors"][attrs[a]]
                assert acc["type"] == "VEC4" and acc.get("normalized") and acc["componentType"] == 5123
            assert "COLOR_0" not in attrs and "_GLOW" not in attrs


def test_the_wing_lamps_light_the_winglets(glb):
    """The right wingtip and winglet get light from the green position light (NAV, _LIGHTS0.x) and the strobe
    (.z), both at the tip's leading edge. Baked values are relative to each lamp's on-axis light at 1 m; 0.02
    is 1/50 of that (the app scales by each lamp's intensity)."""
    offsets, nodes = world_offsets(glb)
    node = nodes["Wing_R"]
    lit_nav = lit_strobe = 0
    for prim in glb["meshes"][node["mesh"]]["primitives"]:
        pos = accessor(glb, prim["attributes"]["POSITION"]) + offsets["Wing_R"]
        l0 = accessor(glb, prim["attributes"]["_LIGHTS0"]).astype(float) / 65535
        tip = pos[:, 0] > 17.2
        lit_nav += int((l0[tip, 0] > 0.02).sum())
        lit_strobe += int((l0[tip, 2] > 0.02).sum())
    assert lit_nav > 10 and lit_strobe > 10


def test_rig_table_matches_the_nodes(glb, rig, spec):
    offsets, nodes = world_offsets(glb)
    assert rig["frame"]["up"] == "+Y" and rig["frame"]["nose"] == "-Z"
    assert rig["groundPitchDeg"] == pytest.approx(float(spec.GROUND_ATTITUDE), abs=1e-3)
    by_node = {p["node"]: p for p in rig["parts"]}
    for name in [f"{p}_{s}" for p in MOVING for s in "LR"] + ["NoseGear"]:
        part = by_node[name]
        assert np.allclose(part["pivot"], offsets[name], atol=2e-3), name
        assert math.isclose(np.linalg.norm(part["axis"]), 1.0, abs_tol=1e-4), name
        assert part["parent"] in nodes
        assert part["tables"], name
        for channel, rows in part["tables"].items():
            assert channel in rig["channels"], (name, channel)
            ats = [r["at"] for r in rows]
            assert ats == sorted(ats) and len(rows) >= 2
            for r in rows:
                assert len(r["t"]) == 3 and isinstance(r["r"], (int, float))
    flap_rows = by_node["FlapOutboard_R"]["tables"]["flap"]
    assert [r["at"] for r in flap_rows] == [0, 1, 2, 5, 10, 15, 25, 30, 40]
    assert flap_rows[0]["r"] == 0 and flap_rows[-1]["r"] > 20
    # both wings' flaps go trailing edge down for a positive angle: the axis points outboard on the right and
    # inboard on the left, so the same table reads the same way on both sides
    r, l = by_node["FlapOutboard_R"]["axis"], by_node["FlapOutboard_L"]["axis"]
    assert r[0] > 0.8 and l[0] > 0.8
    gear = by_node["MainGear_R"]["tables"]["gear"]
    assert gear[-1]["at"] == 1 and gear[-1]["r"] == 0 and gear[0]["r"] > 60


def test_mesh_report_is_clean(spec):
    report = json.loads(REPORT.read_text())
    assert report["errors"] == []
    assert report["tris"] < float(spec.BUDGET["airframe_tris"])
    for name, part in report["parts"].items():
        assert part["degenerate_faces"] == 0 and part["loose_verts"] == 0 and part["inside_out_islands"] == 0, name


def test_no_branding_in_names(glb):
    names = [n.get("name", "") for key in ("nodes", "meshes", "materials") for n in glb.get(key, [])]
    banned = ("boeing", "southwest", "ryanair", "united", "delta", "american", "alaska", "logo", "cfm")
    assert not [n for n in names if any(b in n.lower() for b in banned)]


def test_main_gear_leg_stands_ahead_of_the_flap_cove(rig):
    """The leg's trunnion is inside the wing box, ahead of the inboard flap's nose, so the slot that opens behind the
    wing with the flaps out does not show the top of the leg (it did, at the gear station, 0.16 m behind the hinge)."""
    by_node = {p["node"]: p for p in rig["parts"]}
    for s in "LR":
        gear, flap = by_node[f"MainGear_{s}"], by_node[f"FlapInboard_{s}"]
        # the flap's hinge line at the gear's buttock line
        ax, p = np.array(flap["axis"]), np.array(flap["pivot"])
        hinge_z = p[2] + ax[2] / ax[0] * (gear["pivot"][0] - p[0])
        assert gear["pivot"][2] < hinge_z - 0.25, (s, gear["pivot"], hinge_z)


def test_flap_track_fairings_droop_with_the_main_flap_at_30_and_40(rig):
    """The aft fairings ride the main flap, so at the landing detents the main flap carries most of the angle (the
    fairings visibly droop in photographs of the type at 30 and 40), and main + aft flap is still the lever's angle."""
    by_node = {p["node"]: p for p in rig["parts"]}
    for s in "LR":
        for name in ("Inboard", "Outboard"):
            main = {r["at"]: r["r"] for r in by_node[f"Flap{name}_{s}"]["tables"]["flap"]}
            aft = {r["at"]: r["r"] for r in by_node[f"Flap{name}Aft_{s}"]["tables"]["flap"]}
            assert main[30] >= 24 and main[40] >= 30, (name, s, main)
            assert main[30] + aft[30] == pytest.approx(30) and main[40] + aft[40] == pytest.approx(40)
            levers = sorted(main)
            assert all(main[a] <= main[b] for a, b in zip(levers, levers[1:]))
