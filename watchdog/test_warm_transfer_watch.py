import json
import time

import pytest

from warm_transfer_watch import (
    AudioLevels,
    Watch,
    evaluate_outcome,
    mulaw_dbfs,
    silence_frame,
    simulate,
    token,
    tone_frame,
    trip,
    validate_token,
    warm_transfer_enabled,
)


def test_levels_distinguish_tone_from_silence():
    assert mulaw_dbfs(silence_frame()) < -50
    assert mulaw_dbfs(tone_frame()) > -30
    assert mulaw_dbfs(b"") == -120.0


def test_caller_speech_does_not_hide_dead_air_before_bridge():
    levels = AudioLevels()
    levels.feed("outbound", 0, tone_frame())
    result = None
    for t in range(20, 10_100, 20):
        levels.feed("inbound", t, tone_frame())
        result = levels.feed("outbound", t, silence_frame())
    assert result["fired"] and result["reason"] == "dead_air"


def test_after_bridge_either_party_counts():
    levels = AudioLevels()
    result = None
    for t in range(0, 12_000, 20):
        levels.feed("inbound", t, tone_frame(), bridged=True)
        result = levels.feed("outbound", t, silence_frame(), bridged=True)
    assert not result["fired"]


def test_out_of_order_frames_are_ignored():
    levels = AudioLevels()
    levels.feed("outbound", 1000, tone_frame())
    assert levels.feed("outbound", 500, silence_frame())["reason"] == "out_of_order_frame"


def test_trip_is_an_exclusive_latch(tmp_path):
    first = trip("dead_air_over_10_seconds", "call-a", {"silenceMs": 10_020}, tmp_path)
    second = trip("dead_air_over_10_seconds", "call-b", {"silenceMs": 99_999}, tmp_path)
    assert second["callId"] == "call-a" == first["callId"]
    assert not warm_transfer_enabled(tmp_path)
    assert json.loads((tmp_path / "feature_flags.json").read_text())["warm_transfer_enabled"] is False


def test_stream_ticket_binding():
    now = time.time()
    ticket = token("s3cret-for-test", "call-1", int(now) + 60)
    assert validate_token("s3cret-for-test", ticket, now) == "call-1"
    assert validate_token("other", ticket, now) is None
    assert validate_token("s3cret-for-test", ticket.replace("call-1", "call-2"), now) is None
    assert validate_token("s3cret-for-test", token("s3cret-for-test", "call-1", int(now) + 7200), now) is None
    assert validate_token("s3cret-for-test", "garbage", now) is None


def test_media_requires_authenticated_start(tmp_path):
    watch = Watch(tmp_path, "k")
    with pytest.raises(PermissionError):
        watch.media("outbound", 0, tone_frame())
    with pytest.raises(PermissionError):
        watch.start("call-1.0.deadbeef", time.time())


def test_evidence_holds_levels_not_audio(tmp_path):
    simulate("dead-air", tmp_path)
    rows = [json.loads(line) for line in (tmp_path / "calls" / "sim-call-0001.levels.jsonl").read_text().splitlines()]
    assert rows and all(set(r) <= {"at", "fired", "reason", "track", "dbfs", "silenceMs", "mediaTimestampMs", "thresholdDbfs"} for r in rows)


def test_simulations(tmp_path):
    dead = simulate("dead-air", tmp_path / "dead")
    healthy = simulate("healthy", tmp_path / "ok")
    assert dead["tripped"] and not dead["warmTransferEnabled"]
    assert not healthy["tripped"] and healthy["warmTransferEnabled"]


def test_outcome_controls():
    assert evaluate_outcome({"status": "ringing"}, False, ["Connecting you now"], 40)[0]["fired"]
    assert not evaluate_outcome({"status": "transferred"}, False, ["Connecting you now"], 40)[0]["fired"]
    assert evaluate_outcome({"status": "error"}, False, [], 40)[1]["fired"]
    assert not evaluate_outcome({"status": "error"}, True, [], 40)[1]["fired"]
