"""Deterministic checks (hard failures, zero tolerance).

Each check takes a golden record, the runner's result for it and the exported
specs, and returns a list of failure strings (empty = pass) or None when the
check does not apply to the record.

  a  tool_schema    every model tool call validates against its JSON schema
     must_call      must_call / must_not_call honored
     outcome        the turn ended in the expected outcome
  b  claims         "booked / cancelled / moved / all set / passed to the team"
                    only with a matching server receipt or action this turn
  c  numbers        every clock time in the reply is backed by a tool result,
                    the account, the customer's own words or approved facts
  d  opt_out        an opt-out gets the suppression and only the opt-out ack;
                    the model never runs; a non-revocation is never suppressed
  e  hygiene        no placeholders, markdown, internal names or raw ISO dates
     expect_text    the record's required_facts present, forbidden absent
     agent_error    the turn finished without the error fallback
"""

import re

from .schema import validate

ACTION_OUTCOMES = {"book", "move", "cancel", "handoff", "opt_out", "prepare_book", "prepare_cancel", "prepare_move"}
PREPARED = {"BOOK_SESSION": "prepare_book", "CANCEL_SESSION": "prepare_cancel", "RESCHEDULE_SESSION": "prepare_move"}
RECEIPT_OUTCOME = {"booked": "book", "cancelled": "cancel", "rescheduled": "move"}

INTERNAL_NAMES = [
    "check_availability", "my_sessions", "request_booking", "request_cancel", "request_reschedule",
    "request_staff_followup", "membership_change", "pendingIntentId", "customerId", "session_id",
    "openTimes", "needs_disambiguation", "needs_identity", "slot_unavailable", "SINGLE_RESOLVED",
    "MULTI_MATCH", "NO_MATCH", "registryStatus",
]
MARKDOWN = re.compile(r"(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|^#{1,6}\s|\[[^\]]+\]\([^)]+\)|^\s*[-*]\s+\S)", re.M)
PLACEHOLDER = re.compile(r"\{\{?\s*[A-Za-z_][A-Za-z0-9_.]*\s*\}?\}|\[(?:name|first ?name|link|url|date|time)\]", re.I)
ISO_DATE = re.compile(r"\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?\b")
CLOCK = re.compile(r"\b(\d{1,2}):(\d{2})\s*([AaPp])\.?[Mm]\.?")
BARE_AT = re.compile(r"\bat (\d{1,2})(?::(\d{2}))?\b(?!\s*[AaPp]\.?[Mm])")

CLAIMS = {
    "book": re.compile(r"\b(you'?re (?:all )?booked|i(?:'ve| have) booked|booked you|got you (?:booked|in|down)|is (?:now )?booked)\b", re.I),
    "cancel": re.compile(r"\b(i(?:'ve| have) cancell?ed|(?:has been|is (?:now )?|was )cancell?ed)\b", re.I),
    "move": re.compile(r"\b(i(?:'ve| have) (?:moved|rescheduled)|(?:has been|is now|was|is) (?:moved|rescheduled))\b", re.I),
    "all_set": re.compile(r"\b(you'?re all set|you'?re good to go)\b", re.I),
    "handoff": re.compile(r"\b(i(?:'ve| have) (?:passed|flagged|notified|asked the team|let the team know)|the team (?:has been|was) (?:notified|alerted))", re.I),
}


def achieved_outcomes(record, result):
    got = set()
    effects = result.get("effects", {})
    if effects.get("suppressed"):
        got.add("opt_out")
    for action in effects.get("receipts", []):
        got.add(RECEIPT_OUTCOME.get(action, action))
    for intent in effects.get("pendingIntentsCreated", []):
        got.add(PREPARED.get(intent, intent))
    if effects.get("staffTasks"):
        got.add("handoff")
    if result.get("finalText") and not effects.get("suppressed"):
        got.add("answer")
    return got


def model_calls(result):
    return result.get("toolCalls", [])


def check_tool_schema(record, result, specs):
    failures = []
    for c in model_calls(result):
        schema = specs["toolSchemas"].get(c["tool"])
        if schema is None:
            failures.append(f"unknown tool {c['tool']}")
            continue
        if c.get("outcome") == "rejected":
            failures.append(f"{c['tool']} rejected as invalid: {c['args']}")
            continue
        errors = validate(c["args"] if isinstance(c["args"], dict) else {}, schema)
        if errors:
            failures.append(f"{c['tool']} args invalid: {errors[0]}")
    return failures


def check_must_call(record, result, specs):
    exp = record["expect"]
    called = {c["tool"] for c in model_calls(result) if c.get("outcome") != "rejected"}
    failures = [f"did not call {t}" for t in exp.get("must_call", []) if t not in called]
    failures += [f"called {t}" for t in exp.get("must_not_call", []) if t in called]
    return failures


def check_outcome(record, result, specs):
    want = record["expect"].get("outcome")
    if not want:
        return None
    got = achieved_outcomes(record, result)
    if want == "none":
        ok = not result.get("finalText") and not (got & ACTION_OUTCOMES)
    elif want == "answer":
        ok = "answer" in got and not (got & ACTION_OUTCOMES)
    else:
        ok = want in got
    return [] if ok else [f"expected {want}, got {sorted(got) or ['nothing']}"]


def _clock(h, m, mer):
    h = int(h) % 12 + (12 if mer.lower() == "p" else 0)
    return f"{h:02d}:{int(m):02d}"


def evidence_times(record, result, specs):
    times = set()
    blob = " ".join([str(r.get("result")) for r in model_calls(result)] + [str(record["customer"]), " ".join(specs["faqFacts"].values())])
    times.update(re.findall(r"\b(\d{2}:\d{2})\b", blob))
    for m in CLOCK.finditer(blob):
        times.add(_clock(*m.groups()))
    said = " ".join([record["inbound"]] + [t["text"] for t in record["history"] if t["role"] == "user"])
    for m in CLOCK.finditer(said):
        times.add(_clock(*m.groups()))
    for m in re.finditer(r"\b(\d{1,2})(?::(\d{2}))?\s*([ap])m\b|\bat (\d{1,2})\b", said, re.I):
        if m.group(4):
            h = int(m.group(4))
            times.update({f"{h % 12:02d}:00", f"{h % 12 + 12:02d}:00"})
        else:
            times.add(_clock(m.group(1), m.group(2) or 0, m.group(3)))
    return times


def check_numbers(record, result, specs):
    text = result.get("finalText") or ""
    if not text:
        return []
    backed = evidence_times(record, result, specs)
    return [f"time: \"{m.group(0)}\"" for m in CLOCK.finditer(text) if _clock(*m.groups()) not in backed]


def check_claims(record, result, specs):
    text = result.get("finalText") or ""
    if not text:
        return []
    got = achieved_outcomes(record, result)
    sessions = {s["startTime"] for p in record["customer"]["people"] for s in p.get("sessions", []) if s.get("status") == "booked"}
    mentions_existing = any(_clock(*m.groups()) in sessions for m in CLOCK.finditer(text))
    failures = []
    for kind in ("book", "cancel", "move", "handoff"):
        m = CLAIMS[kind].search(text)
        if m and kind not in got and not (kind == "book" and mentions_existing):
            failures.append(f"claims {kind} with no server action: \"{m.group(0)}\"")
    m = CLAIMS["all_set"].search(text)
    if m and not (got & {"book", "cancel", "move"} or mentions_existing):
        failures.append(f"\"{m.group(0)}\" with no completed action or existing booking")
    return failures


def check_opt_out(record, result, specs):
    exp = record["expect"].get("outcome")
    if exp != "opt_out" and "opt_out" not in record["category"]:
        return None
    effects = result.get("effects", {})
    failures = []
    if exp == "opt_out":
        if not effects.get("suppressed"):
            failures.append("number was not suppressed")
        others = [r["body"] for r in result.get("replies", []) if r.get("success") and r["body"] != specs["optOutAck"]]
        if others:
            failures.append(f"sent more than the opt-out acknowledgment: \"{others[0][:120]}\"")
        if (result.get("llm") or {}).get("calls"):
            failures.append("the model ran on an opt-out")
        if model_calls(result):
            failures.append("tools ran on an opt-out")
    elif effects.get("suppressed"):
        failures.append("suppressed a message that was not a revocation")
    return failures


def check_hygiene(record, result, specs):
    text = result.get("finalText") or ""
    if not text:
        return []
    failures = []
    if PLACEHOLDER.search(text):
        failures.append(f"unfilled placeholder {PLACEHOLDER.search(text).group(0)}")
    m = MARKDOWN.search(text)
    if m:
        failures.append(f"markdown \"{m.group(0).strip()}\"")
    for name in INTERNAL_NAMES:
        if re.search(rf"\b{re.escape(name)}\b", text):
            failures.append(f"internal name {name}")
    m = ISO_DATE.search(text)
    if m:
        failures.append(f"raw ISO date {m.group(0)}")
    return failures


def check_expect_text(record, result, specs):
    text = result.get("finalText") or ""
    lower = text.lower()
    exp = record["expect"]
    failures = []
    for fact in exp.get("required_facts", []):
        options = [o.strip().lower() for o in fact.split("|") if o.strip()]
        if not any(o in lower for o in options):
            failures.append(f"missing \"{fact}\"")
    for pattern in exp.get("forbidden", []):
        if re.search(pattern, text, re.I):
            failures.append(f"forbidden \"{pattern}\"")
    return failures


def check_agent_error(record, result, specs):
    failures = []
    if not result.get("ok"):
        failures.append(f"runner: {result.get('error')}")
    for turn in result.get("turn", []):
        if turn.get("error"):
            failures.append(f"turn error: {str(turn['error'])[:160]}")
    return failures


CHECKS = {
    "a_tool_schema": check_tool_schema,
    "a_must_call": check_must_call,
    "a_outcome": check_outcome,
    "b_claims": check_claims,
    "c_numbers": check_numbers,
    "d_opt_out": check_opt_out,
    "e_hygiene": check_hygiene,
    "expect_text": check_expect_text,
    "agent_error": check_agent_error,
}


def run_checks(record, result, specs):
    return {name: fn(record, result, specs) for name, fn in CHECKS.items()}
