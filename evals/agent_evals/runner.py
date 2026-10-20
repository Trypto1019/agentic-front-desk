"""Runner contract: hand golden records to the agent, get one result per record.

The runner shells out to `evals/runner/run-turns.ts`, which drives THIS
repo's real inbound pipeline (deterministic routers, agent loop, guards)
against a fresh in-memory store per record with the clock pinned to the
record's `now`. The default model is the offline mock; set
AGENT_EVAL_MODEL=openrouter (and OPENROUTER_API_KEY) to run a real model.

Result shape (one JSON object per line):
  id, ok, error, route, finalText, replies[{body, success}],
  toolCalls[{tool, args, outcome, status, result}],
  effects{suppressed, staffTasks[], pendingIntentsCreated[], receipts[]},
  llm{calls, costUsd}, guards[], turn[{route, error, model, promptVersion}]
"""

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
RUN_TURNS = REPO / "evals" / "runner" / "run-turns.ts"


class Inconclusive(Exception):
    """The run could not measure the agent (toolchain, provider, environment)."""


def tsx_command():
    local = REPO / "node_modules" / ".bin" / "tsx"
    if local.exists():
        return [str(local)]
    if shutil.which("npx"):
        return ["npx", "--no-install", "tsx"]
    raise Inconclusive("tsx not found: run `npm install` first")


def run_turns(records, timeout=600):
    with tempfile.TemporaryDirectory(prefix="agent-evals-") as tmp:
        src, out = Path(tmp) / "records.jsonl", Path(tmp) / "results.jsonl"
        src.write_text("".join(json.dumps(r) + "\n" for r in records))
        done = subprocess.run([*tsx_command(), str(RUN_TURNS), str(src), str(out)], cwd=REPO, capture_output=True, text=True, timeout=timeout, env=os.environ.copy())
        if done.returncode != 0:
            raise Inconclusive(f"runner exited {done.returncode}: {done.stderr.strip()[-400:]}")
        results = {}
        for line in out.read_text().splitlines():
            if line.strip():
                r = json.loads(line)
                results[r["id"]] = r
        return results
