"""The served lamp product (scripts/pack_lamps.py, plan 02 D5.4): what goes in comes back, sorted into cells."""
import json
import random
import struct

import pack_lamps as pl


def _inventory(n=500, seed=4):
    rnd = random.Random(seed)
    lamps = []
    for i in range(n):
        x = rnd.uniform(-3000, 2500)
        y = rnd.uniform(-2000, 2900)
        aim = None if i % 3 else round(rnd.uniform(0, 359.99), 2)
        flags = (0x10 if i % 17 == 0 else 0) | (1 if i % 5 == 0 else 0) | (1 << 1)
        lamps.append((round(x, 3), round(y, 3), round(rnd.uniform(6, 30), 1), rnd.randrange(8), flags, rnd.randrange(9, 14000) * 10, aim))
    return lamps


REGION = (-2800, -1900, 2400, 2800)


def test_round_trip_keeps_every_lamp_in_the_region():
    lamps = _inventory()
    data, meta = pl.pack(lamps, REGION, {"types": []})
    inside = [l for l in lamps if REGION[0] <= l[0] < REGION[2] and REGION[1] <= l[1] < REGION[3]]
    back = pl.decode(data, meta)
    assert meta["count"] == len(inside) == len(back)
    assert meta["enclosed"] == sum(1 for l in inside if l[4] & 0x10)
    key = lambda l: (round(l[0]), round(l[1]))
    want = sorted(inside, key=key)
    got = sorted(back, key=key)
    for a, b in zip(want, got):
        assert abs(a[0] - b[0]) <= 0.5 / pl.Q + 1e-9 and abs(a[1] - b[1]) <= 0.5 / pl.Q + 1e-9
        assert abs(a[2] - b[2]) <= 0.5 / pl.MOUNT_Q + 1e-9
        assert a[3] == b[3] and a[5] == b[5]
        assert bool(b[4] & pl.ENCLOSED) == bool(a[4] & 0x10)
        assert bool(b[4] & pl.RULE) == bool(a[4] & 1)
        if a[6] is None:
            assert b[6] is None
        else:
            d = (a[6] - b[6] + 180) % 360 - 180
            assert abs(d) <= 0.71


def test_cells_are_row_major_and_lamps_sit_in_their_cell():
    data, meta = pl.pack(_inventory(), REGION, {"types": []})
    arrs = {a["name"]: a for a in meta["arrays"]}
    start = struct.unpack_from(f"<{arrs['cellStart']['length']}I", data, arrs["cellStart"]["offset"])
    assert start[0] == 0 and start[-1] == meta["count"]
    assert all(b >= a for a, b in zip(start, start[1:]))
    back = pl.decode(data, meta)
    for c in range(meta["nx"] * meta["ny"]):
        x0 = meta["x0"] + (c % meta["nx"]) * meta["cell"]
        y0 = meta["y0"] + (c // meta["nx"]) * meta["cell"]
        for lamp in back[start[c]:start[c + 1]]:
            assert x0 <= lamp[0] <= x0 + meta["cell"] and y0 <= lamp[1] <= y0 + meta["cell"]
    for a in meta["arrays"]:
        assert a["offset"] % 4 == 0
    assert meta["bytes"] == len(data)


def test_reads_the_inventory_format(tmp_path):
    rec = struct.pack("<iiHBBHH", -1234567, 765432, 91, 1, 0x13, 950, 0xFFFF) + struct.pack("<iiHBBHH", 10, -20, 305, 2, 0, 2700, 9000)
    p = tmp_path / "lamps.bin"
    p.write_bytes(rec)
    a, b = pl.read_inventory(p)
    assert a == (-1234.567, 765.432, 9.1, 1, 0x13, 9500, None)
    assert b == (0.01, -0.02, 30.5, 2, 0, 27000, 90.0)


def test_the_served_product_is_current_and_small():
    meta_path = pl.ROOT / "public" / "data" / "lv" / "lamps-drive.json"
    if not meta_path.exists():
        return
    meta = json.loads(meta_path.read_text())
    data = (pl.ROOT / "public" / "data" / "lv" / "lamps-drive.bin").read_bytes()
    assert meta["version"] == pl.VERSION and meta["bytes"] == len(data)
    assert meta["lampTypes"]["types"], "the lamp types are embedded"
    import gzip
    assert len(gzip.compress(data, 6)) < 1_500_000
