"""Judge calibration: grade hand-labeled replies and report agreement per rule.

    python -m agent_evals.calibrate      (needs ANTHROPIC_API_KEY)

Each calibration row pairs a golden record with a reply (good or bad) and
the human verdict for the rules it exercises. A judge that disagrees with
the labels is fixed before its numbers are trusted in a compare.
"""

import json
import sys
from pathlib import Path

from .judge import Judge, flatten, judge_available
from .run import load_records, load_specs

CALIBRATION = Path(__file__).resolve().parent.parent / "data" / "calibration.jsonl"


def load_rows(path=CALIBRATION):
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


def agreement(rows, verdicts):
    """rows and verdicts are parallel lists; returns {rule: (agree, total)}."""
    table = {}
    for row, verdict in zip(rows, verdicts):
        for rule, label in row["labels"].items():
            t = table.setdefault(rule, [0, 0])
            t[1] += 1
            t[0] += int(verdict.get(rule) == label)
    return {rule: tuple(v) for rule, v in table.items()}


def main():
    if not judge_available():
        print("calibration needs ANTHROPIC_API_KEY; skipped")
        return 0
    records = {r["id"]: r for r in load_records()}
    specs, judge, rows = load_specs(), Judge(), load_rows()
    verdicts = []
    for row in rows:
        result = {"ok": True, "finalText": row["reply"], "toolCalls": [], "effects": {}}
        verdicts.append(flatten(judge.grade(records[row["record_id"]], result, specs)))
    for rule, (agree, total) in sorted(agreement(rows, verdicts).items()):
        print(f"  {rule:<32} {agree}/{total}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
