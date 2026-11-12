# Skyline UI redesign

## Decision

Open view keeps the skyline full-screen for quick visual exploration. A permanent sidebar would reduce the view of the buildings people are comparing. Building controls appear when needed.

The implementation uses the existing Three.js scene, OrbitControls, camera flights, and city data. It adds no dependency.

## Navigation

- City switching, Search buildings, day and night, and options share a compact top bar.
- The lower-right camera group has pan, home, zoom, turn, north, and tilt buttons, with live viewpoint thumbnails beside it.
- Home returns to the last chosen viewpoint and preserves building edits. The chosen viewpoint remains independent of active thumbnail styling.
- On phones, Navigate expands to expose every camera action. The controls fit above the measured building editor.
- Existing gestures remain available. Arrow keys pan, Shift+arrows turn and tilt, plus and minus zoom, N faces north, and H goes home.
- Camera shortcuts leave text fields, form controls, and browser shortcuts alone. Buttons have accessible names, visible focus, and targets of at least 44px. Camera limits disable their buttons. Reduced motion makes flights immediate.

## Building editing

One editor derives its presentation from selection, the drag session, changed buildings, and undo history. A selected building shows its name, height, drag hint, Hide, Undo, and More. After deselection, the same panel shows a change summary and persistent Undo. More contains Zoom to building, Hide this and taller, and Building details when applicable.

An actual building drag hides the editor and map chrome. A small cue names the building and offers Escape to cancel. Drop commits one undoable move. Escape, pointer cancellation, lost capture, or window blur restore the drag's starting position without adding history. The initiating pointer owns the drag, and camera and editing shortcuts remain suppressed until the drag ends.

Start over is a separate global control that appears when buildings are changed. It shows hidden buildings, restores moved positions, clears selection and edit history, and leaves the camera and settings unchanged. Individual changes use Undo. More contains no reset action. Legacy toast and change panels, per-row return buttons, and the custom right-click building menu are removed.

On phones, active selection hides viewpoint thumbnails. A deselected change summary preserves viewpoint switching. Attribution remains visible below the editor. Actions return keyboard focus to Undo or the map when a focused control disappears.

## Verification

The production build and browser acceptance checks cover camera directions and limits, interrupted flights, keyboard guards, home preserving edits, real pointer dragging, cancellation, persistent Undo, global Start over, and phone layout.

Run the checks using the instructions in [README.md](../../README.md). The navigation script supports either city. The editing script uses Astra Tower in Salt Lake City. Phone layout checks use a browser viewport rather than a physical touch device.

[PRODUCT.md](../../PRODUCT.md) records product scope. [DESIGN.md](../../DESIGN.md) records the implemented tokens and layout. The [direction contract](../../.impeccable/surfaces/index-html.md) records the composition constraints.
