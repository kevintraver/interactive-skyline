# pytest for the data pipelines (scripts/*.py). Tests import the scripts' functions; nothing here touches the network.
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
