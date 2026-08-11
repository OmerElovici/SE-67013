import json
import wave
from unittest.mock import MagicMock

import numpy as np
import pytest
from fastapi import WebSocketDisconnect

from backend.api.v1.sessions import (
    _AUDIO_MAX_UNCONFIRMED,
    get_session_audio,
    get_session_detail,
    list_sessions,
    stream_session_audio,
)
from backend.services.session import SessionService
from backend.services.vocabulary import VocabularyService


def test_session_lifecycle_and_persistence(tmp_path):
    service = SessionService(storage_dir=tmp_path)
    vocab = VocabularyService(storage_path=tmp_path / "vocab.txt")
    vocab.set_raw_text("secret")

    # Start session
    meta = service.start_session("123", "Test Guild", "456", "General")
    session_id = meta["session_id"]
    assert service.active_session_id == session_id
    assert (tmp_path / session_id / "transcript.jsonl").is_file()
    assert not (tmp_path / f"{session_id}.jsonl").exists()

    # Append utterances
    service.append_utterance("utt-1", "user-1", "Alice", None, "Hello world")
    service.append_utterance("utt-2", "user-2", "Bob", None, "This is a secret term")

    # Check active session list
    active = service.get_active_session()
    assert active["session_id"] == session_id
    assert active["status"] == "active"

    # End session
    ended = service.end_session()
    assert ended["status"] == "closed"
    assert service.active_session_id is None

    # Retrieve session details with redaction
    details = service.get_full_session(session_id, vocabulary_service=vocab)
    assert details is not None
    assert details["session"]["status"] == "closed"
    assert len(details["transcripts"]) == 2
    assert details["transcripts"][1]["text"] == "This is a **** term"


def test_current_vocabulary_is_applied_when_reading_sessions(tmp_path):
    service = SessionService(storage_dir=tmp_path)
    vocab = VocabularyService(storage_path=tmp_path / "vocab.txt")

    past_meta = service.start_session("111", "Guild 1", "222", "Voice 1")
    service.append_utterance("u1", "p1", "Speaker", None, "Past secret message")
    service.end_session()

    active_meta = service.start_session("333", "Guild 2", "444", "Voice 2")
    service.append_utterance("u2", "p2", "Speaker", None, "Active secret message")

    past_path = tmp_path / past_meta["session_id"] / "transcript.jsonl"
    active_path = tmp_path / active_meta["session_id"] / "transcript.jsonl"
    persisted_records = {
        past_path: past_path.read_text(encoding="utf-8"),
        active_path: active_path.read_text(encoding="utf-8"),
    }

    vocab.set_raw_text("secret")

    active = service.get_active_session(vocab)
    sessions = service.list_sessions(vocab)
    details = {
        item["session_id"]: service.get_full_session(item["session_id"], vocab)
        for item in sessions
    }

    assert active["preview_text"] == "Active **** message"
    assert {
        item["session_id"]: item["preview_text"] for item in sessions
    } == {
        active_meta["session_id"]: "Active **** message",
        past_meta["session_id"]: "Past **** message",
    }
    assert details[active_meta["session_id"]]["transcripts"][0]["text"] == (
        "Active **** message"
    )
    assert details[past_meta["session_id"]]["transcripts"][0]["text"] == (
        "Past **** message"
    )
    assert {
        path: path.read_text(encoding="utf-8") for path in persisted_records
    } == persisted_records


def test_interrupted_session_recovery(tmp_path):
    service1 = SessionService(storage_dir=tmp_path)
    meta = service1.start_session("111", "Guild 1", "222", "Voice 1")
    session_id = meta["session_id"]
    service1.append_utterance("u1", "p1", "Speaker", None, "Test msg")

    # Simulate backend crash/restart (service2 instantiated without calling end_session on service1)
    service2 = SessionService(storage_dir=tmp_path)
    assert service2.active_session_id is None

    sessions = service2.list_sessions()
    assert len(sessions) == 1
    assert sessions[0]["session_id"] == session_id
    assert sessions[0]["status"] == "interrupted"

    full = service2.get_full_session(session_id)
    assert full["session"]["status"] == "interrupted"


def test_empty_session_is_discarded(tmp_path):
    service = SessionService(storage_dir=tmp_path)
    meta = service.start_session("111", "Guild 1", "222", "Voice 1")
    session_id = meta["session_id"]

    assert service.get_active_session() is None
    assert service.list_sessions() == []
    assert service.get_full_session(session_id) is None

    service.end_session()

    assert service.active_session_id is None
    assert not (tmp_path / session_id).exists()
    assert service.list_sessions() == []


def test_start_only_interrupted_session_is_removed_during_recovery(tmp_path):
    session_id = "interrupted-empty"
    path = tmp_path / f"{session_id}.jsonl"
    path.write_text(
        json.dumps(
            {
                "type": "start",
                "session_id": session_id,
                "started_at": "2026-01-01T00:00:00+00:00",
                "status": "active",
            }
        )
        + "\n",
        encoding="utf-8",
    )

    service = SessionService(storage_dir=tmp_path)

    assert not path.exists()
    assert not (tmp_path / session_id).exists()
    assert service.list_sessions() == []


def test_flat_session_is_migrated_without_changing_content(tmp_path):
    session_id = "legacy-session"
    legacy_path = tmp_path / f"{session_id}.jsonl"
    content = "\n".join(
        json.dumps(record)
        for record in (
            {
                "type": "start",
                "session_id": session_id,
                "started_at": "2026-01-01T00:00:00+00:00",
                "status": "active",
            },
            {
                "type": "utterance",
                "utterance_id": "u1",
                "speaker_id": "p1",
                "speaker_name": "Speaker",
                "avatar_url": None,
                "text": "Legacy secret message",
                "timestamp": "2026-01-01T00:00:01+00:00",
            },
        )
    ) + "\n"
    legacy_path.write_text(content, encoding="utf-8")

    service = SessionService(storage_dir=tmp_path)
    migrated_path = tmp_path / session_id / "transcript.jsonl"

    assert not legacy_path.exists()
    assert migrated_path.read_text(encoding="utf-8") == content
    assert service.list_sessions()[0]["session_id"] == session_id
    assert service.get_full_session(session_id)["transcripts"][0]["text"] == (
        "Legacy secret message"
    )

    restarted = SessionService(storage_dir=tmp_path)
    assert migrated_path.read_text(encoding="utf-8") == content
    assert restarted.list_sessions()[0]["status"] == "interrupted"


def test_flat_session_remains_readable_when_migration_destination_conflicts(
    tmp_path,
):
    session_id = "legacy-session"
    legacy_path = tmp_path / f"{session_id}.jsonl"
    legacy_content = "\n".join(
        json.dumps(record)
        for record in (
            {
                "type": "start",
                "session_id": session_id,
                "started_at": "2026-01-01T00:00:00+00:00",
                "status": "active",
            },
            {
                "type": "utterance",
                "text": "Original transcript",
            },
        )
    ) + "\n"
    legacy_path.write_text(legacy_content, encoding="utf-8")
    session_dir = tmp_path / session_id
    session_dir.mkdir()
    destination = session_dir / "transcript.jsonl"
    destination.write_text("conflicting content\n", encoding="utf-8")

    service = SessionService(storage_dir=tmp_path)

    assert legacy_path.read_text(encoding="utf-8") == legacy_content
    assert destination.read_text(encoding="utf-8") == "conflicting content\n"
    assert service.list_sessions()[0]["preview_text"] == "Original transcript"
    assert service.get_full_session(session_id)["transcripts"][0]["text"] == (
        "Original transcript"
    )


def test_failed_migration_does_not_discard_start_only_legacy_session(tmp_path):
    session_id = "legacy-empty"
    legacy_path = tmp_path / f"{session_id}.jsonl"
    legacy_content = json.dumps(
        {
            "type": "start",
            "session_id": session_id,
            "started_at": "2026-01-01T00:00:00+00:00",
            "status": "active",
        }
    ) + "\n"
    legacy_path.write_text(legacy_content, encoding="utf-8")
    session_dir = tmp_path / session_id
    session_dir.mkdir()
    (session_dir / "transcript.jsonl").write_text(
        "conflicting content\n",
        encoding="utf-8",
    )

    service = SessionService(storage_dir=tmp_path)

    assert legacy_path.read_text(encoding="utf-8") == legacy_content
    assert service.list_sessions() == []


@pytest.mark.asyncio
async def test_session_api_routes(tmp_path):
    session_svc = SessionService(storage_dir=tmp_path)
    vocab_svc = VocabularyService(storage_path=tmp_path / "vocab.txt")

    past_meta = session_svc.start_session("1", "G", "2", "C")
    session_svc.append_utterance("u1", "s1", "Dave", None, "Past secret text")
    session_svc.end_session()

    active_meta = session_svc.start_session("1", "G", "2", "C")
    session_svc.append_utterance("u2", "s1", "Dave", None, "Active secret text")

    request = MagicMock()
    request.app.state.session_service = session_svc
    request.app.state.vocabulary_service = vocab_svc

    vocab_svc.set_raw_text("secret")

    res = await list_sessions(request)
    assert res["active_session"]["session_id"] == active_meta["session_id"]
    assert res["active_session"]["preview_text"] == "Active **** text"
    assert [item["session_id"] for item in res["past_sessions"]] == [
        past_meta["session_id"]
    ]
    assert res["past_sessions"][0]["preview_text"] == "Past **** text"
    assert {
        item["session_id"]: item["preview_text"] for item in res["all_sessions"]
    } == {
        active_meta["session_id"]: "Active **** text",
        past_meta["session_id"]: "Past **** text",
    }
    assert "secret" not in json.dumps(res).lower()

    for meta in (active_meta, past_meta):
        detail = await get_session_detail(meta["session_id"], request)
        assert detail["session"]["session_id"] == meta["session_id"]
        assert len(detail["transcripts"]) == 1
        assert "secret" not in json.dumps(detail).lower()


def test_recording_mixes_overlap_and_preserves_shared_timeline(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setattr("backend.services.session.time.monotonic", lambda: 100.0)
    service = SessionService(storage_dir=tmp_path)
    meta = service.start_session("1", "Guild", "2", "Channel")
    first = np.full((480, 2), 1000, dtype="<i2").tobytes()
    second = np.full((480, 2), 2000, dtype="<i2").tobytes()
    later = np.full((480, 2), 4000, dtype="<i2").tobytes()

    assert service.capture_audio(
        "first",
        first,
        captured_at=101.0,
        rtp_timestamp=10_000,
        rtp_sequence=100,
    ) == (
        1.0,
        1.01,
    )
    service.capture_audio(
        "second",
        second,
        captured_at=101.0,
        rtp_timestamp=900_000,
        rtp_sequence=50_000,
    )
    service.capture_audio(
        "first",
        later,
        captured_at=101.03,
        rtp_timestamp=11_440,
        rtp_sequence=101,
    )
    service.append_utterance(
        "u1",
        "first",
        "Ada",
        None,
        "Shared timeline",
        start_seconds=1.0,
        end_seconds=1.04,
    )

    recording_path = tmp_path / meta["session_id"] / "recording.wav"
    with wave.open(str(recording_path), "rb") as recording:
        samples = np.frombuffer(recording.readframes(recording.getnframes()), "<i2")
        samples = samples.reshape(-1, 2)

    assert np.all(samples[:48000] == 0)
    assert np.all(samples[48000:48480] == 3000)
    assert np.all(samples[48480:49440] == 0)
    assert np.all(samples[49440:49920] == 4000)
    detail = service.get_full_session(meta["session_id"])
    assert detail["recording"] == {
        "available": True,
        "duration_seconds": 1.04,
        "mime_type": "audio/wav",
    }


def test_recording_uses_rtp_cadence_for_jittered_and_bursty_callbacks(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setattr("backend.services.session.time.monotonic", lambda: 100.0)
    service = SessionService(storage_dir=tmp_path)
    meta = service.start_session("1", "Guild", "2", "Channel")
    frames = [
        np.full((960, 2), value, dtype="<i2").tobytes()
        for value in (1000, 2000, 3000)
    ]

    timings = [
        service.capture_audio(
            "speaker",
            pcm,
            captured_at=captured_at,
            rtp_timestamp=timestamp,
            rtp_sequence=sequence,
        )
        for pcm, captured_at, timestamp, sequence in zip(
            frames,
            (101.0, 101.045, 101.046),
            (2**32 - 960, 0, 960),
            (65_534, 65_535, 0),
            strict=True,
        )
    ]

    assert timings == [(1.0, 1.02), (1.02, 1.04), (1.04, 1.06)]
    recording_path = tmp_path / meta["session_id"] / "recording.wav"
    with wave.open(str(recording_path), "rb") as recording:
        samples = np.frombuffer(recording.readframes(recording.getnframes()), "<i2")
        samples = samples.reshape(-1, 2)

    assert np.all(samples[48000:48960] == 1000)
    assert np.all(samples[48960:49920] == 2000)
    assert np.all(samples[49920:50880] == 3000)


def test_recording_preserves_concealment_and_true_rtp_discontinuities(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setattr("backend.services.session.time.monotonic", lambda: 100.0)
    service = SessionService(storage_dir=tmp_path)
    meta = service.start_session("1", "Guild", "2", "Channel")
    first = np.full((960, 2), 1000, dtype="<i2").tobytes()
    concurrent = np.full((960, 2), 2000, dtype="<i2").tobytes()
    concealment = bytes(960 * 2 * 2)
    recovered = np.full((960, 2), 4000, dtype="<i2").tobytes()
    resumed = np.full((960, 2), 5000, dtype="<i2").tobytes()

    service.capture_audio(
        "first",
        first,
        captured_at=101.0,
        rtp_timestamp=10_000,
        rtp_sequence=100,
    )
    service.capture_audio(
        "second",
        concurrent,
        captured_at=101.0,
        rtp_timestamp=900_000,
        rtp_sequence=50_000,
    )
    service.capture_audio(
        "first",
        concealment,
        captured_at=101.04,
        rtp_timestamp=10_960,
        rtp_sequence=101,
    )
    service.capture_audio(
        "first",
        recovered,
        captured_at=101.041,
        rtp_timestamp=11_920,
        rtp_sequence=102,
    )
    assert service.capture_audio(
        "first",
        resumed,
        captured_at=101.1,
        rtp_timestamp=14_800,
        rtp_sequence=103,
    ) == (1.1, 1.12)

    recording_path = tmp_path / meta["session_id"] / "recording.wav"
    with wave.open(str(recording_path), "rb") as recording:
        samples = np.frombuffer(recording.readframes(recording.getnframes()), "<i2")
        samples = samples.reshape(-1, 2)

    assert np.all(samples[48000:48960] == 3000)
    assert np.all(samples[48960:49920] == 0)
    assert np.all(samples[49920:50880] == 4000)
    assert np.all(samples[50880:52800] == 0)
    assert np.all(samples[52800:53760] == 5000)


@pytest.mark.asyncio
async def test_rtp_anomalies_preserve_recording_and_resume_valid_cadence(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setattr("backend.services.session.time.monotonic", lambda: 100.0)
    service = SessionService(storage_dir=tmp_path)
    meta = service.start_session("1", "Guild", "2", "Channel")
    pcm = np.full((960, 2), 1000, dtype="<i2").tobytes()
    packets = (
        (101.0, 10_000, 100),
        (101.02, "invalid", 101),
        (101.04, 11_920, 102),
        (101.041, 11_920, 102),
        (100.5, 10_960, 101),
        (101.1, 9_000_000, 500),
        (101.12, None, None),
        (101.14, 9_001_920, 502),
    )

    timings = [
        service.capture_audio(
            "speaker",
            pcm,
            captured_at=captured_at,
            rtp_timestamp=rtp_timestamp,
            rtp_sequence=rtp_sequence,
        )
        for captured_at, rtp_timestamp, rtp_sequence in packets
    ]
    service.append_utterance(
        "u1",
        "speaker",
        "Ada",
        None,
        "Transcription survives",
        start_seconds=timings[0][0],
        end_seconds=timings[-1][1],
    )

    detail = service.get_full_session(meta["session_id"])
    assert timings == [
        (1.0, 1.02),
        (1.02, 1.04),
        (1.04, 1.06),
        (1.06, 1.08),
        (1.08, 1.1),
        (1.1, 1.12),
        (1.12, 1.14),
        (1.14, 1.16),
    ]
    assert detail["transcripts"][0]["text"] == "Transcription survives"
    assert detail["recording"] == {
        "available": True,
        "duration_seconds": 1.16,
        "mime_type": "audio/wav",
    }
    request = MagicMock()
    request.app.state.session_service = service
    response = await get_session_audio(meta["session_id"], request)
    assert response.status_code == 200
    assert response.media_type == "audio/wav"


@pytest.mark.asyncio
async def test_active_closed_and_interrupted_recordings_are_playable(tmp_path):
    service = SessionService(storage_dir=tmp_path)
    meta = service.start_session("1", "Guild", "2", "Channel")
    pcm = np.full((480, 2), 1000, dtype="<i2").tobytes()
    timing = service.capture_audio("speaker", pcm)
    service.append_utterance(
        "u1",
        "speaker",
        "Ada",
        None,
        "Recorded",
        start_seconds=timing[0],
        end_seconds=timing[1],
    )

    request = MagicMock()
    request.app.state.session_service = service
    request.app.state.vocabulary_service = VocabularyService(
        storage_path=tmp_path / "vocab.txt"
    )
    active = await get_session_detail(meta["session_id"], request)
    response = await get_session_audio(meta["session_id"], request)
    assert active["session"]["status"] == "active"
    assert active["recording"]["url"].endswith("/audio")
    assert active["recording"]["stream_url"].endswith("/audio/stream")
    assert response.media_type == "audio/wav"
    assert response.headers["accept-ranges"] == "bytes"
    assert response.headers["cache-control"] == "no-store"

    service.end_session()
    closed = await get_session_detail(meta["session_id"], request)
    assert closed["session"]["status"] == "closed"
    assert closed["recording"]["available"] is True

    recovered = SessionService(storage_dir=tmp_path)
    interrupted_meta = recovered.start_session("1", "Guild", "2", "Other")
    timing = recovered.capture_audio("speaker", pcm)
    recovered.append_utterance(
        "u2",
        "speaker",
        "Ada",
        None,
        "Interrupted",
        start_seconds=timing[0],
        end_seconds=timing[1],
    )
    after_restart = SessionService(storage_dir=tmp_path)
    interrupted = after_restart.get_full_session(interrupted_meta["session_id"])
    assert interrupted["session"]["status"] == "interrupted"
    assert interrupted["recording"]["available"] is True
    request.app.state.session_service = after_restart
    interrupted_response = await get_session_audio(
        interrupted_meta["session_id"],
        request,
    )
    assert interrupted_response.media_type == "audio/wav"
    assert interrupted_response.headers["accept-ranges"] == "bytes"


class _AudioStreamWebSocket:
    def __init__(self, service, messages, on_bytes=None):
        self.app = MagicMock()
        self.app.state.session_service = service
        self.messages = list(messages)
        self.on_bytes = on_bytes
        self.sent_json = []
        self.sent_bytes = []
        self.close_code = None
        self.accepted = False

    async def accept(self):
        self.accepted = True

    async def receive_json(self):
        if not self.messages:
            raise WebSocketDisconnect()
        message = self.messages.pop(0)
        if isinstance(message, BaseException):
            raise message
        return message

    async def send_json(self, message):
        self.sent_json.append(message)

    async def send_bytes(self, data):
        self.sent_bytes.append(data)
        if self.on_bytes:
            self.on_bytes()

    async def close(self, code=1000, reason=None):
        self.close_code = code


@pytest.mark.asyncio
async def test_active_audio_stream_resumes_from_confirmed_durable_offset(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setattr("backend.services.session.time.monotonic", lambda: 100.0)
    service = SessionService(storage_dir=tmp_path)
    meta = service.start_session("1", "Guild", "2", "Channel")
    first = np.full((480, 2), 1000, dtype="<i2").tobytes()
    second = np.full((480, 2), 2000, dtype="<i2").tobytes()
    first_timing = service.capture_audio("speaker", first, captured_at=100.0)
    service.append_utterance(
        "u1",
        "speaker",
        "Ada",
        None,
        "Streamed",
        start_seconds=first_timing[0],
        end_seconds=first_timing[1],
    )

    first_socket = _AudioStreamWebSocket(
        service,
        [
            {"type": "resume", "offset": 0, "revision": 0},
            {"type": "ack", "id": 1},
        ],
    )
    await stream_session_audio(meta["session_id"], first_socket)
    assert first_socket.accepted is True
    assert first_socket.sent_json == [
        {
            "type": "ready",
            "session_id": meta["session_id"],
            "offset": 0,
            "captured_bytes": len(first),
            "revision": 1,
            "reset": False,
            "sample_rate": 48000,
            "channels": 2,
            "sample_width": 2,
        },
        {
            "type": "chunk",
            "id": 1,
            "offset": 0,
            "size": len(first),
            "revision": 1,
        },
    ]
    assert first_socket.sent_bytes == [first]

    service.capture_audio("speaker", second, captured_at=100.01)

    resumed_socket = _AudioStreamWebSocket(
        service,
        [
            {"type": "resume", "offset": len(first), "revision": 1},
            {"type": "ack", "id": 1},
        ],
        on_bytes=service.end_session,
    )
    await stream_session_audio(meta["session_id"], resumed_socket)
    assert resumed_socket.sent_json[0]["type"] == "ready"
    assert resumed_socket.sent_json[0]["offset"] == len(first)
    assert resumed_socket.sent_json[0]["captured_bytes"] == len(first) + len(second)
    assert resumed_socket.sent_json[1:] == [
        {
            "type": "chunk",
            "id": 1,
            "offset": len(first),
            "size": len(second),
            "revision": 2,
        },
        {
            "type": "complete",
            "offset": len(first) + len(second),
            "url": f"/sessions/{meta['session_id']}/audio",
        },
    ]
    assert resumed_socket.sent_bytes == [second]
    assert resumed_socket.close_code == 1000
    assert meta["session_id"] not in service._recording_revisions
    assert meta["session_id"] not in service._recording_mutations
    assert meta["session_id"] not in service._recording_stream_subscribers
    request = MagicMock()
    request.app.state.session_service = service
    response = await get_session_audio(meta["session_id"], request)
    assert response.media_type == "audio/wav"
    assert response.headers["accept-ranges"] == "bytes"


@pytest.mark.asyncio
async def test_malformed_audio_stream_client_does_not_affect_recording(tmp_path):
    service = SessionService(storage_dir=tmp_path)
    meta = service.start_session("1", "Guild", "2", "Channel")
    pcm = np.full((480, 2), 1000, dtype="<i2").tobytes()

    socket = _AudioStreamWebSocket(
        service,
        [{"type": "resume", "offset": 1}],
    )
    await stream_session_audio(meta["session_id"], socket)
    assert socket.close_code == 1008

    non_object_socket = _AudioStreamWebSocket(service, ["invalid"])
    await stream_session_audio(meta["session_id"], non_object_socket)
    assert non_object_socket.close_code == 1008

    timing = service.capture_audio("speaker", pcm)
    service.append_utterance(
        "u1",
        "speaker",
        "Ada",
        None,
        "Still recording",
        start_seconds=timing[0],
        end_seconds=timing[1],
    )
    detail = service.get_full_session(meta["session_id"])
    assert detail["transcripts"][0]["text"] == "Still recording"
    assert detail["recording"]["available"] is True


@pytest.mark.asyncio
async def test_audio_stream_replaces_acknowledged_overlap_with_durable_mix(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setattr("backend.services.session.time.monotonic", lambda: 100.0)
    service = SessionService(storage_dir=tmp_path)
    meta = service.start_session("1", "Guild", "2", "Channel")
    first = np.full((480, 2), 1000, dtype="<i2").tobytes()
    overlapping = np.full((480, 2), 2000, dtype="<i2").tobytes()
    service.capture_audio("first", first, captured_at=100.0)
    mixed = False

    def mix_second_speaker():
        nonlocal mixed
        if mixed:
            return
        mixed = True
        service.capture_audio("second", overlapping, captured_at=100.0)

    socket = _AudioStreamWebSocket(
        service,
        [
            {"type": "resume", "offset": 0, "revision": 0},
            {"type": "ack", "id": 1},
            {"type": "ack", "id": 2},
        ],
        on_bytes=mix_second_speaker,
    )
    await stream_session_audio(meta["session_id"], socket)

    chunks = [message for message in socket.sent_json if message["type"] == "chunk"]
    assert [(chunk["id"], chunk["offset"], chunk["revision"]) for chunk in chunks] == [
        (1, 0, 1),
        (2, 0, 2),
    ]
    live_pcm = bytearray()
    for chunk, payload in zip(chunks, socket.sent_bytes, strict=True):
        end = chunk["offset"] + len(payload)
        if end > len(live_pcm):
            live_pcm.extend(bytes(end - len(live_pcm)))
        live_pcm[chunk["offset"] : end] = payload

    recording_path = service.get_recording_path(meta["session_id"])
    with wave.open(str(recording_path), "rb") as recording:
        durable_pcm = recording.readframes(recording.getnframes())
    assert bytes(live_pcm) == durable_pcm
    assert np.all(np.frombuffer(live_pcm, dtype="<i2") == 3000)


@pytest.mark.asyncio
async def test_audio_stream_reconnect_resets_prefix_changed_since_revision(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setattr("backend.services.session.time.monotonic", lambda: 100.0)
    service = SessionService(storage_dir=tmp_path)
    meta = service.start_session("1", "Guild", "2", "Channel")
    first = np.full((480, 2), 1000, dtype="<i2").tobytes()
    overlapping = np.full((480, 2), 2000, dtype="<i2").tobytes()
    service.capture_audio("first", first, captured_at=100.0)

    initial_socket = _AudioStreamWebSocket(
        service,
        [
            {"type": "resume", "offset": 0, "revision": 0},
            {"type": "ack", "id": 1},
        ],
    )
    await stream_session_audio(meta["session_id"], initial_socket)
    service.capture_audio("second", overlapping, captured_at=100.0)

    resumed_socket = _AudioStreamWebSocket(
        service,
        [
            {"type": "resume", "offset": len(first), "revision": 1},
            {"type": "ack", "id": 1},
        ],
    )
    await stream_session_audio(meta["session_id"], resumed_socket)

    ready, chunk = resumed_socket.sent_json[:2]
    assert ready["type"] == "ready"
    assert ready["reset"] is True
    assert ready["offset"] == 0
    assert ready["revision"] == 2
    assert chunk == {
        "type": "chunk",
        "id": 1,
        "offset": 0,
        "size": len(first),
        "revision": 2,
    }
    with wave.open(str(service.get_recording_path(meta["session_id"])), "rb") as recording:
        durable_pcm = recording.readframes(recording.getnframes())
    assert resumed_socket.sent_bytes == [durable_pcm]
    assert len(durable_pcm) == len(first)


@pytest.mark.asyncio
async def test_audio_stream_enforces_exact_unconfirmed_byte_cap(tmp_path, monkeypatch):
    monkeypatch.setattr("backend.services.session.time.monotonic", lambda: 100.0)
    service = SessionService(storage_dir=tmp_path)
    meta = service.start_session("1", "Guild", "2", "Channel")
    pcm = bytes(_AUDIO_MAX_UNCONFIRMED + 64 * 1024)
    service.capture_audio("speaker", pcm, captured_at=100.0)
    socket = _AudioStreamWebSocket(
        service,
        [
            {"type": "resume", "offset": 0, "revision": 0},
            *[TimeoutError() for _ in range(20)],
        ],
    )

    await stream_session_audio(meta["session_id"], socket)

    assert sum(map(len, socket.sent_bytes)) == _AUDIO_MAX_UNCONFIRMED
    assert all(len(chunk) <= 64 * 1024 for chunk in socket.sent_bytes)


def test_recording_write_failure_does_not_stop_transcript_persistence(
    tmp_path,
    monkeypatch,
):
    service = SessionService(storage_dir=tmp_path)
    meta = service.start_session("1", "Guild", "2", "Channel")
    monkeypatch.setattr(
        service,
        "_mix_recording_frame",
        MagicMock(side_effect=OSError("disk unavailable")),
    )
    pcm = np.full((480, 2), 1000, dtype="<i2").tobytes()

    timing = service.capture_audio("speaker", pcm)
    service.append_utterance(
        "u1",
        "speaker",
        "Ada",
        None,
        "Transcription survives",
        start_seconds=timing[0],
        end_seconds=timing[1],
    )

    detail = service.get_full_session(meta["session_id"])
    assert detail["transcripts"][0]["text"] == "Transcription survives"
    assert detail["recording"]["available"] is False


def test_corrupt_recording_is_reported_unavailable(tmp_path):
    service = SessionService(storage_dir=tmp_path)
    meta = service.start_session("1", "Guild", "2", "Channel")
    service.append_utterance("u1", "speaker", "Ada", None, "Transcript")
    recording_path = tmp_path / meta["session_id"] / "recording.wav"
    recording_path.write_bytes(b"not a wave file")

    detail = service.get_full_session(meta["session_id"])

    assert detail["transcripts"][0]["text"] == "Transcript"
    assert detail["recording"]["available"] is False
