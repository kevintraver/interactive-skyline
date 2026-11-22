import sys
from pathlib import Path

# the pipeline's shared modules live in scripts/lib
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
