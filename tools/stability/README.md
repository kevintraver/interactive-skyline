# Stability tools

Scripts that drive the running app on this machine's GPU and look for pictures that change when they should not:
flicker between surfaces, brightness that swings as the camera moves, parts of the world that go missing far out.
They are measurement tools, not part of `pnpm test`. Each takes the address of a served build
(`pnpm build && pnpm preview --host 127.0.0.1 --port 4891 --strictPort`) and is run from the repository root.

| Script | What it does |
|---|---|
| `poses.mjs <out> <baseUrl> <label> <city> <day\|night\|dusk> [extraQuery]` | Walks the camera along a fixed path of 54 poses inside the camera limits. Saves three frames per pose: as drawn while moving (`-m`), after standing still (`-s`), and with the camera nudged by a hair (`-e`). |
| `analyze.py <out>` | Reads those frames (`uv run --python 3.12 --with numpy --with pillow python tools/stability/analyze.py <out>`). Moving against settled shows what is wrong only while moving, with the brightness ratio between them; settled against nudged shows surfaces that flip under a sub-pixel move; it also lists mostly black frames. |
| `survey.mjs <out> <baseUrl> <city> <day\|night> [label] [extraQuery]` | Flies to every tall building and, from three sides, draws the view twice, the second time nudged by a hair. Counts the 4 × 4 pixel blocks whose brightness flips: stable geometry gives none, surfaces that fight for the same depth give hundreds. On the new renderer pass `&display=classic` so the exposure cannot differ between the two pictures. |
| `pair.mjs <out> <baseUrl> <city> <day\|night> <id...>` | The survey's two pictures for chosen buildings, saved, to look at. Still written for the classic renderer's canvas. |
| `probe.mjs <out> <baseUrl> <label> <city>` | Real mouse and wheel input: tilt as far as it goes, ninety map drags one way, zoom all the way out, turn. One screenshot each, with the camera's state. |
| `boot-ab.mjs <baseUrl> [rounds]` | Time to ready, time to the first frame, and the time from an edit to the next frame, for the classic renderer and both backends of the new one, alternating in one browser. |

`extraQuery` is appended to the address, for example `'&backend=webgpu&nobench=1'`.

Numbers on the Apple M4, 23 November 2026, before the fixes they led to: 60 of 183 tall Las Vegas buildings and 5 of
76 in Salt Lake City showed more than 40 flipping blocks; a frame drawn while moving was between 0.8 and 2.0 times as
bright as the same view once settled; the first frame came 2 to 3 s later than the classic renderer's in Las Vegas.
