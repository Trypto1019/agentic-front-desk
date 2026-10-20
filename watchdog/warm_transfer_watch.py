#!/usr/bin/env python3
"""Warm-transfer dead-air watchdog (generic, simulated).

During a warm transfer the caller waits on hold while staff are rung. The
failure that matters is silence: a caller sitting in dead air thinks the
line dropped. This watchdog subscribes to a media stream of the call (both
tracks, 8 kHz mu-law), measures audio LEVELS only (no audio is recorded or
stored), and if the caller hears more than SILENCE_MS of silence it trips a
latch that disables warm transfer for every later call until a human
re-enables it. The active call is never ended to disable the feature.

Design rules carried over from production:
  * Levels, not recordings. Only dBFS numbers are written to evidence.
  * Before the bridge, only the OUTBOUND track (what the caller hears)
    counts: the caller talking cannot hide dead air. After the bridge,
    either party speaking is a live conversation.
  * The trip is an exclusive-create latch file: the first trip wins, a
    second trip cannot overwrite the evidence of the first.
  * The monitor failing is not a call failure. A broken stream is reported
    separately and does not trip the latch.
  * Stream tickets are short-lived HMAC tokens bound to one call id.

Run a simulation:
    python3 watchdog/warm_transfer_watch.py --simulate dead-air
    python3 watchdog/warm_transfer_watch.py --simulate healthy
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import hmac
import json
import math
import os
import re
import tempfile
from pathlib import Path

SILENCE_MS = 10_000
AUDIBLE_DBFS = -50.0
FRAME_MS = 20
SAMPLE_RATE = 8000
TICKET_MAX_TTL_S = 1800


def iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


# --------------------------------------------------------------------------- audio


def mulaw_decode(byte: int) -> int:
    u = ~byte & 0xFF
    sample = (((u & 0x0F) << 3) + 0x84) << ((u & 0x70) >> 4)
    sample -= 0x84
    return -sample if u & 0x80 else sample


def mulaw_encode(sample: int) -> int:
    """16-bit linear PCM to mu-law (G.711), used only to synthesize test audio."""
    bias, clip = 0x84, 32635
    sign = 0x80 if sample < 0 else 0
    sample = min(abs(sample), clip) + bias
    exponent = 7
    for exp in range(7, -1, -1):
        if sample & (0x4000 >> (7 - exp)):
            exponent = exp
            break
    mantissa = (sample >> (exponent + 3)) & 0x0F
    return ~(sign | (exponent << 4) | mantissa) & 0xFF


def mulaw_dbfs(data: bytes) -> float:
    """RMS level of a mu-law frame in dBFS. Empty frames read as -120 dBFS."""
    if not data:
        return -120.0
    energy = sum(mulaw_decode(b) ** 2 for b in data)
    return 20 * math.log10(max(math.sqrt(energy / len(data)), 0.0001) / 32768)


def tone_frame(frequency: float = 440.0, amplitude: float = 0.2, offset: int = 0) -> bytes:
    n = SAMPLE_RATE * FRAME_MS // 1000
    return bytes(mulaw_encode(int(amplitude * 32767 * math.sin(2 * math.pi * frequency * (offset + i) / SAMPLE_RATE))) for i in range(n))


def silence_frame() -> bytes:
    return bytes([0xFF]) * (SAMPLE_RATE * FRAME_MS // 1000)


class AudioLevels:
    """Tracks the last audible timestamp per track and decides dead air."""

    TRACKS = ("inbound", "outbound")

    def __init__(self) -> None:
        self.last_audible = {t: 0.0 for t in self.TRACKS}
        self.latest = {t: 0.0 for t in self.TRACKS}
        self.frames = {t: 0 for t in self.TRACKS}
        self.longest_silence_ms = 0.0

    def feed(self, track: str, timestamp_ms: float, data: bytes, bridged: bool = False) -> dict:
        if track not in self.latest:
            raise ValueError("unknown_audio_track")
        if timestamp_ms < self.latest[track]:
            return {"fired": False, "reason": "out_of_order_frame"}
        self.frames[track] += 1
        self.latest[track] = timestamp_ms
        level = mulaw_dbfs(data)
        if level > AUDIBLE_DBFS:
            self.last_audible[track] = timestamp_ms
        audible = max(self.last_audible.values()) if bridged else self.last_audible["outbound"]
        silence = max(0.0, timestamp_ms - audible)
        evaluated = track == "outbound" or bridged
        if evaluated:
            self.longest_silence_ms = max(self.longest_silence_ms, silence)
        fired = evaluated and silence > SILENCE_MS
        return {
            "fired": fired,
            "reason": "dead_air" if fired else "audio_present_or_below_bound",
            "track": track,
            "dbfs": round(level, 1),
            "silenceMs": silence,
            "mediaTimestampMs": timestamp_ms,
            "thresholdDbfs": AUDIBLE_DBFS,
        }


# --------------------------------------------------------------------------- latch


def trip(reason: str, call_id: str, evidence: dict, directory: Path) -> dict:
    """Disable warm transfer. Exclusive create: the first trip's evidence is kept."""
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    row = {"disabledAt": iso(), "reason": reason, "callId": call_id, "evidence": evidence, "callEnded": False}
    try:
        fd = os.open(directory / "disabled.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(row, f)
            f.flush()
            os.fsync(f.fileno())
    except FileExistsError:
        row = json.loads((directory / "disabled.json").read_text())
    # The running app reads this flag before offering a transfer.
    flags_path = directory / "feature_flags.json"
    flags = json.loads(flags_path.read_text()) if flags_path.exists() else {}
    flags["warm_transfer_enabled"] = False
    flags_path.write_text(json.dumps(flags))
    return row


def warm_transfer_enabled(directory: Path) -> bool:
    flags_path = directory / "feature_flags.json"
    if (directory / "disabled.json").exists():
        return False
    return json.loads(flags_path.read_text()).get("warm_transfer_enabled", True) if flags_path.exists() else True


# --------------------------------------------------------------------------- stream tickets


def token(secret: str, call_id: str, expiry: int) -> str:
    payload = f"{call_id}.{expiry}"
    return payload + "." + hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()


def validate_token(secret: str, value: str, at: float) -> str | None:
    try:
        call_id, expires, _signature = value.split(".")
        if not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", call_id) or not 0 <= int(expires) - at <= TICKET_MAX_TTL_S:
            return None
        return call_id if hmac.compare_digest(token(secret, call_id, int(expires)), value) else None
    except (ValueError, TypeError):
        return None


# --------------------------------------------------------------------------- outcome checks


def evaluate_outcome(attempt: dict, fallback_completed: bool, spoken: list[str], age_seconds: float) -> list[dict]:
    """Two script-level failures besides dead air:
    - false_connection: the agent said "connecting you" but no bridge happened;
    - error_without_fallback: the transfer errored and the caller never heard the fallback.
    """
    bridged = attempt.get("status") == "transferred"
    false_connection = any(re.search(r"\bconnecting you\b", text, re.I) for text in spoken) and not bridged and age_seconds > 30
    error = attempt.get("status") in ("error", "redirect_failed") or (not attempt and age_seconds > 35)
    missing_fallback = error and not fallback_completed and age_seconds > 35
    return [{"control": "false_connection", "fired": false_connection}, {"control": "error_without_fallback", "fired": missing_fallback}]


# --------------------------------------------------------------------------- simulation


class Watch:
    """Consumes media events for one call and trips the latch on dead air."""

    def __init__(self, directory: Path, secret: str) -> None:
        self.directory = directory
        self.secret = secret
        self.levels = AudioLevels()
        self.call_id: str | None = None
        self.bridged = False
        self.tripped = False

    def start(self, ticket: str, at: float) -> None:
        call_id = validate_token(self.secret, ticket, at)
        if not call_id:
            raise PermissionError("authenticated_start_required")
        self.call_id = call_id

    def media(self, track: str, timestamp_ms: float, payload: bytes) -> dict:
        if not self.call_id:
            raise PermissionError("media_before_authenticated_start")
        result = self.levels.feed(track, timestamp_ms, payload, self.bridged)
        evidence_dir = self.directory / "calls"
        evidence_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        with (evidence_dir / f"{self.call_id}.levels.jsonl").open("a") as f:
            f.write(json.dumps({"at": iso(), **result}) + "\n")  # levels only, never audio
        if result["fired"] and not self.tripped:
            self.tripped = True
            trip("dead_air_over_10_seconds", self.call_id, result, self.directory)
        return result


def simulate(scenario: str, directory: Path) -> dict:
    """Feed synthetic frames: hold music, then (for dead-air) silence on the caller's side."""
    secret = os.urandom(16).hex()
    watch = Watch(directory, secret)
    call_id = "sim-call-0001"
    now = dt.datetime.now(dt.timezone.utc).timestamp()
    watch.start(token(secret, call_id, int(now) + 600), now)
    t = 0.0
    seconds_of_hold = 5 if scenario == "dead-air" else 30
    for i in range(int(seconds_of_hold * 1000 / FRAME_MS)):
        watch.media("outbound", t, tone_frame(offset=i * 160))
        watch.media("inbound", t, silence_frame())
        t += FRAME_MS
    if scenario == "dead-air":
        for _ in range(int(12_000 / FRAME_MS)):
            watch.media("outbound", t, silence_frame())
            watch.media("inbound", t, tone_frame())  # the caller saying "hello?" does not hide dead air
            t += FRAME_MS
    return {
        "scenario": scenario,
        "tripped": watch.tripped,
        "warmTransferEnabled": warm_transfer_enabled(directory),
        "longestSilenceMs": watch.levels.longest_silence_ms,
        "frames": watch.levels.frames,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--simulate", choices=["dead-air", "healthy"], required=True)
    parser.add_argument("--dir", type=Path, default=None, help="state directory (default: a temp dir)")
    args = parser.parse_args()
    directory = args.dir or Path(tempfile.mkdtemp(prefix="warm-watch-"))
    print(json.dumps(simulate(args.simulate, directory), indent=2))


if __name__ == "__main__":
    main()
