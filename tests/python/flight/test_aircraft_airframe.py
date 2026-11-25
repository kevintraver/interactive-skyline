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


# ------------------------------------------------------------------------------------------------ the lamps' light
# The night view's defects (plan 03, "Found while putting the airframe in the app", and the F3.8 re-bake), each as a
# measurement on the baked attributes in the app's units: lux on the skin = baked x candela of the lamp, luminance =
# lux x albedo / pi, and the HDR value = luminance x the app's night pre-exposure. A value near 0.02 is a just-visible
# glow against a black sky; above about 1.5 a colour clips to white through the tone curve.
NIGHT_EXPOSURE = 0.1        # tests/manual/flight-airframe.js K_NIGHT, about the app's own over a lit city
ALBEDO = 0.7                # the airframe's paints are 0.55 (grey) to 0.9 (white); one value is enough here
VISIBLE, CLIPS = 0.02, 1.5
GROUPS = ["NAV", "BEACON", "STROBE", "LANDING", "TAXI", "TURNOFF", "LOGO", "WING"]
# the first version had no candela in rig.json; these are src/flight/aircraft/lights.js's values of that version
LEGACY_CANDELA = {"NAV": 100, "BEACON": 1000, "STROBE": 5000, "LANDING": 300000, "TAXI": 40000, "TURNOFF": 40000,
                  "LOGO": 5000, "WING": 2000}


def srgb_decode(v):
    return np.where(v <= 0.04045, v / 12.92, ((v + 0.055) / 1.055) ** 2.4)


def baked(doc, rig, name, materials=False):
    """Positions (body axes), normals and the baked light of node `name` decoded as rig.json says (lux per candela
    of each channel's lamps, one column per channel), or as the first version's app decoded it; with `materials`,
    also each corner's material name."""
    offsets, nodes = world_offsets(doc)
    bake = rig.get("lightBake")
    P, N, E, M = [], [], [], []
    for prim in doc["meshes"][nodes[name]["mesh"]]["primitives"]:
        a = prim["attributes"]
        P.append(accessor(doc, a["POSITION"]) + offsets[name])
        M += [doc["materials"][prim["material"]]["name"]] * len(P[-1])
        N.append(accessor(doc, a["NORMAL"]).astype(float))
        v = np.hstack([accessor(doc, a["_LIGHTS0"]), accessor(doc, a["_LIGHTS1"])]).astype(float) / 65535
        if bake:
            assert bake["encoding"] == "sqrt"
            E.append(v ** 2 * np.array([bake["scale"][g] for g in bake["channels"]]))
        else:
            E.append(srgb_decode(v))
    if materials:
        return np.vstack(P), np.vstack(N), np.vstack(E), np.array(M)
    return np.vstack(P), np.vstack(N), np.vstack(E)


def candela(rig, key):
    return rig["lightBake"]["candela"][key] if "lightBake" in rig else LEGACY_CANDELA[key]


def hdr(E, cd, exposure=NIGHT_EXPOSURE):
    return E * cd * ALBEDO / math.pi * exposure


# src/render/exposure.js eye mode away from the city's glow (a quarter moon, prior EV100 near -6) exposes about ten
# times brighter than over the lit city; faint glows are judged there
DARK_EXPOSURE = 1.0


def lamp(rig, name):
    return np.array(rig["lights"][name]["position"])


def test_the_bake_states_its_encoding_and_scale(rig):
    """rig.json says how the attributes decode (lux per candela = code^2 x scale, per channel) and the intensities
    the app multiplies them by; the scale is each channel's largest value, so nothing is clipped."""
    bake = rig["lightBake"]
    assert bake["encoding"] == "sqrt"
    assert bake["channels"] == GROUPS
    assert set(bake["scale"]) == set(GROUPS) and all(s > 0 for s in bake["scale"].values())
    assert set(GROUPS) <= set(bake["candela"]) and bake["candela"]["NAV_AFT"] > 0


def test_no_channel_clips(glb, rig):
    """At most a handful of corners in any channel sit at the top code: the first version stored min(1, E) and
    whole patches of the winglet and the strobe's surroundings sat at 1."""
    _, nodes = world_offsets(glb)
    top = {g: 0 for g in GROUPS}
    lit = {g: 0 for g in GROUPS}
    for name, node in nodes.items():
        if "mesh" not in node or name == "ShadowProxy":
            continue
        for prim in glb["meshes"][node["mesh"]]["primitives"]:
            a = prim["attributes"]
            v = np.hstack([accessor(glb, a["_LIGHTS0"]), accessor(glb, a["_LIGHTS1"])])
            for c, g in enumerate(GROUPS):
                top[g] += int((v[:, c] == 65535).sum())
                lit[g] += int((v[:, c] > 0).sum())
    assert all(top[g] <= 4 for g in GROUPS), top


def winglet_inner(glb, rig, side="R"):
    P, N, E = baked(glb, rig, f"Wing_{side}")
    s = 1 if side == "R" else -1
    nav = lamp(rig, "nav_right" if side == "R" else "nav_left")
    sel = (s * P[:, 0] > 17.2) & (P[:, 1] > 4.0) & (s * N[:, 0] < -0.6) & (np.linalg.norm(P - nav, axis=1) > 0.5)
    assert sel.sum() >= 8
    return P[sel], E[sel]


def nav_white_share(rig, P, E):
    """The share of the white aft position light in the position lights' luminance at each corner."""
    if "lightBake" in rig:
        green = E[:, 0] * candela(rig, "NAV")
        aft = rig["lightBake"]["mux"]["TAXI"]
        white = np.where(np.abs(P[:, 0]) >= aft["outboardOf"], E[:, 4] * candela(rig, "NAV_AFT"), 0.0)
        return white / np.maximum(green + white, 1e-12)
    # the first version's app: the white share is the inverse-square share of the aft lamp (lightsDraw.js)
    side = "right" if P[0, 0] > 0 else "left"
    df2 = ((P - lamp(rig, f"nav_{side}")) ** 2).sum(1)
    da2 = ((P - lamp(rig, f"nav_aft_{side}")) ** 2).sum(1)
    return df2 / (df2 + da2)


@pytest.mark.parametrize("side", ["R", "L"])
def test_the_winglet_glows_the_position_lights_colour_without_clipping(glb, rig, side):
    """The winglet's inner face, which the passenger sees, glows green (right) or red (left) from the position light
    at its root: coloured, not white; below the tone curve's clip away from the lamp itself at the night exposure
    over the city; and a visible glow on its lower half under a dark sky. The lamp sits at the winglet's root and
    throws only a few candela up and back at it, so the glow fades up the winglet. (The aft corner by the trailing
    edge, which the tip hides from that lamp, takes a little white from the aft position light below it.)"""
    P, E = winglet_inner(glb, rig, side)
    nav = lamp(rig, "nav_right" if side == "R" else "nav_left")
    v = hdr(E[:, 0], candela(rig, "NAV"))
    assert np.percentile(v, 90) < CLIPS, np.percentile(v, 90)
    lower = np.linalg.norm(P - nav, axis=1) < 1.8
    assert lower.sum() >= 4
    dark = hdr(E[lower, 0], candela(rig, "NAV"), DARK_EXPOSURE)
    assert np.median(dark) > VISIBLE, np.median(dark)
    share = nav_white_share(rig, P[lower], E[lower])
    assert np.median(share) < 0.2, np.median(share)


def test_the_strobe_flashes_the_whole_winglet(glb, rig):
    P, E = winglet_inner(glb, rig)
    v = hdr(E[:, 2], candela(rig, "STROBE"))
    assert (v > 0.1).mean() > 0.8, np.round(np.percentile(v, [10, 50, 90]), 3)


def test_the_belly_beacon_pulses_the_nacelle_and_the_flap_fairings(glb, rig):
    """The belly beacon lights the inboard side and underside of the nacelle and the inboard flap-track fairing."""
    cd = candela(rig, "BEACON")
    P, N, E, M = baked(glb, rig, "Engine_R", materials=True)
    cowl = (M == "Paint") & (N[:, 0] < -0.5) & (P[:, 0] < 4.83)   # the fan cowl's inboard side, outside
    assert cowl.sum() > 10 and np.median(hdr(E[cowl, 1], cd)) > 0.05, np.median(hdr(E[cowl, 1], cd))
    fy = 3.6   # spec.FLAPS fairings_y, the canoe inboard of the engine
    pts = []
    for name in ("Wing_R", "FlapInboard_R"):
        P, N, E = baked(glb, rig, name)
        sel = (np.abs(P[:, 0] - fy) < 0.3) & (N[:, 0] < -0.3) & (P[:, 1] < 2.2)   # the canoe's inboard side
        pts.append(hdr(E[sel, 1], cd))
    v = np.concatenate(pts)
    assert len(v) >= 8 and np.median(v) > 0.05, (len(v), np.median(v) if len(v) else None)


def test_the_beacons_reach_the_wing_and_the_fin(glb, rig):
    """The upper beacon reaches the outer wing's upper surface past the fuselage's shoulder, the fin and the crown;
    the belly beacon the wing's underside inboard of the engine."""
    cd = candela(rig, "BEACON")
    P, N, E = baked(glb, rig, "Wing_R")
    upper = (N[:, 1] > 0.8) & (P[:, 0] > 9) & (P[:, 0] < 15)
    assert (hdr(E[upper, 1], cd) > 0.005).mean() > 0.5
    lower_in = (N[:, 1] < -0.8) & (P[:, 0] > 2.3) & (P[:, 0] < 3.5)
    assert (hdr(E[lower_in, 1], cd) > 0.02).mean() > 0.5
    P, N, E = baked(glb, rig, "Body")
    top = lamp(rig, "beacon_top")
    d = np.linalg.norm(P - top, axis=1)
    crown = (N[:, 1] > 0.97) & (d > 1) & (d < 4)    # along the crown line, ahead of and behind the beacon
    assert crown.sum() > 4 and np.median(hdr(E[crown, 1], cd)) > VISIBLE, np.median(hdr(E[crown, 1], cd))
    fin_le = (P[:, 1] > 7) & (N[:, 2] < -0.5)
    assert fin_le.sum() > 4 and np.median(hdr(E[fin_le, 1], cd)) > VISIBLE / 2


def test_the_nacelle_shadows_the_wing_from_the_belly_beacon(glb, rig):
    """Seen from the belly beacon, the pylon and nacelle hide part of the wing's underside just outboard of them."""
    P, N, E = baked(glb, rig, "Wing_R")
    behind = (N[:, 1] < -0.8) & (P[:, 0] > 5.5) & (P[:, 0] < 8) & (P[:, 2] > -3) & (P[:, 2] < 0)
    assert behind.sum() > 4 and (E[behind, 1] == 0).mean() > 0.2


def test_the_wing_shadows_the_fuselage_from_the_wingtip_lamps(glb, rig):
    P, N, E = baked(glb, rig, "Body")
    side = (N[:, 0] > 0.6) & (P[:, 2] > -4) & (P[:, 2] < 1)
    below, above = side & (P[:, 1] < 2.8), side & (P[:, 1] > 3.6)
    assert below.sum() > 4 and above.sum() > 4
    assert (E[below, 2] == 0).mean() > 0.9
    assert (E[above, 2] > 0).mean() > 0.5


def test_the_landing_lights_spill_onto_the_nacelle_and_light_nothing_behind_them(glb, rig):
    """A landing light's beam goes ahead; its spill (lens and reflector-rim scatter, 30 to 40 degrees off its axis)
    lights the inboard side of the nacelle's inlet beside it. The recess it sits in keeps it off the forward fuselage,
    and nothing aft of the lamp's lens plane (the wing's upper surface, the flaps and their fairings) gets its light."""
    cd = candela(rig, "LANDING")
    P, N, E, M = baked(glb, rig, "Engine_R", materials=True)
    inlet_in = (M == "Paint") & (N[:, 0] < -0.5) & (P[:, 0] < 4.83) & (P[:, 2] < -5.5)   # outside, inboard, forward
    assert inlet_in.sum() > 4 and np.median(hdr(E[inlet_in, 3], cd)) > 0.05, np.median(hdr(E[inlet_in, 3], cd))
    P, N, E = baked(glb, rig, "Body")
    fwd = P[:, 2] < -6     # the fuselage ahead of the wing root
    assert np.percentile(hdr(E[fwd, 3], cd), 99) < VISIBLE, np.percentile(hdr(E[fwd, 3], cd), 99)
    land = lamp(rig, "landing_right")
    for name in ("Wing_R", "FlapInboard_R", "FlapOutboard_R"):
        P, N, E = baked(glb, rig, name)
        behind = P[:, 2] > land[2] + 0.5
        assert hdr(E[behind, 3], cd).max() < VISIBLE, (name, hdr(E[behind, 3], cd).max())


def test_the_wing_lights_show_the_leading_edge_the_upper_surface_and_the_nacelle(glb, rig):
    cd = candela(rig, "WING")
    v = []
    for i in range(1, 5):
        P, N, E = baked(glb, rig, f"Slat{i}_R")
        v.append(hdr(E[N[:, 1] > 0.3, 7], cd))
    v = np.concatenate(v)
    assert np.median(v) > 0.05, np.median(v)
    P, N, E = baked(glb, rig, "Wing_R")
    root = (N[:, 1] > 0.8) & (P[:, 0] > 2.5) & (P[:, 0] < 8) & (P[:, 2] < 0)
    assert (hdr(E[root, 7], cd) > VISIBLE).mean() > 0.5, np.round(np.percentile(hdr(E[root, 7], cd), [25, 50, 75]), 4)
    P, N, E, M = baked(glb, rig, "Engine_R", materials=True)
    top = (M == "Paint") & (N[:, 1] > 0.5) & (N[:, 0] < 0.3)    # the cowl's top and inboard shoulder
    assert np.median(hdr(E[top, 7], cd)) > 0.05, np.median(hdr(E[top, 7], cd))


def test_the_taxi_light_lights_the_nose_gear(glb, rig):
    """Nothing of the taxi light reaches what the cabin sees; its spill lights the nose gear it is mounted on."""
    P, N, E = baked(glb, rig, "NoseGear")
    assert (E[:, 4] > 0).sum() > 10
