"""CLI: eval / baseline / compare.

    python -m agent_evals eval                 # score once, print the report
    python -m agent_evals baseline --runs 5    # fold N runs into results/baseline.json
    python -m agent_evals compare              # FAIL on a confirmed regression vs the baseline

Run from the evals/ directory. Offline by default (mock model, no judge).
"""

import argparse
import datetime as dt
import json
import sys
from pathlib import Path

from . import checks as checks_mod
from .compare import CONFIRM_RUNS, aggregate, compare, suspects
from .judge import Judge, flatten, judge_available
from .runner import run_turns

ROOT = Path(__file__).resolve().parent.parent
GOLDEN = ROOT / "data" / "golden.jsonl"
SPECS = ROOT / "data" / "specs.json"
BASELINE = ROOT / "results" / "baseline.json"


def load_records(path=GOLDEN):
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


def load_specs(path=SPECS):
    return json.loads(Path(path).read_text())


def score(records, results, specs, judge=None):
    out = {}
    for rec in records:
        result = results.get(rec["id"]) or {"id": rec["id"], "ok": False, "error": "no result"}
        entry = {"categories": rec["category"], "finalText": result.get("finalText"), "checks": checks_mod.run_checks(rec, result, specs)}
        if judge is not None and result.get("ok"):
            entry["judged"] = flatten(judge.grade(rec, result, specs))
        out[rec["id"]] = entry
    return out


def scored_run(records, specs, judge):
    results = run_turns(records)
    model = next(iter(results.values()), {}).get("model", "unknown")
    run_id = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S%f")
    return {"meta": {"runId": run_id, "model": model, "judge": bool(judge)}, "records": score(records, results, specs, judge)}


def report(scores, out=sys.stdout):
    w = out.write
    totals = {}
    for e in scores["records"].values():
        for name, failures in e["checks"].items():
            t = totals.setdefault(name, [0, 0, 0])
            if failures is None:
                t[2] += 1
            elif failures:
                t[1] += 1
            else:
                t[0] += 1
    w(f"\nAgent evals: {len(scores['records'])} records, model={scores['meta']['model']}, judge={'on' if scores['meta']['judge'] else 'off (no ANTHROPIC_API_KEY)'}\n")
    for name, (p, f, na) in totals.items():
        rate = f"{100 * p / (p + f):5.1f}%" if p + f else "  n/a "
        w(f"  {name:<14} {rate}  pass {p:>3}  fail {f:>3}  n/a {na:>3}\n")
    hard = [(rid, n, f) for rid, e in scores["records"].items() for n, f in e["checks"].items() if f]
    if hard:
        w("\nHard failures:\n")
        for rid, name, failures in hard:
            w(f"  {rid} {name}: {'; '.join(failures)}\n")
    return 1 if hard else 0


def main(argv=None):
    parser = argparse.ArgumentParser(prog="agent_evals")
    parser.add_argument("command", choices=["eval", "baseline", "compare"])
    parser.add_argument("--runs", type=int, default=5)
    args = parser.parse_args(argv)

    records, specs = load_records(), load_specs()
    judge = Judge() if judge_available() else None

    if args.command == "eval":
        return report(scored_run(records, specs, judge))
    if args.command == "baseline":
        runs = [scored_run(records, specs, judge) for _ in range(args.runs)]
        BASELINE.parent.mkdir(parents=True, exist_ok=True)
        BASELINE.write_text(json.dumps(aggregate(runs), indent=2) + "\n")
        print(f"wrote {BASELINE.relative_to(ROOT)} ({args.runs} runs)")
        return 0
    baseline = json.loads(BASELINE.read_text())
    first = scored_run(records, specs, judge)
    runs = [first]
    rerun = [r for r in records if r["id"] in suspects(baseline, first)]
    for _ in range(CONFIRM_RUNS - 1):
        if rerun:
            runs.append(scored_run(rerun, specs, judge))
    report(first)
    return compare(baseline, runs)


if __name__ == "__main__":
    sys.exit(main())
