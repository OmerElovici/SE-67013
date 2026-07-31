from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from backend.api.v1.reports import (
    CreateReportRequest,
    create_report,
    get_report,
    list_reports,
)
from backend.core.config import Settings
from backend.services.report import ReportService
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
    _vocab, session_svc, settings, report_svc = test_services

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
        assert "Discussion about **** project" in mock_ollama.call_args[0][0]

        # Verify saved report
        retrieved = report_svc.get_report(report["report_id"])
        assert retrieved is not None
        assert retrieved["content"] == report["content"]

        all_reports = report_svc.list_reports()
        assert len(all_reports) == 1
        assert all_reports[0]["report_id"] == report["report_id"]


@pytest.mark.asyncio
async def test_report_hebrew_and_oversized_input(test_services):
    _, session_svc, _, report_svc = test_services

    meta = session_svc.start_session("g1", "Guild", "c1", "Channel")
    sid = meta["session_id"]
    # Append many utterances to trigger oversized input chunking
    for idx in range(100):
        session_svc.append_utterance(f"u{idx}", "p1", "Bob", None, f"Utterance content line number {idx} text")
    session_svc.end_session()

    with patch.object(report_svc, "_call_ollama", new_callable=AsyncMock) as mock_ollama:
        mock_ollama.return_value = "## סיכום כללי\nבוב דיבר מעל 100 שורות"

        report = await report_svc.generate_report([sid], "he")
        assert report["language"] == "he"
        assert mock_ollama.call_count >= 2  # Sub-chunk calls + final synthesis call


@pytest.mark.asyncio
async def test_ollama_unreachable_isolation(test_services):
    _, session_svc, _, report_svc = test_services
    meta = session_svc.start_session("g1", "G", "c1", "C")
    sid = meta["session_id"]

    with (
        patch("aiohttp.ClientSession.post", side_effect=Exception("Connection refused")),
        pytest.raises(RuntimeError, match="Report generation failed"),
    ):
        await report_svc.generate_report([sid], "en")


@pytest.mark.asyncio
async def test_reports_api_router(test_services):
    _, session_svc, _, report_svc = test_services
    meta = session_svc.start_session("g1", "G", "c1", "C")
    sid = meta["session_id"]

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
