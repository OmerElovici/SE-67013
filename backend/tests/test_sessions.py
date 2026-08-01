import json
from unittest.mock import MagicMock

import pytest

from backend.api.v1.sessions import get_session_detail, list_sessions
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

    past_path = tmp_path / f"{past_meta['session_id']}.jsonl"
    active_path = tmp_path / f"{active_meta['session_id']}.jsonl"
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
    assert not (tmp_path / f"{session_id}.jsonl").exists()
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
