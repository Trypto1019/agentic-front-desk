import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


@pytest.fixture(scope="session")
def specs():
    return json.loads((ROOT / "data" / "specs.json").read_text())


@pytest.fixture(scope="session")
def golden():
    return [json.loads(line) for line in (ROOT / "data" / "golden.jsonl").read_text().splitlines() if line.strip()]
