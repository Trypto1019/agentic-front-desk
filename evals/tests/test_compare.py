import io

from agent_evals.compare import aggregate, compare, suspects


def run(run_id, failing=(), judged_fail=()):
    records = {}
    for rid in ("g001", "g002", "g003", "g004"):
        records[rid] = {
            "categories": ["booking"],
            "finalText": "x",
            "checks": {"a_outcome": ["expected book"] if rid in failing else []},
            "judged": {"h_helpfulness": "fail" if rid in judged_fail else "pass"},
        }
    return {"meta": {"runId": run_id}, "records": records}


def test_clean_candidate_passes():
    baseline = aggregate([run(f"b{i}") for i in range(5)])
    out = io.StringIO()
    assert compare(baseline, [run("c1")], out) == 0
    assert "PASS" in out.getvalue()


def test_single_failure_that_does_not_reproduce_is_flaky_not_a_regression():
    baseline = aggregate([run(f"b{i}") for i in range(5)])
    out = io.StringIO()
    assert compare(baseline, [run("c1", failing={"g001"}), run("c2"), run("c3")], out) == 0
    assert "did not reproduce" in out.getvalue()


def test_three_of_three_failures_is_a_regression():
    baseline = aggregate([run(f"b{i}") for i in range(5)])
    out = io.StringIO()
    candidate = [run(f"c{i}", failing={"g001"}) for i in range(3)]
    assert compare(baseline, candidate, out) == 1
    assert "NEW HARD FAILURE g001 a_outcome" in out.getvalue()


def test_failures_already_in_the_baseline_are_not_new():
    baseline = aggregate([run("b0", failing={"g002"}), *[run(f"b{i}") for i in range(1, 5)]])
    assert compare(baseline, [run(f"c{i}", failing={"g002"}) for i in range(3)], io.StringIO()) == 0
    assert suspects(baseline, run("c", failing={"g002"})) == []


def test_judged_rule_drop_over_two_points_fails():
    baseline = aggregate([run(f"b{i}") for i in range(3)])
    out = io.StringIO()
    assert compare(baseline, [run("c1", judged_fail={"g003"})], out) == 1
    assert "JUDGED DROP h_helpfulness" in out.getvalue()
