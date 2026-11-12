"""Gather and prepare reference images for modeling a landmark. Needs Pillow.

    python refs.py commons-search --out DIR "query" ...        Commons search -> candidates + labelled thumbnail sheet
    python refs.py commons  --out DIR  TITLE_OR_URL ...        Wikimedia Commons / Wikipedia files, with author+license
    python refs.py url      --out DIR  URL ...                 any direct image link
    python refs.py pixabay-key                                 is a Pixabay key available? (never prints it)
    python refs.py pixabay-search --out DIR "query" ...        Pixabay API search -> hits.json + labelled contact sheet
    python refs.py pixabay-get    --out DIR --hits DIR/hits.json --ids 123,456
    python refs.py crop  SRC --box X0,Y0,X1,Y1 [--frac] --out OUT.jpg [--size 1100]
    python refs.py sheet --out OUT.jpg [--cols 4] [--cell 400] IMAGE ...

Every download is checked to really be an image (sites that block scripts often answer with an HTML page)
and recorded in DIR/sources.json with where it came from, so credits can be given later.

Pixabay needs an API key. It is read from the PIXABAY_API_KEY environment variable, or on Windows from the
Credential Manager entry named by --credential (default "pixabay.com", a generic credential whose password
is the key). The key is only ever placed in the request to pixabay.com: it is never printed, logged, or
written to disk, and errors report the HTTP status only, because the request URL carries the key.
"""
from __future__ import annotations

import argparse
import html
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

try:
    from PIL import Image, ImageDraw
except ImportError:  # pragma: no cover
    raise SystemExit("refs.py needs Pillow: python -m pip install pillow")

USER_AGENT = "landmark-reference-fetch/1.0 (3D modelling reference; python-urllib)"
COMMONS_API = "https://commons.wikimedia.org/w/api.php"
PIXABAY_API = "https://pixabay.com/api/"


# ----------------------------------------------------------------- plumbing
def http_get(url: str, timeout: float = 60, attempts: int = 4) -> tuple[bytes, str]:
    """GET with retries on rate limits and server hiccups (several agents may hit Commons at once)."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read(), resp.headers.get("Content-Type", "")
        except urllib.error.HTTPError as err:
            if err.code not in (429, 500, 502, 503, 504) or attempt == attempts - 1:
                raise
            wait = float(err.headers.get("Retry-After") or 0) or 2.0 * 2 ** attempt
            time.sleep(min(wait, 20.0))
    raise RuntimeError("unreachable")


def save_image(data: bytes, out_dir: str, name: str) -> tuple[str, tuple[int, int]]:
    """Validate that `data` is an image and save it as JPEG (or PNG when it has transparency)."""
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except Exception as err:
        snippet = data[:80].decode("utf-8", "replace").replace("\n", " ")
        raise ValueError(f"not an image ({type(err).__name__}); the server sent: {snippet!r}") from err
    stem = re.sub(r"[^A-Za-z0-9._-]+", "_", os.path.splitext(name)[0])[:80] or "image"
    if img.mode in ("RGBA", "LA", "P") and "transparency" in img.info or img.mode == "RGBA":
        path = os.path.join(out_dir, stem + ".png")
        img.save(path)
    else:
        path = os.path.join(out_dir, stem + ".jpg")
        img.convert("RGB").save(path, quality=92)
    return path, img.size


def record(out_dir: str, entry: dict) -> None:
    path = os.path.join(out_dir, "sources.json")
    entries = []
    if os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            entries = json.load(fh)
    entries = [e for e in entries if e.get("file") != entry["file"]] + [entry]
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(entries, fh, indent=2)


def strip_tags(text: str) -> str:
    return html.unescape(re.sub(r"<[^>]+>", "", text or "")).strip()


# ------------------------------------------------------------------ commons
def commons_title(ref: str) -> str:
    """'File:X.jpg' from a title, a bare file name, a Commons/Wikipedia page URL or a #/media/ link."""
    ref = urllib.parse.unquote(ref.strip())
    match = re.search(r"(?:File|Image):([^?#&]+)", ref)
    name = match.group(1) if match else ref.rsplit("/", 1)[-1]
    return "File:" + name.replace("_", " ").strip()


def commons(out_dir: str, refs: list[str], width: int) -> int:
    failures = 0
    for ref in refs:
        title = commons_title(ref)
        params = {"action": "query", "format": "json", "prop": "imageinfo", "titles": title,
                  "iiprop": "url|extmetadata|size", "iiurlwidth": str(width)}
        info = None
        for api in (COMMONS_API, "https://en.wikipedia.org/w/api.php"):  # local Wikipedia files are not on Commons
            try:
                data, _ = http_get(api + "?" + urllib.parse.urlencode(params))
            except urllib.error.URLError as err:
                print(f"  {title}: lookup failed ({err})")
                continue
            pages = json.loads(data).get("query", {}).get("pages", {})
            page = next(iter(pages.values()), {})
            if page.get("imageinfo"):
                info = page["imageinfo"][0]
                break
        if info is None:
            print(f"  {title}: not found on Commons or English Wikipedia")
            failures += 1
            continue
        meta = info.get("extmetadata", {})
        url = info.get("thumburl") or info["url"]
        try:
            blob, _ = http_get(url)
            path, size = save_image(blob, out_dir, title[5:])
        except (urllib.error.URLError, ValueError) as err:
            print(f"  {title}: download failed ({err})")
            failures += 1
            continue
        entry = {"file": os.path.basename(path), "source": info.get("descriptionurl", url), "image_url": url,
                 "author": strip_tags(meta.get("Artist", {}).get("value", "")),
                 "license": strip_tags(meta.get("LicenseShortName", {}).get("value", "")),
                 "description": strip_tags(meta.get("ImageDescription", {}).get("value", ""))[:300],
                 "size": list(size)}
        record(out_dir, entry)
        print(f"  {path}  {size[0]}x{size[1]}  {entry['license']}  by {entry['author'] or 'unknown'}")
        time.sleep(0.5)  # be gentle with the API
    return failures


def commons_search(out_dir: str, queries: list[str], limit: int) -> int:
    """Search Commons files; save candidates.json and a labelled thumbnail sheet to pick from."""
    found: dict[str, dict] = {}
    for q in queries:
        params = {"action": "query", "format": "json", "generator": "search", "gsrsearch": f"filetype:bitmap {q}",
                  "gsrnamespace": "6", "gsrlimit": str(limit), "prop": "imageinfo", "iiprop": "url|size",
                  "iiurlwidth": "320"}
        try:
            data, _ = http_get(COMMONS_API + "?" + urllib.parse.urlencode(params))
        except urllib.error.URLError as err:
            print(f"  {q!r}: search failed ({err})")
            continue
        pages = json.loads(data).get("query", {}).get("pages", {})
        print(f"  {q!r}: {len(pages)} files")
        for page in sorted(pages.values(), key=lambda p: p.get("index", 0)):
            info = (page.get("imageinfo") or [{}])[0]
            found.setdefault(page["title"], {"title": page["title"], "query": q, "thumb": info.get("thumburl"),
                                             "width": info.get("width"), "height": info.get("height"),
                                             "page": info.get("descriptionurl")})
        time.sleep(0.5)
    with open(os.path.join(out_dir, "commons_candidates.json"), "w", encoding="utf-8") as fh:
        json.dump(list(found.values()), fh, indent=2)
    tiles = []
    for k, item in enumerate(found.values()):
        if not item["thumb"]:
            continue
        try:
            blob, _ = http_get(item["thumb"], timeout=30)
            tiles.append((f"{k}: {item['title'][5:40]}", Image.open(io.BytesIO(blob)).convert("RGB")))
            item["sheet_index"] = k
        except Exception:
            continue
    with open(os.path.join(out_dir, "commons_candidates.json"), "w", encoding="utf-8") as fh:
        json.dump(list(found.values()), fh, indent=2)
    if tiles:
        path = os.path.join(out_dir, "commons_sheet.jpg")
        contact_sheet(tiles, path, cols=6, cell=260)
        print(f"  {len(found)} candidates -> commons_candidates.json; sheet -> {path} (labels: index: title)")
    return 0


def plain_urls(out_dir: str, urls: list[str]) -> int:
    failures = 0
    for url in urls:
        name = urllib.parse.urlparse(url).path.rsplit("/", 1)[-1] or "image"
        try:
            blob, _ = http_get(url)
            path, size = save_image(blob, out_dir, name)
        except (urllib.error.URLError, ValueError) as err:
            print(f"  {url}: {err}")
            failures += 1
            continue
        record(out_dir, {"file": os.path.basename(path), "source": url, "size": list(size)})
        print(f"  {path}  {size[0]}x{size[1]}")
    return failures


# ------------------------------------------------------------------ pixabay
def windows_credential(target: str) -> str | None:
    """The password of a generic Windows credential, or None. Never printed."""
    if sys.platform != "win32":
        return None
    import ctypes
    from ctypes import wintypes

    class CREDENTIAL(ctypes.Structure):
        _fields_ = [("Flags", wintypes.DWORD), ("Type", wintypes.DWORD), ("TargetName", wintypes.LPWSTR),
                    ("Comment", wintypes.LPWSTR), ("LastWritten", wintypes.FILETIME),
                    ("CredentialBlobSize", wintypes.DWORD), ("CredentialBlob", ctypes.POINTER(ctypes.c_ubyte)),
                    ("Persist", wintypes.DWORD), ("AttributeCount", wintypes.DWORD), ("Attributes", ctypes.c_void_p),
                    ("TargetAlias", wintypes.LPWSTR), ("UserName", wintypes.LPWSTR)]

    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    advapi.CredReadW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                 ctypes.POINTER(ctypes.POINTER(CREDENTIAL))]
    advapi.CredReadW.restype = wintypes.BOOL
    advapi.CredFree.argtypes = [ctypes.c_void_p]
    cred = ctypes.POINTER(CREDENTIAL)()
    if not advapi.CredReadW(target, 1, 0, ctypes.byref(cred)):  # 1 = CRED_TYPE_GENERIC
        return None
    try:
        blob = ctypes.string_at(cred.contents.CredentialBlob, cred.contents.CredentialBlobSize)
    finally:
        advapi.CredFree(cred)
    for encoding in ("utf-16-le", "utf-8"):  # Credential Manager stores UTF-16; other tools may store UTF-8
        try:
            text = blob.decode(encoding).strip("\x00").strip()
        except UnicodeDecodeError:
            continue
        if text and text.isprintable():
            return text
    return None


def pixabay_key(credential: str) -> str:
    key = os.environ.get("PIXABAY_API_KEY") or windows_credential(credential)
    if not key:
        raise SystemExit("No Pixabay key: set PIXABAY_API_KEY, or add a generic Windows credential named "
                         f"{credential!r} whose password is the key (Credential Manager > Windows Credentials).")
    return key


def pixabay_key_check(credential: str) -> int:
    """Say whether a Pixabay key can be found, and where from, without revealing it."""
    if os.environ.get("PIXABAY_API_KEY"):
        print("Pixabay key: available (PIXABAY_API_KEY)")
        return 0
    if windows_credential(credential):
        print(f"Pixabay key: available (Windows Credential Manager entry {credential!r})")
        return 0
    print("Pixabay key: not available; skip Pixabay")
    return 1


def pixabay_search(out_dir: str, queries: list[str], credential: str, per_page: int) -> int:
    key = pixabay_key(credential)
    hits: dict[int, dict] = {}
    for q in queries:
        params = {"key": key, "q": q[:100], "image_type": "photo", "safesearch": "true", "per_page": str(per_page)}
        try:
            data, _ = http_get(PIXABAY_API + "?" + urllib.parse.urlencode(params), timeout=30)
        except urllib.error.HTTPError as err:
            print(f"  {q!r}: HTTP {err.code}")  # never the URL or the error text: both carry the key
            continue
        except urllib.error.URLError:
            print(f"  {q!r}: no response")
            continue
        result = json.loads(data)
        print(f"  {q!r}: {result.get('totalHits', 0)} hits")
        for h in result.get("hits", []):
            hits.setdefault(h["id"], {"id": h["id"], "query": q, "tags": h.get("tags", ""), "page": h.get("pageURL"),
                                      "user": h.get("user"), "width": h.get("imageWidth"),
                                      "height": h.get("imageHeight"), "preview": h.get("webformatURL"),
                                      "large": h.get("largeImageURL")})
        time.sleep(0.7)  # Pixabay allows 100 requests a minute
    key = None
    path = os.path.join(out_dir, "hits.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(list(hits.values()), fh, indent=2)
    print(f"  {len(hits)} unique hits -> {path}")
    # Pixabay's search is loose (other towers, guitars named Strat...): a labelled sheet makes picking quick
    tiles = []
    for h in hits.values():
        try:
            blob, _ = http_get(h["preview"], timeout=30)
            img = Image.open(io.BytesIO(blob)).convert("RGB")
            tiles.append((str(h["id"]), img))
        except Exception:
            continue
    if tiles:
        sheet_path = os.path.join(out_dir, "hits_sheet.jpg")
        contact_sheet(tiles, sheet_path, cols=6, cell=260)
        print(f"  contact sheet -> {sheet_path} (labels are Pixabay ids for pixabay-get)")
    return 0


def pixabay_get(out_dir: str, hits_path: str, ids: list[int]) -> int:
    with open(hits_path, encoding="utf-8") as fh:
        hits = {h["id"]: h for h in json.load(fh) if isinstance(h, dict)}
    failures = 0
    for i in ids:
        h = hits.get(i)
        if not h:
            print(f"  {i}: not in {hits_path}")
            failures += 1
            continue
        try:
            blob, _ = http_get(h["large"])
            path, size = save_image(blob, out_dir, f"pixabay_{i}")
        except (urllib.error.URLError, ValueError) as err:
            print(f"  {i}: {err}")
            failures += 1
            continue
        record(out_dir, {"file": os.path.basename(path), "source": h["page"], "author": h.get("user"),
                         "license": "Pixabay Content License", "size": list(size)})
        print(f"  {path}  {size[0]}x{size[1]}  by {h.get('user')}")
    return failures


# ------------------------------------------------------------ crops + sheets
def crop(src: str, box: str, frac: bool, out: str, size: int) -> int:
    img = Image.open(src).convert("RGB")
    x0, y0, x1, y1 = (float(v) for v in box.split(","))
    if frac:
        x0, x1, y0, y1 = x0 * img.width, x1 * img.width, y0 * img.height, y1 * img.height
    region = img.crop((int(x0), int(y0), int(x1), int(y1)))
    k = size / max(region.size)
    region = region.resize((max(1, round(region.width * k)), max(1, round(region.height * k))), Image.LANCZOS)
    region.save(out, quality=92)
    print(f"  {out}  {region.width}x{region.height}")
    return 0


def contact_sheet(tiles: list[tuple[str, Image.Image]], out: str, cols: int, cell: int) -> None:
    rows = (len(tiles) + cols - 1) // cols
    label_h = 18
    sheet = Image.new("RGB", (cols * cell, rows * (cell + label_h)), (20, 20, 20))
    draw = ImageDraw.Draw(sheet)
    for k, (label, img) in enumerate(tiles):
        img = img.copy()
        img.thumbnail((cell - 6, cell - 6))
        x, y = (k % cols) * cell, (k // cols) * (cell + label_h)
        sheet.paste(img, (x + (cell - img.width) // 2, y + (cell - img.height) // 2))
        draw.text((x + 4, y + cell + 2), label[:40], fill=(235, 235, 235))
    sheet.save(out, quality=90)


def sheet(images: list[str], out: str, cols: int, cell: int) -> int:
    tiles = [(os.path.basename(p), Image.open(p).convert("RGB")) for p in images]
    contact_sheet(tiles, out, cols=min(cols, len(tiles)), cell=cell)
    print(f"  {out}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Gather and prepare reference images.")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("commons"); p.add_argument("--out", required=True); p.add_argument("--width", type=int, default=1600)
    p.add_argument("refs", nargs="+")
    p = sub.add_parser("commons-search"); p.add_argument("--out", required=True)
    p.add_argument("--limit", type=int, default=24); p.add_argument("queries", nargs="+")
    p = sub.add_parser("url"); p.add_argument("--out", required=True); p.add_argument("urls", nargs="+")
    p = sub.add_parser("pixabay-key"); p.add_argument("--credential", default="pixabay.com")
    p = sub.add_parser("pixabay-search"); p.add_argument("--out", required=True)
    p.add_argument("--credential", default="pixabay.com"); p.add_argument("--per-page", type=int, default=30)
    p.add_argument("queries", nargs="+")
    p = sub.add_parser("pixabay-get"); p.add_argument("--out", required=True); p.add_argument("--hits", required=True)
    p.add_argument("--ids", required=True)
    p = sub.add_parser("crop"); p.add_argument("src"); p.add_argument("--box", required=True)
    p.add_argument("--frac", action="store_true"); p.add_argument("--out", required=True)
    p.add_argument("--size", type=int, default=1100)
    p = sub.add_parser("sheet"); p.add_argument("--out", required=True); p.add_argument("--cols", type=int, default=4)
    p.add_argument("--cell", type=int, default=400); p.add_argument("images", nargs="+")
    args = parser.parse_args()

    out_dir = getattr(args, "out", None)
    if args.cmd in ("commons", "commons-search", "url", "pixabay-search", "pixabay-get"):
        os.makedirs(out_dir, exist_ok=True)
    if args.cmd == "commons":
        return 1 if commons(out_dir, args.refs, args.width) else 0
    if args.cmd == "commons-search":
        return commons_search(out_dir, args.queries, max(1, min(50, args.limit)))
    if args.cmd == "url":
        return 1 if plain_urls(out_dir, args.urls) else 0
    if args.cmd == "pixabay-key":
        return pixabay_key_check(args.credential)
    if args.cmd == "pixabay-search":
        return pixabay_search(out_dir, args.queries, args.credential, max(3, min(200, args.per_page)))
    if args.cmd == "pixabay-get":
        return 1 if pixabay_get(out_dir, args.hits, [int(i) for i in args.ids.split(",") if i.strip()]) else 0
    if args.cmd == "crop":
        return crop(args.src, args.box, args.frac, args.out, args.size)
    return sheet(args.images, args.out, args.cols, args.cell)


if __name__ == "__main__":
    sys.exit(main())
