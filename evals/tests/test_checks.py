import copy

from agent_evals import checks
from agent_evals.schema import validate


def record(**overrides):
    base = {
        "id": "t001",
        "category": ["booking"],
        "now": "2026-03-10T10:00:00-07:00",
        "history": [],
        "inbound": "anything Thursday?",
        "customer": {"phone": "+15550100999", "people": [{"firstName": "Alex", "sessions": [{"date": "2026-03-12", "startTime": "15:00", "room": "standard", "status": "booked"}]}]},
        "expect": {"outcome": "answer", "must_call": [], "must_not_call": [], "required_facts": [], "forbidden": []},
    }
    base.update(overrides)
    return base


def result(text="On Thursday I have 10:00 AM open.", calls=None, **effects):
    return {
        "ok": True,
        "finalText": text,
        "replies": [{"body": text, "success": True}] if text else [],
        "toolCalls": calls if calls is not None else [{"tool": "check_availability", "args": {"date": "2026-03-12"}, "outcome": "executed", "status": "ok", "result": {"openTimes": ["10:00"]}}],
        "effects": {"suppressed": False, "staffTasks": [], "pendingIntentsCreated": [], "receipts": [], **effects},
        "llm": {"calls": 2},
        "turn": [{"error": None}],
    }


def test_clean_turn_passes_everything(specs):
    out = checks.run_checks(record(), result(), specs)
    assert all(not v for v in out.values()), out


def test_schema_validator():
    schema = {"type": "object", "properties": {"date": {"type": "string", "pattern": r"^\d{4}-\d{2}-\d{2}$"}, "room": {"type": "string", "enum": ["a"], "default": "a"}}, "required": ["date", "room"], "additionalProperties": False}
    assert validate({"date": "2026-03-12"}, schema) == []
    assert validate({"date": "thursday"}, schema)
    assert validate({"date": "2026-03-12", "extra": 1}, schema)
    assert validate({}, schema)


def test_invalid_tool_args_fail(specs):
    calls = [{"tool": "check_availability", "args": {"date": "Thursday"}, "outcome": "rejected", "status": None, "result": None}]
    assert checks.check_tool_schema(record(), result(calls=calls), specs)


def test_unbacked_time_fails_numbers(specs):
    assert checks.check_numbers(record(), result("I have 4:00 PM open Thursday."), specs)
    assert not checks.check_numbers(record(), result("Your session is Thursday at 3:00 PM."), specs)


def test_booking_claim_without_receipt_fails(specs):
    assert checks.check_claims(record(), result("You're booked for Thursday at 10:00 AM!"), specs)
    assert not checks.check_claims(record(), result("You're booked for Thursday at 10:00 AM!", receipts=["booked"]), specs)


def test_handoff_claim_needs_a_staff_task(specs):
    assert checks.check_claims(record(), result("I've passed this to the team."), specs)
    assert not checks.check_claims(record(), result("I've passed this to the team.", staffTasks=[{"title": "pricing"}]), specs)


def test_opt_out_rules(specs):
    rec = record(category=["opt_out"], expect={**record()["expect"], "outcome": "opt_out"})
    ok = result(specs["optOutAck"], calls=[], suppressed=True)
    ok["llm"] = {"calls": 0}
    assert checks.check_opt_out(rec, ok, specs) == []
    chatty = copy.deepcopy(ok)
    chatty["replies"].append({"body": "Before you go, 20% off!", "success": True})
    assert checks.check_opt_out(rec, chatty, specs)
    near_miss = record(category=["opt_out"])
    assert checks.check_opt_out(near_miss, result(suppressed=True), specs) == ["suppressed a message that was not a revocation"]


def test_outcome_answer_rejects_actions(specs):
    assert checks.check_outcome(record(), result(pendingIntentsCreated=["BOOK_SESSION"]), specs)
    rec = record(expect={**record()["expect"], "outcome": "prepare_book"})
    assert checks.check_outcome(rec, result(pendingIntentsCreated=["BOOK_SESSION"]), specs) == []


def test_hygiene(specs):
    assert checks.check_hygiene(record(), result("Hi {{first_name}}, **booked** on 2026-03-12 via check_availability"), specs)


def test_expect_text(specs):
    rec = record(expect={**record()["expect"], "required_facts": ["Thursday|Thu"], "forbidden": [r"\$\d"]})
    assert checks.check_expect_text(rec, result("Thu works. $40."), specs) == ['forbidden "\\$\\d"']
