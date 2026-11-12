---
version: 1
slug: "index-html"
primary_target: "index.html"
related_targets: ["src/style.css","src/main.js"]
---

# Skyline explorer

Mode: Operate. The user chose Open view on 2026-11-11. Quick visual exploration leads; building controls appear after selection. Preserve all existing cities, scene data, building actions, settings, and gestures.

## Direction contract

THESIS: Keep the skyline full-screen. A compact top bar handles finding buildings and settings. A single lower-right camera cluster handles navigation and viewpoints. Avoid a permanent sidebar or bottom tray.

OWN-WORLD: Cool white panels with slate text, a blue selection accent, and consistent 12px corners. System UI type. Day and night use matching light and dark tokens. Buttons have generous targets and quiet separators.

STORY: Choose a city or viewpoint, navigate visually, select a building, then hide or move it. Undo and restore stay separate from camera home.

FIRST VIEWPORT: City, search, day/night, and options share one top-left bar. Search results and one compact editor sit below it. The editor combines selection and change history; More holds inline details and secondary building actions. A separate global Start over control restores all buildings and clears edit history without moving the camera. The lower-right cluster contains pan around camera home, zoom, turn, face north, and tilt. Live viewpoint thumbnails sit beside the cluster. A short dismissible hint sits beneath search. Attribution remains visible. Phone navigation collapses but exposes every camera action on expansion, while avoiding the compact editor. Actual building dragging hides all chrome except one small movement cue.

FORM: Open view, the user's chosen photographic-viewer direction. DESIGN.md records the implemented composition and tokens.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Constraints

Camera commands share the existing OrbitControls and flight path. Preserve terrain clearance, distance/polar limits, cursor zoom, building dragging, and rapid input interruption. Track last-chosen viewpoint separately from active-view highlighting. Camera home preserves hidden/moved buildings. Reduced motion makes camera commands immediate. No new UI framework or dependency. User data edits in data/height_report-lv.json, data/overrides.json, and public/data/lv/buildings.json remain untouched. Deployment requires a separate instruction.

## Building editing replacement

The user rejected the competing card/toast/change summary and requested a complete rebuild. The replacement has one editor derived from selected entry, drag session, net changed buildings, and history. Undo persists. Start over is the sole global reset entry point, separated from the editor. More contains no reset actions. Legacy panels, per-row return buttons, and the custom right-click menu are removed. Escape, pointer cancellation, lost capture, and blur roll back an unfinished drag without history. Camera and edit shortcuts are suppressed while a drag owns the pointer.
