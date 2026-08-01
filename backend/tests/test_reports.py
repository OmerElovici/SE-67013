import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from backend.api.v1.reports import (
    CreateReportRequest,
    create_report,
    get_report,
    list_reports,
)
from backend.core.config import Settings
from backend.services.report import (
    MAX_CHUNK_BYTES,
    MAX_CHUNK_CHARS,
    ReportService,
)
from backend.services.session import SessionService
from backend.services.vocabulary import VocabularyService


@pytest.fixture
def test_services(tmp_path):
    vocab = VocabularyService(storage_path=tmp_path / "vocab.txt")
    vocab.set_raw_text("secret")
    session_svc = SessionService(storage_dir=tmp_path / "sessions")
    settings = Settings()
    report_svc = ReportService(
        session_service=session_svc,
        vocabulary_service=vocab,
        settings=settings,
        storage_dir=tmp_path / "reports",
    )
    return vocab, session_svc, settings, report_svc


@pytest.mark.asyncio
async def test_report_validation(test_services):
    _, _, _, report_svc = test_services
    with pytest.raises(ValueError, match="At least one session"):
        await report_svc.generate_report([], "en")

    with pytest.raises(ValueError, match="Language must be"):
        await report_svc.generate_report(["s1"], "fr")

@pytest.mark.asyncio
async def test_report_generation_and_persistence(test_services):
    vocab, session_svc, settings, report_svc = test_services

    # Create session with transcript
    meta = session_svc.start_session("g1", "Guild 1", "c1", "Channel 1")
    sid = meta["session_id"]
    session_svc.append_utterance("u1", "p1", "Alice", None, "Discussion about secret project")
    session_svc.end_session()

    # Mock Ollama call
    with patch.object(report_svc, "_call_ollama", new_callable=AsyncMock) as mock_ollama:
        mock_ollama.return_value = "## Executive Summary\nAlice discussed secret project."

        report = await report_svc.generate_report([sid], "en")
        assert report["report_id"] is not None
        assert report["language"] == "en"
        assert report["model"] == settings.OLLAMA_MODEL
        assert len(report["session_previews"]) == 1
        assert report["content"] == "## Executive Summary\nAlice discussed **** project."
        assert "Discussion about **** project" in mock_ollama.call_args[0][0]

        # Verify saved report
        report_path = report_svc._dir / f"{report['report_id']}.json"
        saved = json.loads(report_path.read_text(encoding="utf-8"))
        assert saved["content"] == report["content"]

        retrieved = report_svc.get_report(report["report_id"])
        assert retrieved is not None
        assert retrieved["content"] == report["content"]

        all_reports = report_svc.list_reports()
        assert len(all_reports) == 1
        assert all_reports[0]["report_id"] == report["report_id"]

        vocab.set_raw_text("secret\nproject")
        assert report_svc.get_report(report["report_id"])["content"] == (
            "## Executive Summary\nAlice discussed **** ****."
        )
        assert report_svc.list_reports()[0]["content"] == (
            "## Executive Summary\nAlice discussed **** ****."
        )
        assert json.loads(report_path.read_text(encoding="utf-8")) == saved

        restarted = ReportService(
            session_service=session_svc,
            vocabulary_service=vocab,
            settings=settings,
            storage_dir=report_svc._dir,
        )
        assert restarted.get_report(report["report_id"])["content"] == (
            "## Executive Summary\nAlice discussed **** ****."
        )


@pytest.mark.asyncio
async def test_report_hebrew_and_oversized_input(test_services):
    vocab, session_svc, _, report_svc = test_services
    vocab.set_raw_text("סוד")

    meta = session_svc.start_session("g1", "Guild", "c1", "Channel")
    sid = meta["session_id"]
    # Append many utterances to trigger oversized input chunking
    for idx in range(100):
        session_svc.append_utterance(f"u{idx}", "p1", "Bob", None, f"Utterance content line number {idx} text")
    session_svc.end_session()

    with patch.object(report_svc, "_call_ollama", new_callable=AsyncMock) as mock_ollama:
        mock_ollama.return_value = "## סיכום כללי\nבוב דיבר על סוד מעל 100 שורות"

        report = await report_svc.generate_report([sid], "he")
        assert report["language"] == "he"
        assert report["content"] == "## סיכום כללי\nבוב דיבר על **** מעל 100 שורות"
        assert mock_ollama.call_count >= 2  # Sub-chunk calls + final synthesis call


@pytest.mark.asyncio
async def test_multiple_sessions_and_active_finalized_snapshot(test_services):
    _, session_svc, _, report_svc = test_services

    first = session_svc.start_session("g1", "Guild 1", "c1", "Past")
    first_id = first["session_id"]
    session_svc.append_utterance(
        "u1",
        "p1",
        "Alice",
        None,
        "Past finalized line",
        timestamp="2026-01-01T10:00:00+00:00",
    )
    session_svc.end_session()

    active = session_svc.start_session("g2", "Guild 2", "c2", "Active")
    active_id = active["session_id"]
    session_svc.append_utterance(
        "u2",
        "p2",
        "Bob",
        None,
        "Active finalized line",
        timestamp="2026-01-01T11:00:00+00:00",
    )
    active_path = session_svc._dir / f"{active_id}.jsonl"
    with active_path.open("a", encoding="utf-8") as file:
        file.write(json.dumps({"type": "partial", "text": "Transient partial"}) + "\n")

    with patch.object(
        report_svc,
        "_call_ollama",
        new_callable=AsyncMock,
        return_value="Combined report",
    ) as mock_ollama:
        report = await report_svc.generate_report([first_id, active_id], "en")

    model_input = "\n".join(call.args[0] for call in mock_ollama.call_args_list)
    assert "Past finalized line" in model_input
    assert "Active finalized line" in model_input
    assert "2026-01-01T10:00:00+00:00" in model_input
    assert "2026-01-01T11:00:00+00:00" in model_input
    assert "Alice" in model_input
    assert "Bob" in model_input
    assert "Transient partial" not in model_input
    assert report["session_ids"] == [first_id, active_id]
    assert [item["channel_name"] for item in report["session_previews"]] == [
        "Past",
        "Active",
    ]


def test_chunking_splits_long_lines_without_omission(test_services):
    _, _, _, report_svc = test_services
    text = f"prefix\n{'א' * (MAX_CHUNK_CHARS * 3)}\nsuffix"

    chunks = report_svc._split_into_chunks(
        text,
        MAX_CHUNK_CHARS,
        MAX_CHUNK_BYTES,
    )

    assert len(chunks) > 2
    assert "".join(chunks) == text
    assert all(len(chunk) <= MAX_CHUNK_CHARS for chunk in chunks)
    assert all(len(chunk.encode("utf-8")) <= MAX_CHUNK_BYTES for chunk in chunks)


@pytest.mark.asyncio
async def test_multi_level_aggregation_is_bounded_and_covers_source(test_services):
    _, _, settings, report_svc = test_services
    text = "".join(
        f"source-marker-{index}\n{'x' * MAX_CHUNK_CHARS}\n"
        for index in range(8)
    )
    map_inputs: list[str] = []
    reduce_inputs: list[str] = []

    async def summarize(content: str, language: str) -> str:
        assert language == "en"
        assert len(content.encode("utf-8")) < settings.OLLAMA_MAX_PROMPT_BYTES
        if content.startswith("Source transcript section"):
            map_inputs.append(content)
            return "s" * 1500
        reduce_inputs.append(content)
        return "r" * 1500

    with patch.object(report_svc, "_call_ollama", side_effect=summarize):
        result = await report_svc._generate_llm_summary(text, "en")

    mapped_source = "".join(item.split("\n\n", 1)[1] for item in map_inputs)
    assert mapped_source == text
    assert any(item.startswith("Aggregation level 2") for item in reduce_inputs)
    assert result == "r" * 1500


@pytest.mark.asyncio
@pytest.mark.parametrize("language", ["en", "he"])
async def test_ollama_request_uses_explicit_context_bounds(test_services, language):
    _, _, settings, report_svc = test_services
    captured: dict = {}

    class FakeResponse:
        status = 200

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, traceback):
            return None

        async def json(self):
            return {"response": "Bounded response"}

    class FakeSession:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, traceback):
            return None

        def post(self, url, json, timeout):
            captured.update(url=url, payload=json, timeout=timeout)
            return FakeResponse()

    with patch("backend.services.report.aiohttp.ClientSession", return_value=FakeSession()):
        response = await report_svc._call_ollama("source marker", language)

    assert response == "Bounded response"
    assert captured["payload"]["options"] == {
        "num_ctx": settings.OLLAMA_CONTEXT_TOKENS,
        "num_predict": settings.OLLAMA_MAX_OUTPUT_TOKENS,
    }
    prompt = captured["payload"]["prompt"]
    assert "source marker" in prompt
    assert len(prompt.encode("utf-8")) <= settings.OLLAMA_MAX_PROMPT_BYTES
    assert (
        len(prompt.encode("utf-8")) + settings.OLLAMA_MAX_OUTPUT_TOKENS
        <= settings.OLLAMA_CONTEXT_TOKENS
    )


@pytest.mark.asyncio
async def test_ollama_rejects_request_over_safe_budget(test_services):
    _, _, settings, report_svc = test_services
    oversized = "x" * (settings.OLLAMA_MAX_PROMPT_BYTES + 1)

    with pytest.raises(RuntimeError, match="safe request budget"):
        await report_svc._call_ollama(oversized, "en")


@pytest.mark.asyncio
async def test_ollama_unreachable_isolation(test_services):
    _, session_svc, _, report_svc = test_services
    meta = session_svc.start_session("g1", "G", "c1", "C")
    sid = meta["session_id"]
    session_svc.append_utterance("u1", "p1", "Speaker", None, "Test message")

    with (
        patch("aiohttp.ClientSession.post", side_effect=Exception("Connection refused")),
        pytest.raises(RuntimeError, match="Report generation failed"),
    ):
        await report_svc.generate_report([sid], "en")

    assert report_svc.list_reports() == []
    assert session_svc.get_full_session(sid) is not None


@pytest.mark.asyncio
async def test_reports_api_router(test_services):
    _, session_svc, _, report_svc = test_services
    meta = session_svc.start_session("g1", "G", "c1", "C")
    sid = meta["session_id"]
    session_svc.append_utterance("u1", "p1", "Speaker", None, "Test message")

    request = MagicMock()
    request.app.state.report_service = report_svc

    with patch.object(report_svc, "_call_ollama", return_value="Summary content"):
        payload = CreateReportRequest(session_ids=[sid], language="en")
        rep = await create_report(payload, request)
        assert rep["content"] == "Summary content"

        report_list = await list_reports(request)
        assert len(report_list["reports"]) == 1

        single = await get_report(rep["report_id"], request)
        assert single["report_id"] == rep["report_id"]
