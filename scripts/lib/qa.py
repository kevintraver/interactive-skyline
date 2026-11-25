"""The QA report of a baked flight and its procedure check (plan 03, F2.6, sections 7.2 and 8.4).

The procedure check compares the final approach as flown with the runway end's published instrument approaches (FAA
CIFP, scripts/fetch_cifp.py) and its PAPI (airport.json): the glide path over 3 km to 1 km before the threshold
against the nearest published angle (section 7.2's gate: within 0.35 degrees, warn beyond 0.2), the course flown over
the last 2 km against each approach's final approach course, and the antenna's height over the threshold against
the published crossing heights. The report also carries the altitude calibration (offset and datum), every quality
gate with its number, and the RMS of the derived channels against what the trace recorded.

Nothing that identifies the aircraft or its operator goes into the report (assumption A2); it is kept under
data/flights/, not served.
"""
import math

import numpy as np

FT = 0.3048
GLIDE_MAX_DIFF = 0.35
GLIDE_WARN_DIFF = 0.2


def published_for(end_id, cifp, end=None):
    """The published final approach angles and crossing heights for a runway end: each approach's, and the PAPI's."""
    rows = []
    for proc, a in sorted((cifp or {}).get("approaches", {}).items()):
        if a["runway"] != end_id:
            continue
        rows.append({"source": "CIFP " + proc, "type": a["type"], "angle": a.get("glidePathDeg"),
                     "crossingHeightFt": a.get("crossingHeightFt"), "finalCourseTrue": a.get("finalCourseTrue"),
                     "lastFix": a.get("lastFix")})
    if end and end.get("papi") and end["papi"].get("angle"):
        rows.append({"source": "PAPI (NASR)", "type": "PAPI", "angle": end["papi"]["angle"],
                     "crossingHeightFt": end["papi"].get("crossingHeightFt"), "finalCourseTrue": None,
                     "lastFix": None})
    return rows


def published_angles(end_id, cifp, end=None):
    return sorted({r["angle"] for r in published_for(end_id, cifp, end) if r["angle"]})


def flown_final_course(x, n, end, before_m=(2000.0, 200.0)):
    """The grid course flown between `before_m` metres before the threshold, from a line fitted to the lateral
    offset against the distance along the runway (degrees, or None without enough samples)."""
    thr = np.array(end["threshold"][:2], dtype=float)
    hd = math.radians(end["gridHeading"])
    u = np.array([math.sin(hd), math.cos(hd)])
    right = np.array([u[1], -u[0]])
    d = np.stack([np.asarray(x) - thr[0], np.asarray(n) - thr[1]], axis=1)
    along, lat = d @ u, d @ right
    m = (along > -before_m[0]) & (along < -before_m[1]) & (np.abs(lat) < 300)
    if m.sum() < 5:
        return None
    slope = np.polyfit(along[m], lat[m], 1)[0]
    return (end["gridHeading"] + math.degrees(math.atan(slope))) % 360


def procedure_check(header, channels, end, cifp, true_north_grid_deg):
    """Compare the flown final with the published procedures for its runway end. `true_north_grid_deg` is the
    bearing of true north in the city grid at the threshold (smooth.true_north_bearing)."""
    end_id = header["runway"]
    pubs = published_for(end_id, cifp, end)
    qa = header["qa"]
    gp = qa.get("glidePathDeg")
    angles = sorted({p["angle"] for p in pubs if p["angle"]})
    nearest = min(angles, key=lambda a: abs(a - gp)) if (angles and gp is not None) else None
    course_grid = flown_final_course(channels["x"], channels["n"], end)
    course_true = None if course_grid is None else (course_grid - true_north_grid_deg) % 360
    rows = []
    for p in pubs:
        r = dict(p)
        if p["finalCourseTrue"] is not None and course_true is not None:
            r["courseDiffDeg"] = round((course_true - p["finalCourseTrue"] + 180) % 360 - 180, 2)
        if p["angle"] is not None and gp is not None:
            r["angleDiffDeg"] = round(gp - p["angle"], 2)
        if p["crossingHeightFt"] is not None and qa.get("crossingHeightM") is not None:
            r["crossingHeightDiffFt"] = round(qa["crossingHeightM"] / FT - p["crossingHeightFt"], 1)
        rows.append(r)
    diff = None if nearest is None else round(gp - nearest, 2)
    return {
        "runway": end_id, "cifpCycle": (cifp or {}).get("cycle"),
        "glidePathDeg": gp, "nearestPublishedDeg": nearest, "diffDeg": diff,
        "pass": diff is not None and abs(diff) <= GLIDE_MAX_DIFF, "warn": diff is not None and abs(diff) > GLIDE_WARN_DIFF,
        "finalCourseFlownGridDeg": None if course_grid is None else round(course_grid, 2),
        "finalCourseFlownTrueDeg": None if course_true is None else round(course_true, 2),
        "crossingHeightAntennaM": qa.get("crossingHeightM"),
        "crossingHeightAntennaFt": None if qa.get("crossingHeightM") is None else round(qa["crossingHeightM"] / FT, 1),
        "published": rows,
    }


def report(header, channels, end, cifp, true_north_grid_deg):
    """The QA report of one flight: calibration, gates, recorded-versus-derived RMS, the procedure check and the
    inferred configuration. Plain JSON-able values only."""
    qa = header["qa"]
    proc = procedure_check(header, channels, end, cifp, true_north_grid_deg)
    gates = {k: dict(v) for k, v in qa["gates"].items()}
    return {
        "format": "skyline-flight-qa/1", "id": header["id"], "runway": header["runway"],
        "aircraftType": header.get("aircraftType"), "touchdown": header["touchdown"],
        "recordedStart": header["recordedStart"], "samples": header["samples"],
        "calibration": {"offsetM": qa["altitudeOffsetM"], "datum": qa["datum"], **qa["calibration"]},
        "antennaAboveWheelsM": qa.get("antennaAboveWheelsM"),
        "gates": gates, "waived": qa.get("waived", []), "pass": all(g["pass"] for g in gates.values()) and proc["pass"],
        "stripView": qa.get("stripView"),
        "recordedVersusDerived": qa.get("reported", {}),
        "procedure": proc,
        "touchdownPoint": {"pastThresholdM": qa.get("touchdownPastThresholdM"), "offCentreM": qa.get("touchdownOffCentreM"),
                       "source": qa.get("touchdownSource"), "flare": qa.get("flare")},
        "inferred": header.get("inferred"),
        "weather": _weather_summary(header.get("weather")), "badges": header.get("badges"),
        "reconstructed": header.get("reconstructed"),
    }


def _weather_summary(w):
    """The as-flown weather for the QA report: what the reports said and what was derived (lib.flight_weather)."""
    if not w or "format" not in w:
        return w
    return {"badge": w["badge"], "reports": [r["metar"] for r in w["reports"]], "surface": w["surface"],
            "layers": w["layers"], "precipitation": w["precipitation"], "inCloud": w["inCloud"]}
