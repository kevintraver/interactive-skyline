"""Write files so that a reader (the app's dev server, another tool) never sees one half written: each is written
beside its target and renamed over it. Several files given together are all written first and then renamed one after
another, so a pair that belongs together (roadnet.json and roadnet.bin) is new within moments of each other.

    from lib.atomic import write_files
    write_files({path_json: text, path_bin: blob})     # str is written as UTF-8, bytes as they are
"""
import os
from pathlib import Path


def write_files(files):
    staged = []
    try:
        for path, data in files.items():
            path = Path(path)
            tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
            if isinstance(data, str):
                tmp.write_text(data)
            else:
                tmp.write_bytes(data)
            staged.append((tmp, path))
        for tmp, path in staged:
            os.replace(tmp, path)
    finally:
        for tmp, _ in staged:
            if tmp.exists():
                tmp.unlink()
