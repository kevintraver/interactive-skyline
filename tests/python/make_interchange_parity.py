"""Writes tests/unit/roadnet/interchange-parity.json: the interchange fixture's input (as
tests/unit/roadnet/interchange-fixture.js builds it, dumped to JSON) encoded by the Python writer.
Vitest (interchange-parity.test.js) checks the JavaScript writer gives the same document and bytes;
test_interchanges.py checks the Python writer still does.

    node -e "import('./tests/unit/roadnet/interchange-fixture.js').then(m => process.stdout.write(JSON.stringify(m.interchangeInput())))" > /tmp/in.json
    uv run --with numpy python tests/python/make_interchange_parity.py /tmp/in.json
"""
import base64
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from lib.roadnet import encode_roadnet  # noqa: E402

OUT = ROOT / "tests" / "unit" / "roadnet" / "interchange-parity.json"


def main():
    inp = json.loads(Path(sys.argv[1]).read_text())
    doc, blob = encode_roadnet(json.loads(json.dumps(inp)))
    OUT.write_text(json.dumps({"input": inp, "json": doc, "bin": base64.b64encode(blob).decode()}) + "\n")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(blob)} bytes of stations")


if __name__ == "__main__":
    main()
