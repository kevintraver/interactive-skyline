"""Shared recipe for the white classical slab towers at w134944648 / w1176928048 / w126267789 (Las Vegas).

One call, `build_tower(b, plan, spec)`, turns a plan polygon into: stone base, blue glass body with white
piers and spandrel bands, a projecting central bay of dark glass behind giant columns, a lower cornice, an
arcaded top storey, a top cornice, a long red gabled roof with white end pediments and a crossing central
pediment. No signage: the frieze under each pediment is plain.

Local frame: u runs along the slab (east-ish), v across it; `spec.rot_deg` turns it counter-clockwise from east.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Sequence

import landmark_kit as kit

P2 = tuple[float, float]
BURY = -2.0
WARM = (1.0, 0.86, 0.60)
COOL = (0.80, 0.88, 1.0)

BASE_COLORS = {
    "Stone": "F3F0E6",      # white precast
    "Column": "FAF8F0",     # giant order of the central bay
    "Glass": "3F6A90",      # blue-tinted room glass
    "DarkGlass": "27425C",  # recessed curtain wall behind the columns
    "ArchGlass": "22384E",  # arcade and base openings
    "RoofRed": "A8432F",
    "Roof": "9C968C",
}
ROUGHNESS = {"Glass": 0.3, "DarkGlass": 0.25, "ArchGlass": 0.3}
WINDOWS = {"Glass": 1.0, "DarkGlass": 0.6}


@dataclass(frozen=True)
class Spec:
    height: float                 # top of the central pediment (project data)
    rot_deg: float                # slab axis, counter-clockwise from east
    feature: P2                   # u-range of the central bay
    bay: float = 5.6              # pier spacing (est.)
    pier_frac: float = 0.55       # pier width / bay: lower = glassier
    col_bay: float = 4.6          # column spacing in the central bay (est.)
    bands: int = 6                # spandrel bands that read from afar
    roof_half_w: float = 13.0     # half-width of the red roof
    base_frac: float = 0.10       # photo ratios (est.), fractions of height
    cornice_frac: float = 0.69
    arcade0_frac: float = 0.735
    arcade1_frac: float = 0.855
    topc_frac: float = 0.885
    ridge_frac: float = 0.935
    end_apex_frac: float = 0.955
    base_openings: bool = True


def make_glow(spec: Spec):
    cornice = spec.height * spec.cornice_frac

    def glow(material: str, point: Sequence[float], center: Sequence[float]) -> tuple[float, float, float]:
        if material == "Glass":
            return kit.scaled(COOL, 0.03)
        if material == "DarkGlass":
            return kit.scaled(COOL, 0.03)
        if material == "Stone":   # crown washed warm and bright; shaft cool flood; base warm
            # Decided per face (its center), not per corner: piers run base to cornice in one face, and
            # per-corner values smeared the crown's wash down the whole shaft.
            z = center[2]
            if z >= cornice - 0.5:
                return kit.scaled(WARM, 0.75)
            if z <= spec.height * spec.base_frac + 2.5:
                return kit.scaled(WARM, 0.22)
            return kit.scaled(COOL, 0.14)
        if material == "Column":
            return kit.scaled(WARM, 0.20)
        if material == "ArchGlass":
            return kit.scaled(WARM, 0.10)
        if material == "RoofRed":
            return (0.03, 0.012, 0.01)
        return (0.0, 0.0, 0.0)
    return glow


def to_world(spec: Spec, u: float, v: float) -> P2:
    a = math.radians(spec.rot_deg)
    return (u * math.cos(a) - v * math.sin(a), u * math.sin(a) + v * math.cos(a))


def to_local(spec: Spec, p: P2) -> P2:
    a = math.radians(spec.rot_deg)
    return (p[0] * math.cos(a) + p[1] * math.sin(a), -p[0] * math.sin(a) + p[1] * math.cos(a))


def _slab(b: kit.Builder, p: P2, t: P2, nrm: P2, s: float, w: float, proud: float, z0: float, z1: float,
          material: str, sink: float = 0.4) -> None:
    def pt(a: float, c: float) -> P2:
        return (p[0] + t[0] * a + nrm[0] * c, p[1] + t[1] * a + nrm[1] * c)
    b.extrude([pt(s - w / 2, -sink), pt(s + w / 2, -sink), pt(s + w / 2, proud), pt(s - w / 2, proud)],
              z0, z1, material)


def _feature_span(spec: Spec, p: P2, t: P2, length: float) -> tuple[float, float] | None:
    """Part [a, b] of an edge that lies in the central bay, if the edge runs along the slab."""
    a = math.radians(spec.rot_deg)
    tu = t[0] * math.cos(a) + t[1] * math.sin(a)
    if abs(tu) < 0.8:
        return None
    u0 = to_local(spec, p)[0]
    sa, sb = sorted(((spec.feature[0] - u0) / tu, (spec.feature[1] - u0) / tu))
    sa, sb = max(sa, 0.0), min(sb, length)
    return (sa, sb) if sb - sa > 9.0 else None


def _piers(b: kit.Builder, spec: Spec, p: P2, t: P2, nrm: P2, s0: float, s1: float, z: dict[str, float]) -> None:
    span = s1 - s0
    if span < 3.0:
        return
    bays = max(1, round(span / spec.bay))
    step = span / bays
    for i in range(bays + 1):
        _slab(b, p, t, nrm, s0 + i * step, step * spec.pier_frac, 0.7, z["base"], z["cornice"], "Stone")
    for i in range(bays):
        mid = s0 + (i + 0.5) * step
        _slab(b, p, t, nrm, mid, step * 0.42, 1.0, z["arc0"] + 1.5, z["arc1"] - 1.5, "ArchGlass")
        if spec.base_openings:
            _slab(b, p, t, nrm, mid, step * 0.5, 1.3, 2.5, z["base"] - 3.0, "ArchGlass")


def _feature(b: kit.Builder, spec: Spec, p: P2, t: P2, nrm: P2, s0: float, s1: float, z: dict[str, float]) -> None:
    span = s1 - s0
    _slab(b, p, t, nrm, (s0 + s1) / 2, span - 0.6, 0.5, z["base"], z["cornice"], "DarkGlass")
    bays = max(2, round(span / spec.col_bay))
    step = span / bays
    for i in range(bays + 1):
        w = 2.4 if i in (0, bays) else 1.5
        _slab(b, p, t, nrm, s0 + i * step, w, 1.5, z["base"], z["cornice"], "Column")
    for i in range(bays):   # taller arcade openings between the upper columns
        _slab(b, p, t, nrm, s0 + (i + 0.5) * step, step * 0.5, 1.0, z["arc0"] + 0.5, z["arc1"] - 1.0, "ArchGlass")


def _body(b: kit.Builder, spec: Spec, plan: Sequence[P2], z: dict[str, float]) -> None:
    pts = kit.ccw_polygon(plan)
    b.extrude(kit.offset_polygon(pts, 1.0), BURY, z["base"] - 1.2, "Stone")
    b.extrude(kit.offset_polygon(pts, 1.7), z["base"] - 1.2, z["base"], "Stone")
    b.extrude(pts, z["base"], z["cornice"], "Glass")
    floor = (z["cornice"] - z["base"]) / (spec.bands + 1)
    for i in range(1, spec.bands + 1):
        zb = z["base"] + i * floor
        b.extrude(kit.offset_polygon(pts, 0.3), zb - 0.6, zb + 0.6, "Stone")
    b.extrude(kit.offset_polygon(pts, 1.6), z["cornice"], z["cornice"] + 1.6, "Stone")
    b.extrude(kit.offset_polygon(pts, 0.4), z["cornice"] + 1.6, z["arc1"], "Stone")
    b.extrude(kit.offset_polygon(pts, 2.2), z["arc1"], z["topc"], "Stone", top="Roof")

    n = len(pts)
    for j in range(n):
        p, q = pts[j], pts[(j + 1) % n]
        length = math.hypot(q[0] - p[0], q[1] - p[1])
        if length < 2.5:
            continue
        t = ((q[0] - p[0]) / length, (q[1] - p[1]) / length)
        nrm = (t[1], -t[0])
        span = _feature_span(spec, p, t, length)
        if span is None:
            _piers(b, spec, p, t, nrm, 0.0, length, z)
            continue
        _piers(b, spec, p, t, nrm, 0.0, span[0], z)
        _feature(b, spec, p, t, nrm, span[0], span[1], z)
        _piers(b, spec, p, t, nrm, span[1], length, z)


def _gable_u(b: kit.Builder, spec: Spec, u0: float, u1: float, half_w: float, z0: float, apex: float,
             material: str, v_mid: float = 0.0) -> None:
    """Triangular prism with its ridge along the slab, from u0 to u1."""
    def ring(u: float) -> list[tuple[float, float, float]]:
        return [(*to_world(spec, u, v_mid - half_w), z0), (*to_world(spec, u, v_mid + half_w), z0),
                (*to_world(spec, u, v_mid), apex)]
    b.loft([ring(u0), ring(u1)], material)


def _gable_v(b: kit.Builder, spec: Spec, v0: float, v1: float, u0: float, u1: float, z0: float, apex: float,
             material: str) -> None:
    """Triangular prism with its ridge across the slab, from v0 to v1."""
    def ring(v: float) -> list[tuple[float, float, float]]:
        return [(*to_world(spec, (u0 + u1) / 2, v), apex), (*to_world(spec, u1, v), z0),
                (*to_world(spec, u0, v), z0)]
    b.loft([ring(v0), ring(v1)], material)


def _roof(b: kit.Builder, spec: Spec, plan: Sequence[P2], z: dict[str, float]) -> None:
    local = [to_local(spec, p) for p in plan]
    u_min, u_max = min(p[0] for p in local), max(p[0] for p in local)
    f0, f1 = spec.feature
    in_bay = [p[1] for p in local if f0 - 3 <= p[0] <= f1 + 3]
    v_min, v_max = min(in_bay), max(in_bay)
    v_mid = sum(p[1] for p in local if p[0] > u_max - 12 or p[0] < u_min + 12) / max(
        1, sum(1 for p in local if p[0] > u_max - 12 or p[0] < u_min + 12))
    topc, h = z["topc"], spec.height
    w = spec.roof_half_w
    # long red roof, white pediments closing its ends
    _gable_u(b, spec, u_min + 1.0, u_max - 1.0, w, topc, h * spec.ridge_frac, "RoofRed", v_mid)
    apex_end = h * spec.end_apex_frac
    for ua, ub in ((u_min - 2.0, u_min + 1.5), (u_max - 1.5, u_max + 2.0)):
        _gable_u(b, spec, ua, ub, w + 2.6, topc, apex_end, "Stone", v_mid)
    # central bay: plain frieze block, crossing red roof, white pediment on both faces
    frieze = h * 0.905
    corners = [to_world(spec, u, v) for u, v in ((f0, v_min - 1.2), (f1, v_min - 1.2), (f1, v_max + 1.2),
                                                 (f0, v_max + 1.2))]
    b.extrude(corners, z["arc1"] + 0.2, frieze, "Stone")
    _gable_v(b, spec, v_min - 0.8, v_max + 0.8, f0 - 0.5, f1 + 0.5, frieze, h - 0.6, "RoofRed")
    for va, vb in ((v_min - 3.2, v_min - 0.6), (v_max + 0.6, v_max + 3.2)):
        _gable_v(b, spec, va, vb, f0 - 2.4, f1 + 2.4, frieze, h, "Stone")


def build_tower(b: kit.Builder, plan: Sequence[P2], spec: Spec) -> None:
    h = spec.height
    z = {"base": h * spec.base_frac, "cornice": h * spec.cornice_frac, "arc0": h * spec.arcade0_frac,
         "arc1": h * spec.arcade1_frac, "topc": h * spec.topc_frac}
    _body(b, spec, plan, z)
    _roof(b, spec, plan, z)
