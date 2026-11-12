# Spinning extras: contract between the GLB and the app (High Roller first)

Both sides follow this file exactly: the build script that makes the wheel and the app code that turns it.

## In the GLB (Blender side, Z up, +X east, +Y north, meters)

- Static parts (legs, brace, axle supports, station block) are ordinary mesh objects, exported as now.
- One mesh object named `Rotor`: rim, spokes/cables, hub drum and flanges, rim lights, cabin mounts.
  Its object origin is the hub center (on the axle, at hub height). It turns about its own local
  axle axis: Blender local +Y, which the glTF exporter writes as the node's local -Z axis (axis sign does
  not matter; direction comes from the manifest).
- 28 mesh objects named `Cabin_00` ... `Cabin_27`, each parented to `Rotor` (Blender parent, transform
  kept), each with its object origin at its pivot: the point it hangs from, on a line parallel to the axle.
  Each cabin is modelled level at its rest position. Cabin_00 is at the top.
- Materials as usual: `LedRim` (or other `Led...` names) for rim lights so the app's LED animation drives
  them, `_GLOW` per vertex, no COLOR_0, glass with `windows=` where it should get lit panes at night. No logos,
  wordmarks or brand graphics anywhere.
- The GLB keeps the node hierarchy (Rotor with its cabin children); nothing is joined into one mesh.

## In the app (models.json extra entry)

```json
{"name": "High Roller", "url": "/models/high_roller.glb", "east": 417.5, "north": 331.1, "rotation_deg": 90,
 "visible": "always", "spin": {"node": "Rotor", "period_s": 180, "direction": 1}}
```

- Only an entry with `spin` animates. The app keeps `Rotor` and its `Cabin_*` children as separate meshes
  (same night material path: glow, windows, led attributes), turns `Rotor` by angle t about its axle, and turns
  each cabin by -t about its own pivot axis (parallel to the axle) so cabins stay level.
- `period_s`: seconds per revolution. The real wheel takes 30 minutes (1800 s); the default 180 s (10x) makes
  the motion readable. `direction`: 1 or -1.
- Without `spin`, or with an older app, the GLB still draws correctly as a static model at rest pose
  (flatten applies parent transforms).
