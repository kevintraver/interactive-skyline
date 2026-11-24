# Stability tools

Scripts that drive the running app on this machine's GPU and look for pictures that change when they should not:
flicker between surfaces, brightness that swings as the camera moves, parts of the world that go missing far out.
They are measurement tools, not part of `pnpm test`. Each takes the address of a served build
(`pnpm build && pnpm preview --host 127.0.0.1 --port 4891 --strictPort`) and is run from the repository root.

| Script | What it does |
|---|---|
| `poses.mjs <out> <baseUrl> <label> <city> <day\|night\|dusk> [extraQuery]` | Walks the camera along a fixed path of 54 poses inside the camera limits. Saves three frames per pose: as drawn while moving (`-m`), after standing still (`-s`), and with the camera nudged by a hair (`-e`), and the pre-exposure of the moving and settled frames. |
| `analyze.py <out>` | Reads those frames (`uv run --python 3.12 --with numpy --with pillow python tools/stability/analyze.py <out>`). Moving against settled shows what is wrong only while moving, with the brightness ratio between them and whether the exposure was the same; settled against nudged shows surfaces that flip under a sub-pixel move (at grazing poses near the ground the "hair" moves nearby buildings by several pixels, so window edges show there as parallax, not flicker); it also lists mostly black frames. |
| `survey.mjs <out> <baseUrl> <city> <day\|night> [label] [extraQuery]` | Flies to every tall building and, from three sides, draws the view twice, the second time nudged by a hair. Counts the 4 × 4 pixel blocks whose brightness flips anywhere in the frame (so one flickering building shows in its neighbours' views too): stable geometry gives none, surfaces that fight for the same depth give hundreds. On the new renderer pass `&display=classic` (since decision 14 Eye mode no longer moves the exposure with the view, but the classic display keeps the survey comparable with the earlier runs). |
| `pair.mjs <out> <baseUrl> <city> <day\|night> [--query=...] <id[@turn]...>` | The survey's two pictures for chosen buildings, saved, to look at, on either renderer; it also ray-casts the middle of every flipping block and lists the surfaces found within 5 cm of each other there (`fights`: a tall building's id, `Mesh:<vertices>` for the merged low buildings or a terrain grid, `(2 faces)` for two faces of one mesh). `pairdiff.py <out>/pair` marks the flipping blocks in red beside the picture. |
| `coplanar.mjs <out> <baseUrl> <city> [id...]` | Geometry, no pictures: for each tall building, the area of its triangles that lie in the same plane as another surface and face the same way, by partner (itself, another tall building, the merged low buildings, anything else). Same-coloured faces of one mesh in one plane do not flicker visibly, so read it with `pair.mjs`. |
| `night.mjs <out> <baseUrl> [extraQuery] [classic,shipped]` | The five night scenes of the goldens, the same five by day, and a dusk sequence (the Sun at +10, +2, −3, −9 and −18 degrees) of one view per city, for the classic renderer and the shipped look. `nightsheet.py <out>` prints each night scene's mean luma, bright and dark shares and saturation against the classic one, and saves a contact sheet; `daycheck.py <before> <after>` compares the day scenes of two runs (within 3 %). |
| `farsheet.py <poses dir> <out.png> <pose...>` | A contact sheet of chosen settled frames from `poses.mjs`, with each pose's camera. |
| `probe.mjs <out> <baseUrl> <label> <city>` | Real mouse and wheel input: tilt as far as it goes, ninety map drags one way, zoom all the way out, turn. One screenshot each, with the camera's state. |
| `boot-ab.mjs <baseUrl> [rounds]` | Time to ready, time to the first frame, and the time from an edit to the next frame, for the classic renderer and both backends of the new one, alternating in one browser. |

`extraQuery` is appended to the address, for example `'&backend=webgpu&nobench=1'`.

Numbers on the Apple M4, 23 November 2026, before the fixes they led to: 60 of 183 tall Las Vegas buildings and 5 of
76 in Salt Lake City showed more than 40 flipping blocks; a frame drawn while moving was between 0.8 and 2.0 times as
bright as the same view once settled; the first frame came 2 to 3 s later than the classic renderer's in Las Vegas.
