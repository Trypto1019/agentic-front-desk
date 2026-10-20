"""Baseline / compare with model noise taken out.

The agent runs at temperature 0.2, so the same code does not give the same
reply every time. In production, two runs of identical code differed on
several hard checks and moved a small judged rule by double-digit points. A
single sample cannot gate a deploy, so:

- The baseline is several runs (5). Per record it keeps how many runs failed
  each check and each judged rule; a record that failed some but not all
  runs is flaky, and its failures are never "new".
- A compare runs every record once. Any record that fails a check or judged
  rule it passed in EVERY baseline run is re-run twice more. It counts as a
  regression only when it fails all 3 runs. (2 of 3 was tried first and
  still produced false regressions on identical code.)
- Judged rules use each record's majority verdict on both sides, and a rule
  fails the compare when its pass rate drops more than 2 points.
"""

import json
import sys
from pathlib import Path

JUDGED_DROP_POINTS = 2.0
CONFIRM_RUNS = 3
CONFIRM_FAILURES = 3


def aggregate(score_list):
    """Fold several scored runs into one baseline."""
    ids = sorted(set().union(*(s["records"].keys() for s in score_list)))
    records = {}
    for rid in ids:
        samples = [s["records"][rid] for s in score_list if rid in s["records"]]
        checks, judged = {}, {}
        for name in samples[0]["checks"]:
            applicable = [x["checks"].get(name) for x in samples if x["checks"].get(name) is not None]
            checks[name] = None if not applicable else sum(1 for v in applicable if v)
        for rule in samples[0].get("judged") or {}:
            applicable = [v for v in ((x.get("judged") or {}).get(rule) for x in samples) if v not in (None, "n/a")]
            judged[rule] = None if not applicable else sum(1 for v in applicable if v == "fail")
        records[rid] = {
            "categories": samples[0]["categories"],
            "samples": len(samples),
            "checks": checks,
            "judged": judged,
            "finalTexts": [x.get("finalText") for x in samples],
            "failures": {n: (samples[0]["checks"].get(n) or []) for n in checks},
        }
    return {
        "meta": {**score_list[0]["meta"], "runs": [s["meta"]["runId"] for s in score_list], "samples": len(score_list)},
        "summary": baseline_summary(records),
        "records": records,
    }


def _majority_fail(count, samples):
    return count is not None and count * 2 > samples


def baseline_summary(records):
    checks, judged = {}, {}
    for e in records.values():
        for table, values in ((checks, e["checks"]), (judged, e["judged"])):
            for name, count in values.items():
                t = table.setdefault(name, {"pass": 0, "fail": 0, "na": 0})
                if count is None:
                    t["na"] += 1
                elif _majority_fail(count, e["samples"]):
                    t["fail"] += 1
                else:
                    t["pass"] += 1
    for t in list(checks.values()) + list(judged.values()):
        n = t["pass"] + t["fail"]
        t["rate"] = round(100.0 * t["pass"] / n, 1) if n else None
    return {"checks": checks, "judged": judged}


def suspects(baseline, candidate):
    """Records that fail something now that never failed in the baseline."""
    out = set()
    for rid, e in candidate["records"].items():
        b = baseline["records"].get(rid)
        if b is None:
            if any(e["checks"].values()) or any(v == "fail" for v in (e.get("judged") or {}).values()):
                out.add(rid)
            continue
        if any(failures and not b["checks"].get(name) for name, failures in e["checks"].items()):
            out.add(rid)
        if any(v == "fail" and not b["judged"].get(rule) for rule, v in (e.get("judged") or {}).items()):
            out.add(rid)
    return sorted(out)


def compare(baseline, candidate_runs, out=sys.stdout):
    """candidate_runs[0] covers every record; later entries re-run suspects. Returns an exit code."""
    w = out.write
    first = candidate_runs[0]
    folded = aggregate(candidate_runs)
    problems, flaky, fixed = [], [], []
    for rid, e in sorted(folded["records"].items()):
        b = baseline["records"].get(rid)
        for name, count in e["checks"].items():
            if not count:
                if b and b["checks"].get(name) and _majority_fail(b["checks"][name], b["samples"]):
                    fixed.append(f"{rid} {name}")
                continue
            if b is not None and b["checks"].get(name):
                continue  # failed in the baseline too
            if e["samples"] >= CONFIRM_RUNS and count >= CONFIRM_FAILURES:
                failures = first["records"][rid]["checks"].get(name) or ["(failed on re-run)"]
                problems.append(f"NEW HARD FAILURE {rid} {name} ({count}/{e['samples']} runs): {'; '.join(failures)}")
            else:
                flaky.append(f"{rid} {name} ({count}/{e['samples']} runs)")

    def judged_rates(records):
        rates = {}
        for e in records.values():
            for rule, count in e["judged"].items():
                t = rates.setdefault(rule, [0, 0])
                if count is None:
                    continue
                t[1] += 1
                if not _majority_fail(count, e["samples"]):
                    t[0] += 1
        return {rule: (100.0 * p / n if n else None, n) for rule, (p, n) in rates.items()}

    base_rates = judged_rates(baseline["records"])
    for rule, (rate, n) in sorted(judged_rates(folded["records"]).items()):
        b_rate = base_rates.get(rule, (None, 0))[0]
        if rate is not None and b_rate is not None and b_rate - rate > JUDGED_DROP_POINTS:
            problems.append(f"JUDGED DROP {rule}: {b_rate:.1f} -> {rate:.1f} ({b_rate - rate:.1f} points, {n} records)")

    w(f"\nCompare against baseline ({baseline['meta'].get('samples')} runs)\n")
    if fixed:
        w(f"  fixed since baseline ({len(fixed)}): {', '.join(fixed)}\n")
    if flaky:
        w(f"  did not reproduce, not counted ({len(flaky)}): {', '.join(flaky)}\n")
    if problems:
        w(f"  FAIL: {len(problems)} regression(s)\n")
        for p in problems:
            w(f"    {p}\n")
        return 1
    w("  PASS: no new hard failure, no judged rule down more than 2 points\n")
    return 0


def compare_files(baseline_path, candidate_paths):
    baseline = json.loads(Path(baseline_path).read_text())
    return compare(baseline, [json.loads(Path(p).read_text()) for p in candidate_paths])
