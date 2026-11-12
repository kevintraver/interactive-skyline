"""Record a camera flight through interactive-skyline as an animated GIF (for a README or a demo).

    python flyover.py --repo PATH --out docs/flyover.gif --night \
        --key "2260,-2370,545:-300,-1900,85" --key "3160,1030,545:800,2300,85" [--seconds 10 --fps 12]

Each --key is EYE:TARGET, both "east,north,y" in the app's own frame: meters east and north of the city origin,
and y in the scene's height units (meters; on the Las Vegas Strip the ground is at about y = 25). The camera moves
through the keys with an ease-in-out. Frames are rendered one at a time in headless Chrome or Edge, with the
fountain, LED and wheel clocks advanced exactly one frame each time, so the motion is smooth however slow the
renderer is. ffmpeg turns the frames into the GIF.
"""
from __future__ import annotations

import argparse
import base64
import functools
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import urllib.parse

sys.dont_write_bytecode = True  # keep the skill folder free of __pycache__
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from skyline_tool import QuietServer, RepoHandler, check_repo, find_browser, import_map  # noqa: E402

RECORDER = r"""
<script type="module">
// added by flyover.py: renders the camera flight frame by frame and posts each frame to the recorder
import * as THREE from 'three';
const spec = JSON.parse(new URLSearchParams(location.search).get('spec'));
const send = (path, body) => fetch(path, { method: 'POST', body });
try {
  const t0 = performance.now();
  while (!window.__skyline && performance.now() - t0 < 120000) await new Promise((r) => setTimeout(r, 100));
  const s = window.__skyline;
  if (!s) throw new Error('the app never finished loading (window.__skyline missing)');
  s.renderer.setAnimationLoop(null);          // nothing renders but this script from here on
  if ('night' in s.settings) s.setSetting('night', spec.night);
  s.setSetting('highlight', false);
  if (s.attractions) {
    s.attractions.freeze(spec.show);
    await Promise.race([s.attractions.ready, new Promise((r) => setTimeout(r, 30000))]);
    s.attractions.summary();                   // applies night-only visibility (a beam, say) now
  }
  const canvas = s.renderer.domElement;
  for (const el of document.body.children) if (el !== canvas && !el.contains(canvas) && el.tagName !== 'SCRIPT') el.style.setProperty('display', 'none');
  s.camera.fov = spec.fov; s.camera.updateProjectionMatrix();
  const keys = spec.keys.map((k) => k.map(([e, n, y]) => new THREE.Vector3(e, y, -n)));
  const at = (u) => {                          // u in 0..1 along the whole flight, eased, then piecewise linear
    const v = u * u * (3 - 2 * u) * (keys.length - 1), i = Math.min(Math.floor(v), keys.length - 2), f = v - i;
    return [0, 1].map((j) => keys[i][j].clone().lerp(keys[i + 1][j], f));
  };
  for (let i = 0; i < spec.frames; i++) {
    const [eye, target] = at(spec.frames === 1 ? 0 : i / (spec.frames - 1));
    s.camera.position.copy(eye);
    s.controls.target.copy(target);
    s.camera.lookAt(target);
    s.camera.updateMatrixWorld();
    if (s.attractions) s.attractions.freeze(spec.show + i / spec.fps);
    s.renderer.render(s.scene, s.camera);
    await send(`/__frame/${i}`, canvas.toDataURL('image/png'));  // read back before anything clears the buffer
  }
  await send('/__done', JSON.stringify({ ok: true }));
} catch (e) {
  await send('/__done', JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
}
</script>
"""


def recorder_page(repo: str) -> bytes:
    page = open(os.path.join(repo, "index.html"), encoding="utf-8").read()
    first_module = page.find('<script type="module"')
    if first_module < 0 or "</body>" not in page:
        raise SystemExit("index.html has no module script or </body>; the recorder page cannot be built")
    page = page[:first_module] + import_map(repo) + page[first_module:]
    return page.replace("</body>", RECORDER + "</body>", 1).encode("utf-8")


class FlightHandler(RepoHandler):
    """The check server, plus POST /__frame/N (a PNG data URL) and POST /__done (the outcome)."""

    def __init__(self, *args, frames: str, result: dict, done: threading.Event, **kwargs):
        self.frames, self.result, self.done = frames, result, done
        super().__init__(*args, **kwargs)

    def do_POST(self) -> None:  # noqa: N802
        path = urllib.parse.urlparse(self.path).path
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if path.startswith("/__frame/") and path.rsplit("/", 1)[1].isdigit():
            png = base64.b64decode(body.split(b",", 1)[1])
            with open(os.path.join(self.frames, f"{int(path.rsplit('/', 1)[1]):04d}.png"), "wb") as fh:
                fh.write(png)
        elif path == "/__done":
            self.result.update(json.loads(body))
            self.done.set()
        self.send_response(204)
        self.end_headers()


def parse_key(spec: str) -> list[list[float]]:
    try:
        eye, target = ([float(v) for v in part.split(",")] for part in spec.split(":"))
    except ValueError:
        raise SystemExit(f"--key {spec!r}: expected EAST,NORTH,Y:EAST,NORTH,Y") from None
    if len(eye) != 3 or len(target) != 3:
        raise SystemExit(f"--key {spec!r}: expected EAST,NORTH,Y:EAST,NORTH,Y")
    return [eye, target]


def record(args: argparse.Namespace, frames_dir: str) -> None:
    check_repo(args.repo, args.city)
    width, height = (int(v) for v in args.size.split("x"))
    spec = {"keys": [parse_key(k) for k in args.key], "frames": round(args.seconds * args.fps), "fps": args.fps,
            "fov": args.fov, "night": args.night, "show": args.show}
    result: dict = {}
    done = threading.Event()
    handler = functools.partial(FlightHandler, repo=os.path.abspath(args.repo), page=recorder_page(args.repo),
                                missing=[], frames=frames_dir, result=result, done=done)
    server = QuietServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    query = urllib.parse.urlencode({"city": args.city, "spec": json.dumps(spec)})
    url = f"http://127.0.0.1:{server.server_address[1]}/__check.html?{query}"
    profile = tempfile.mkdtemp(prefix="skyline-flyover-")
    cmd = [find_browser(args.browser), "--headless=new", "--no-first-run", "--no-default-browser-check",
           "--disable-extensions", f"--user-data-dir={profile}", f"--window-size={width},{height}",
           "--force-device-scale-factor=1", "--hide-scrollbars", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
           "--remote-debugging-port=0", url]
    browser = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        if not done.wait(args.timeout):
            raise SystemExit(f"no result after {args.timeout} s; {len(os.listdir(frames_dir))} frames arrived")
    finally:
        browser.kill()
        browser.wait()
        server.shutdown()
        shutil.rmtree(profile, ignore_errors=True)
    if not result.get("ok"):
        raise SystemExit(f"the recorder failed: {result.get('error')}")
    print(f"rendered {spec['frames']} frames at {width}x{height}")


def encode_gif(frames_dir: str, out: str, fps: float, width: int, colors: int) -> None:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise SystemExit(f"ffmpeg is not on PATH; the frames are in {frames_dir}")
    graph = (f"scale={width}:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors={colors}:stats_mode=full[p];"
             "[b][p]paletteuse=dither=bayer:bayer_scale=5")
    subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-framerate", str(fps), "-i", os.path.join(frames_dir, "%04d.png"),
                    "-vf", graph, "-loop", "0", out], check=True)
    print(f"wrote {out} ({os.path.getsize(out) / 1e6:.1f} MB)")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--repo", required=True, help="the interactive-skyline checkout")
    parser.add_argument("--city", default="lv")
    parser.add_argument("--out", required=True, help="the GIF to write")
    parser.add_argument("--key", action="append", required=True, help="EYE:TARGET as east,north,y:east,north,y (2 or more)")
    parser.add_argument("--seconds", type=float, default=10.0)
    parser.add_argument("--fps", type=float, default=12.0)
    parser.add_argument("--size", default="1280x720", help="render size; the GIF is scaled down to --width")
    parser.add_argument("--width", type=int, default=800, help="GIF width in pixels")
    parser.add_argument("--colors", type=int, default=192, help="GIF palette size (fewer makes a smaller file)")
    parser.add_argument("--fov", type=float, default=35.0, help="vertical field of view in degrees")
    parser.add_argument("--night", action="store_true")
    parser.add_argument("--show", type=float, default=40.0, help="fountain/LED/wheel clock at the first frame, seconds")
    parser.add_argument("--frames-dir", help="keep the PNG frames here (default: a temporary folder)")
    parser.add_argument("--browser", help="path to Chrome or Edge")
    parser.add_argument("--timeout", type=float, default=900.0, help="seconds to wait for the whole recording")
    args = parser.parse_args()
    if len(args.key) < 2:
        raise SystemExit("give at least two --key positions")
    frames_dir = args.frames_dir or tempfile.mkdtemp(prefix="skyline-frames-")
    os.makedirs(frames_dir, exist_ok=True)
    record(args, frames_dir)
    encode_gif(frames_dir, args.out, args.fps, args.width, args.colors)
    if not args.frames_dir:
        shutil.rmtree(frames_dir, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
