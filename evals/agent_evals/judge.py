"""LLM judge for rules f (policy), g (groundedness) and h (helpfulness).

Pass/fail per rule, never a 1-10 score. The judge is a different model and
provider route from the agent under test. The rubric is judge_prompt.md.
Verdicts are cached on disk by a hash of (record, reply, what the turn did,
rubric, judge model), so an unchanged reply is never re-judged.

The judge is optional: offline runs (no ANTHROPIC_API_KEY) score the
deterministic checks only.
"""

import hashlib
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RUBRIC_PATH = ROOT / "judge_prompt.md"
CACHE_DIR = Path(os.environ.get("AGENT_EVAL_CACHE", ROOT / ".cache" / "judge"))
JUDGE_MODEL = os.environ.get("AGENT_EVAL_JUDGE_MODEL", "claude-opus-5-5")

POLICY_RULES = ["no_health_claims", "no_offers_to_active_members", "no_invented_policy", "no_pressure", "honest_about_ai", "respects_stop"]
JUDGED_RULES = [f"f_{r}" for r in POLICY_RULES] + ["g_groundedness", "h_helpfulness"]

VERDICT = {"type": "string", "enum": ["pass", "fail", "n/a"]}
_RULE = {"type": "object", "properties": {"verdict": VERDICT, "reason": {"type": "string"}}, "required": ["verdict", "reason"], "additionalProperties": False}
SCHEMA = {
    "type": "object",
    "properties": {
        "policy": {"type": "object", "properties": {r: _RULE for r in POLICY_RULES}, "required": POLICY_RULES, "additionalProperties": False},
        "groundedness": {
            "type": "object",
            "properties": {"unsupported_claims": {"type": "array", "items": {"type": "string"}}, "verdict": VERDICT, "reason": {"type": "string"}},
            "required": ["unsupported_claims", "verdict", "reason"],
            "additionalProperties": False,
        },
        "helpfulness": _RULE,
    },
    "required": ["policy", "groundedness", "helpfulness"],
    "additionalProperties": False,
}


def judge_available():
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


def account_summary(record):
    people = record["customer"]["people"]
    return {
        "phoneSharedBy": len(people),
        "people": [
            {"firstName": p["firstName"], "membership": p.get("membership"), "sessions": p.get("sessions", [])} if len(people) == 1 else {"firstName": p["firstName"]}
            for p in people
        ],
        "unsubscribedBefore": record["customer"].get("suppressed", False),
        "pendingConfirmations": record["customer"].get("pendingIntents", []),
    }


def judge_input(record, result, specs):
    effects = result.get("effects", {})
    return {
        "conversation": {"now": record["now"], "history": record["history"][-12:], "inbound": record["inbound"]},
        "account": account_summary(record),
        "tool_results": [{"tool": c["tool"], "args": c["args"], "outcome": c.get("outcome"), "result": c.get("result")} for c in result.get("toolCalls", [])],
        "server_actions": {
            "staff_tasks_created": [t["title"] for t in effects.get("staffTasks", [])],
            "number_unsubscribed": bool(effects.get("suppressed")),
            "pending_confirmations_created": effects.get("pendingIntentsCreated", []),
            "actions_executed": effects.get("receipts", []),
        },
        "studio_facts": specs["faqFacts"],
        "intended_behavior": record["expect"].get("notes", ""),
        "reply": result.get("finalText") or "",
    }


def cache_key(payload, rubric_text, model=JUDGE_MODEL):
    blob = json.dumps({"input": payload, "rubric": rubric_text, "model": model}, sort_keys=True)
    return hashlib.sha256(blob.encode()).hexdigest()


def flatten(verdict):
    out = {f"f_{r}": verdict["policy"][r]["verdict"] for r in POLICY_RULES}
    out["g_groundedness"] = verdict["groundedness"]["verdict"]
    out["h_helpfulness"] = verdict["helpfulness"]["verdict"]
    return out


class Judge:
    def __init__(self, client=None, cache_dir=CACHE_DIR):
        if client is None:
            import anthropic  # imported lazily: offline runs never need the SDK

            client = anthropic.Anthropic()
        self.client = client
        self.rubric = RUBRIC_PATH.read_text()
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.calls = 0
        self.cache_hits = 0

    def grade(self, record, result, specs):
        payload = judge_input(record, result, specs)
        path = self.cache_dir / f"{cache_key(payload, self.rubric)}.json"
        if path.exists():
            self.cache_hits += 1
            return json.loads(path.read_text())["verdict"]
        response = self.client.beta.messages.create(
            model=JUDGE_MODEL,
            max_tokens=4000,
            # A safety decline re-runs server-side on the default fallback model.
            betas=["server-side-fallback-2026-07-01"],
            extra_body={"fallbacks": "default"},
            output_config={"effort": "medium", "format": {"type": "json_schema", "schema": SCHEMA}},
            system=[{"type": "text", "text": self.rubric, "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": json.dumps(payload, ensure_ascii=False)}],
        )
        if response.stop_reason == "refusal":
            raise RuntimeError(f"judge refused for {record['id']}")
        verdict = json.loads(next(b.text for b in response.content if b.type == "text"))
        self.calls += 1
        path.write_text(json.dumps({"verdict": verdict, "model": response.model, "recordId": record["id"]}))
        return verdict
