---
name: Interactive Skyline
description: Open view controls over a full-screen city model.
colors:
  blue: "#2f77bd"
  blue-wash: "rgba(111, 176, 234, 0.22)"
  accent: "#c9431f"
  accent-strong: "#ad3614"
  on-accent: "#ffffff"
  ink: "#24343e"
  muted: "#5d656e"
  faint: "#8a9199"
  line: "rgba(29, 33, 38, 0.1)"
  surface: "#f8fafb"
  fill: "rgba(29, 33, 38, 0.07)"
  fill-strong: "rgba(29, 33, 38, 0.13)"
  night-blue: "#7db9ee"
  night-blue-wash: "rgba(111, 176, 234, 0.2)"
  night-accent: "#e2613d"
  night-accent-strong: "#ee7450"
  night-on-accent: "#101820"
  night-ink: "#eef0f2"
  night-muted: "#a9b1ba"
  night-faint: "#818a94"
  night-line: "rgba(255, 255, 255, 0.12)"
  night-surface: "#202b34"
  night-fill: "rgba(255, 255, 255, 0.09)"
  night-fill-strong: "rgba(255, 255, 255, 0.17)"
  canvas-background: "#cfd9e3"
  loading-ink: "#4b5560"
  attribution-backdrop: "rgba(20, 30, 40, 0.82)"
typography:
  title:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'
    fontSize: "16px"
    fontWeight: 650
    lineHeight: 1.4
  body:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'
    fontSize: "14px"
    lineHeight: 1.4
  label:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'
    fontSize: "12px"
    fontWeight: 600
  menu:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'
    fontSize: "13px"
    lineHeight: 1.4
  caption:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'
    fontSize: "11px"
    lineHeight: 1.4
  loading:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'
    fontSize: "15px"
    lineHeight: 1.4
rounded:
  panel: "12px"
  action: "8px"
  control: "8px"
  menu-item: "7px"
  thumbnail: "5px"
  attribution: "4px"
spacing:
  panel-inset: "20px"
  phone-inset: "12px"
  narrow-inset: "8px"
  context-gap: "10px"
  action-gap: "8px"
  thumbnail-gap: "6px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.action}"
    padding: "8px 14px"
  button-primary-hover:
    backgroundColor: "{colors.accent-strong}"
  button-secondary:
    backgroundColor: "{colors.fill}"
    textColor: "{colors.ink}"
    rounded: "{rounded.action}"
    padding: "8px 14px"
  button-secondary-hover:
    backgroundColor: "{colors.fill-strong}"
  building-editor:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    padding: "10px 12px 12px"
  camera-controls:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    padding: "12px"
    width: "212px"
---

# Design System: Interactive Skyline

## Overview

**Creative North Star: "Open view"**

Open view is the user-selected direction. Cool white or dark slate panels sit over a full-screen city model. Compact controls leave the skyline visible, and building actions appear after selection.

This document records the implementation in `src/style.css`, `index.html`, and `src/main.js`. Product scope lives in [PRODUCT.md](PRODUCT.md). The composition contract lives in [.impeccable/surfaces/index-html.md](.impeccable/surfaces/index-html.md).

Key characteristics:

- System UI type and quiet separators.
- Solid panels with consistent corners and shared shadows.
- Grouped camera controls with adjacent live viewpoint thumbnails.
- One compact editor for selection and changes, with only a small cue visible during a building drag.

## Colors

The frontmatter records the CSS palette. The day and night interface entries map to CSS custom properties. Unprefixed interface entries map directly to `--<name>` in day mode. Night entries replace those same variables under `:root[data-theme="dark"]`. Canvas background, loading ink, and attribution backdrop record existing literal CSS values, with no theme override.

**The Theme Pair Rule.** Day and night share the same roles and geometry. Night also replaces the foreground on the orange action through `--on-accent`.

Primary blue marks focus, camera home, active viewpoints, enabled options, and native input accents. Blue wash marks hover and active navigation feedback. Scene building colors come from the renderer, independently of these interface tokens.

Secondary orange marks the building Hide action and compass north tip. The selected search row uses a transparent mix of the orange accent (`color-mix(in srgb, var(--accent) 16%, transparent)`).

Neutral surface and ink carry panels and text. Muted text carries supporting labels. Faint text carries ranks and hidden buildings. Line separates groups. Fill and fill-strong mark quiet actions and hover states. The canvas background also covers loading. Loading ink labels progress, while the attribution backdrop keeps white attribution text legible over the scene.

## Typography

All interface text uses the system stack in the frontmatter. There is no display face or promotional headline scale.

The selected building uses the title role. Body text and ordinary buttons use the body role, with action weight (600) and city weight (650). Navigation headings use the label role. Supporting metadata uses smaller text (12.5px), viewpoint labels use (12px), and phone viewpoint labels use (11px). Heights, ranks, and threshold outputs use tabular numerals. Long search names and editor titles truncate to a single line with an ellipsis. Menu items use the menu role, attribution and the compass use the caption size, and loading uses the loading role. The initial hint heading uses menu size with weight (600).

## Layout

The scene fills the viewport. The page itself does not scroll. Fixed overlays use `--gap`, `--bar`, `--context`, and `--top-height`. Desktop values are (20px), (520px), (360px), and (52px). The top group clamps to the viewport width. Results and the building editor sit below the bar with a gap (10px). Settings are (288px) wide and align with the bar's right edge.

The lower-right navigation group sits above the viewport bottom (34px). The camera panel is (212px) wide with padding (12px). Its circular pan pad is a three-by-three grid of controls (44px each), with home at its center. Zoom, turn, north, and tilt remain separate groups. Viewpoint buttons are (100px) wide beside the panel. Their live canvases are rendered at (176 × 116).

At widths up to (720px), the inset becomes (12px), the bar spans the available width, and city/options sit above search in a two-row bar (96px high). The compact editor moves to the bottom with a height limit of `min(42dvh, 300px)`. Navigate starts collapsed. Expansion shows the full camera panel and hides viewpoint thumbnails. A measured `--editor-height` places navigation above the editor and bounds the expanded controls' scroll area. The editor reserves an extra bottom space (24px) for attribution. Active selection hides thumbnails, while the changed-scene summary preserves viewpoint switching. Attribution stays visible below the editor. At widths up to (360px), the inset becomes (8px) and the Navigate text is hidden.

Search results scroll within desktop `min(62vh, 560px)` or phone `min(52dvh, calc(100dvh - var(--top-height) - 100px))`. The editor and settings also have viewport-based height limits. Expanded building details scroll within (100px). During a building drag, all map controls, attribution, and hover labels disappear. A small cue remains centered above the bottom edge (24px).

## Elevation & Depth

Solid panels use the shared `--shadow`. Day uses `0 2px 6px rgba(20, 30, 45, 0.14), 0 10px 30px rgba(20, 30, 45, 0.16)`. Night uses `0 2px 6px rgba(0, 0, 0, 0.4), 0 10px 30px rgba(0, 0, 0, 0.45)`. There is no panel blur.

The layer order keeps attribution below controls (z-index 2), controls and the editor together (3), hover labels above them (5), popovers above those (6), the More menu above popovers (7), and loading above everything (9). Selected unit segments use a smaller shadow (`0 1px 3px rgba(0, 0, 0, 0.14)`).

## Shapes

Panels use the panel radius. Buttons use control or action corners, menu items use menu-item corners, and viewpoint imagery uses thumbnail corners. Attribution uses its smaller corner role. The pan pad alone is circular (`50%`). Icons use rounded line ends and joins, a normal size (20px), and stroke width (1.6). Separators use a single border (1px).

## Components

Building actions use quiet filled buttons and one orange Hide button. Both have a minimum height (44px), action corners, and padding from the frontmatter. Hover strengthens the fill. Disabled buttons reduce opacity (0.35). General keyboard focus uses blue (2px) with an offset (2px). The full-screen map uses an inset offset (-3px) so its focus indicator stays visible.

The map canvas accepts keyboard focus. Hide and restoration transfer focus to Undo when available; Undo or closing selection transfers focus to the map when its control disappears. Phone editors reserve space for attribution, and navigation shifts above the editor.

The search field is part of the top bar, with no separate inset box. Focusing it outlines the whole bar (2px, offset 1px). City and icon buttons have control corners and targets (44px high). Settings use native checkboxes and a range input, plus a two-option units segment.

Building results pair name and height with one Hide or Show action. Hidden names use a line through the text. Search temporarily hides the editor and initial hint.

**The Single Editor Rule.** Selection and building changes share one compact panel. A selection shows the building name, height, drag hint, Hide, and More. Undo stays available whenever history exists, without a timed toast. After deselection, the same panel shows the changed-building count. Without a selection or remaining building changes, available history keeps "No building changes" and Undo visible. With no selection, changes, or history, the editor is absent.

More holds Zoom to building, Hide this and taller, and Building details. Actions appear only when applicable. A separate global Start over control restores all buildings and clears edit history. It appears only while buildings are changed, independently of the selected building. On desktop it sits at the upper right with a minimum height (52px). On phones it sits at the right of the search row (104px wide and 44px high), with search reserving (116px) to keep text clear. Starting over clears selection and edit history, then returns focus to the map. Building details expand inside the editor to show dimensions, rank, and height provenance. The menu opens above or below its trigger to fit the viewport and supports keyboard focus and dismissal.

**The Clear Drag Rule.** Once the pointer travels beyond the drag threshold (5px) on a selected building, the panel and map controls disappear. The cue names the building and offers Escape to cancel. A completed move returns to the selected editor with Undo. Escape, pointer cancellation, lost capture, or window blur restore the starting position without adding a history step. A drag belongs to its initiating pointer. Editing and camera shortcuts are suppressed during the drag.

Camera buttons expose labels through titles and ARIA. Active viewpoints use blue wash, blue text, weight (650), and `aria-pressed`. Moving away clears their active state while home remembers the last chosen viewpoint. Camera home preserves building changes. Start over affects all building edits without changing the camera or map settings.

Camera commands animate for (240ms), and Zoom to uses (750ms), both with smoothstep easing. Viewpoint selection and home are immediate. New gestures or commands interrupt a flight. Reduced motion makes flights immediate and removes the loading fade, normally (0.4s). Navigation buttons disable at camera limits.

The dismissible initial hint sits beneath search until selection. Hover labels remain contextual overlays outside a drag. Action feedback uses a polite screen-reader status. Attribution occupies the lower left and remains visible below the phone editor.

## Do's and Don'ts

- Do bind controls to the shared day and night variables.
- Do retain keyboard focus, visible action labels, and named camera groups.
- Do measure the editor before placing phone navigation above it.
- Do keep Undo in the editor whenever history is available.
- Do clear map chrome while a selected building is being dragged.
- Don't use camera home to restore building edits.
- Don't turn the contextual controls into a permanent sidebar or bottom tray.
- Don't split selection, change status, and Undo across separate panels.
- Don't put global building-reset actions inside a selected-building menu.
- Don't treat the frontmatter palette as the renderer's terrain, sky, or building palette.
