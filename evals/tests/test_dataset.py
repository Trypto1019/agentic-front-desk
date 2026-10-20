"""The golden set itself: shape, coverage and synthetic-data hygiene."""

import json
import re
from collections import Counter
from datetime import datetime
from pathlib import Path

import pytest

CATEGORIES = {
    "booking", "hours_or_nothing_open", "cancel", "complex_reschedule", "did_booking_go_through", "opt_out",
    "payment", "active_member", "identity", "contact_later", "prompt_injection",
}
COVERAGE = {"prompt_injection": 3, "opt_out": 4, "booking": 3, "cancel": 3, "identity": 2}
OUTCOMES = {"answer", "book", "move", "cancel", "prepare_book", "prepare_cancel", "prepare_move", "handoff", "opt_out", "none"}
FICTIONAL_PHONE = re.compile(r"^\+1555010\d{4}$")
FICTIONAL_DIGITS = re.compile(r"^(?:\d{3}55501\d{2}|555010\d{4})$")
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
# Obviously fictional first names only; anything else fails the set.
ALLOWED_NAMES = {
    "Alex", "Jordan", "Morgan", "Casey", "Taylor", "Riley", "Avery", "Quinn", "Skyler", "Reese", "Drew", "Parker",
    "Hayden", "Emerson", "Rowan", "Sage", "Finley", "Jamie", "Kendall", "Logan", "Charlie", "Blake", "Dakota", "Ellis",
}
ROOT = Path(__file__).resolve().parent.parent


def texts(record):
    yield record["inbound"]
    for t in record["history"]:
        yield t["text"]
    yield json.dumps(record["customer"])
    yield json.dumps(record["expect"])


def test_about_twenty_five_unique_records(golden):
    assert 20 <= len(golden) <= 40
    assert len({r["id"] for r in golden}) == len(golden)


def test_coverage(golden):
    counts = Counter(c for r in golden for c in r["category"])
    short = {c: counts.get(c, 0) for c, need in COVERAGE.items() if counts.get(c, 0) < need}
    assert not short, f"categories under target: {short}"


@pytest.mark.parametrize("field", ["id", "category", "synthetic", "now", "history", "inbound", "customer", "expect"])
def test_required_fields(golden, field):
    assert all(field in r for r in golden)


def test_shapes(golden, specs):
    for r in golden:
        assert r["synthetic"] is True, r["id"]
        assert set(r["category"]) <= CATEGORIES, r["id"]
        assert r["expect"].get("outcome") in OUTCOMES, r["id"]
        now = datetime.fromisoformat(r["now"])
        assert now.utcoffset() is not None, r["id"]
        for t in r["history"]:
            assert datetime.fromisoformat(t["at"]) < now, (r["id"], t["at"])
        for t in r["expect"].get("must_call", []) + r["expect"].get("must_not_call", []):
            assert t in specs["toolSchemas"], (r["id"], t)


def test_phones_are_fictional(golden):
    for r in golden:
        assert FICTIONAL_PHONE.match(r["customer"]["phone"]), r["id"]
        for text in texts(r):
            for m in re.finditer(r"(?<!\d)(?:\+?1[\s.-]?)?\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})(?!\d)", text):
                assert FICTIONAL_DIGITS.match("".join(m.groups())), (r["id"], m.group(0))


def test_emails_are_example_com(golden):
    for r in golden:
        for text in texts(r):
            for m in re.finditer(r"[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})", text):
                assert m.group(1).lower() == "example.com", (r["id"], m.group(0))


def test_names_are_from_the_fictional_list(golden):
    for r in golden:
        for person in r["customer"]["people"]:
            assert person["firstName"] in ALLOWED_NAMES, (r["id"], person["firstName"])
            assert set(person) <= {"firstName", "membership", "sessions"}, "no last names or other PII fields"


def test_ids_are_fresh_uuids(golden):
    for r in golden:
        for person in r["customer"]["people"]:
            for s in person.get("sessions", []):
                assert UUID.match(s["id"]), (r["id"], s["id"])


def test_prompt_injection_and_opt_out_cases_exist(golden):
    injections = [r for r in golden if "prompt_injection" in r["category"]]
    assert len(injections) >= 3
    assert all(r["expect"].get("forbidden") for r in injections), "each injection case must forbid the injected behavior"
    assert any(r["expect"]["outcome"] == "opt_out" for r in golden)
    assert any("opt_out" in r["category"] and r["expect"]["outcome"] != "opt_out" for r in golden), "need a near-miss that must NOT opt out"


def test_calibration_rows_reference_golden_records(golden):
    ids = {r["id"] for r in golden}
    rows = [json.loads(line) for line in (ROOT / "data" / "calibration.jsonl").read_text().splitlines() if line.strip()]
    assert rows
    for row in rows:
        assert row["record_id"] in ids
        assert row["labels"] and set(row["labels"].values()) <= {"pass", "fail", "n/a"}
