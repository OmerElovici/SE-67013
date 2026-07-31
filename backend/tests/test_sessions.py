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


@pytest.mark.asyncio
async def test_session_api_routes(tmp_path):
    session_svc = SessionService(storage_dir=tmp_path)
    vocab_svc = VocabularyService(storage_path=tmp_path / "vocab.txt")

    meta = session_svc.start_session("1", "G", "2", "C")
    session_svc.append_utterance("u1", "s1", "Dave", None, "Hello")

    request = MagicMock()
    request.app.state.session_service = session_svc
    request.app.state.vocabulary_service = vocab_svc

    res = await list_sessions(request)
    assert res["active_session"]["session_id"] == meta["session_id"]

    detail = await get_session_detail(meta["session_id"], request)
    assert detail["session"]["session_id"] == meta["session_id"]
    assert len(detail["transcripts"]) == 1
