import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from backend.api.v1.reports import (
    CreateReportRequest,
    create_report,
    get_report,
    list_reports,
)
from backend.core.config import Settings
from backend.services.report import (
    GENERATION_ERROR,
    MAX_CHUNK_BYTES,
    MAX_CHUNK_CHARS,
    MAX_RESPONSE_CHARS,
    ReportGenerationError,
    ReportService,
    _OutputLimitExceeded,
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

    with patch.object(report_svc, "_call_agy", new_callable=AsyncMock) as mock_generate:
        mock_generate.return_value = "## Executive Summary\nAlice discussed secret project."

        report = await report_svc.generate_report([sid], "en")
        assert report["report_id"] is not None
        assert report["language"] == "en"
        assert "model" not in report
        assert len(report["session_previews"]) == 1
        assert report["content"] == "## Executive Summary\nAlice discussed **** project."
        assert "Discussion about **** project" in mock_generate.call_args[0][0]

        # Verify saved report
        report_path = report_svc._dir / f"{report['report_id']}.json"
        saved = json.loads(report_path.read_text(encoding="utf-8"))
        assert saved["content"] == report["content"]
        assert "model" not in saved

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

    with patch.object(report_svc, "_call_agy", new_callable=AsyncMock) as mock_generate:
        mock_generate.return_value = "## סיכום כללי\nבוב דיבר על סוד מעל 100 שורות"

        report = await report_svc.generate_report([sid], "he")
        assert report["language"] == "he"
        assert report["content"] == "## סיכום כללי\nבוב דיבר על **** מעל 100 שורות"
        assert mock_generate.call_count >= 2


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
    active_path = session_svc._dir / active_id / "transcript.jsonl"
    with active_path.open("a", encoding="utf-8") as file:
        file.write(json.dumps({"type": "partial", "text": "Transient partial"}) + "\n")

    with patch.object(
        report_svc,
        "_call_agy",
        new_callable=AsyncMock,
        return_value="Combined report",
    ) as mock_generate:
        report = await report_svc.generate_report([first_id, active_id], "en")

    generation_input = "\n".join(call.args[0] for call in mock_generate.call_args_list)
    assert "Past finalized line" in generation_input
    assert "Active finalized line" in generation_input
    assert "2026-01-01T10:00:00+00:00" in generation_input
    assert "2026-01-01T11:00:00+00:00" in generation_input
    assert "Alice" in generation_input
    assert "Bob" in generation_input
    assert "Transient partial" not in generation_input
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
    _, _, _, report_svc = test_services
    text = "".join(
        f"source-marker-{index}\n{'x' * MAX_CHUNK_CHARS}\n"
        for index in range(8)
    )
    map_inputs: list[str] = []
    reduce_inputs: list[str] = []

    async def summarize(content: str, language: str) -> str:
        assert language == "en"
        if content.startswith("Source transcript section"):
            map_inputs.append(content)
            return "s" * 1500
        reduce_inputs.append(content)
        return "r" * 1500

    with patch.object(report_svc, "_call_agy", side_effect=summarize):
        result = await report_svc._generate_summary(text, "en")

    mapped_source = "".join(item.split("\n\n", 1)[1] for item in map_inputs)
    assert mapped_source == text
    assert any(item.startswith("Aggregation level 2") for item in reduce_inputs)
    assert result == "r" * 1500


@pytest.mark.asyncio
@pytest.mark.parametrize("language", ["en", "he"])
async def test_agy_request_uses_safe_direct_subprocess(test_services, language):
    _, _, _, report_svc = test_services
    process = MagicMock(returncode=0)
    captured: dict = {}

    async def start_process(*args, **kwargs):
        captured.update(args=args, kwargs=kwargs)
        assert kwargs["cwd"] != str(report_svc._dir.parent)
        return process

    content = "source marker; touch should-not-exist && /read/workspace"
    with (
        patch(
            "backend.services.report.asyncio.create_subprocess_exec",
            side_effect=start_process,
        ),
        patch.object(
            report_svc,
            "_collect_process_output",
            new_callable=AsyncMock,
            return_value=(b"Bounded response", b""),
        ),
    ):
        response = await report_svc._call_agy(content, language)

    assert response == "Bounded response"
    assert captured["args"][:6] == (
        "agy",
        "--sandbox",
        "--disable-slash-commands",
        "--output-format",
        "text",
        "--prompt",
    )
    assert "--model" not in captured["args"]
    assert content in captured["args"][6]
    assert "untrusted data" in captured["args"][6]
    assert captured["kwargs"]["stdin"] == -3
    assert captured["kwargs"]["start_new_session"] is True


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("process_returncode", "output", "error"),
    [
        (1, b"", b"authentication failed for account details"),
        (0, b"", b""),
        (0, b"invalid\x00output", b""),
        (0, b"\xff", b""),
        (0, b"x" * (MAX_RESPONSE_CHARS + 1), b""),
    ],
)
async def test_agy_failures_are_generic(
    test_services,
    process_returncode,
    output,
    error,
):
    _, _, _, report_svc = test_services
    process = MagicMock(returncode=process_returncode)

    with (
        patch(
            "backend.services.report.asyncio.create_subprocess_exec",
            new_callable=AsyncMock,
            return_value=process,
        ),
        patch.object(
            report_svc,
            "_collect_process_output",
            new_callable=AsyncMock,
            return_value=(output, error),
        ),
        pytest.raises(ReportGenerationError, match=f"^{GENERATION_ERROR}$"),
    ):
        await report_svc._call_agy("source", "en")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failure",
    [FileNotFoundError("private executable path"), TimeoutError(), _OutputLimitExceeded()],
)
async def test_agy_boundary_failures_are_generic(test_services, failure):
    _, _, _, report_svc = test_services

    if isinstance(failure, FileNotFoundError):
        process_patch = patch(
            "backend.services.report.asyncio.create_subprocess_exec",
            new_callable=AsyncMock,
            side_effect=failure,
        )
        collect_patch = patch.object(report_svc, "_collect_process_output")
    else:
        process_patch = patch(
            "backend.services.report.asyncio.create_subprocess_exec",
            new_callable=AsyncMock,
            return_value=MagicMock(returncode=None),
        )
        collect_patch = patch.object(
            report_svc,
            "_collect_process_output",
            new_callable=AsyncMock,
            side_effect=failure,
        )

    with (
        process_patch,
        collect_patch,
        pytest.raises(ReportGenerationError, match=f"^{GENERATION_ERROR}$"),
    ):
        await report_svc._call_agy("source", "en")


@pytest.mark.asyncio
async def test_generation_failure_does_not_persist_or_change_transcript(test_services):
    _, session_svc, _, report_svc = test_services
    meta = session_svc.start_session("g1", "G", "c1", "C")
    sid = meta["session_id"]
    session_svc.append_utterance("u1", "p1", "Speaker", None, "Test message")

    before = session_svc.get_full_session(sid)
    with (
        patch.object(
            report_svc,
            "_call_agy",
            new_callable=AsyncMock,
            side_effect=ReportGenerationError(GENERATION_ERROR),
        ),
        pytest.raises(ReportGenerationError, match=f"^{GENERATION_ERROR}$"),
    ):
        await report_svc.generate_report([sid], "en")

    assert report_svc.list_reports() == []
    assert session_svc.get_full_session(sid) == before


def test_legacy_report_model_is_hidden_without_rewriting_file(test_services):
    _, _, _, report_svc = test_services
    report_path = report_svc._dir / "legacy.json"
    legacy = {
        "report_id": "legacy",
        "created_at": "2026-01-01T00:00:00+00:00",
        "language": "en",
        "model": "legacy-private-model",
        "content": "Legacy content",
    }
    report_path.write_text(json.dumps(legacy), encoding="utf-8")

    assert "model" not in report_svc.get_report("legacy")
    assert "model" not in report_svc.list_reports()[0]
    assert json.loads(report_path.read_text(encoding="utf-8")) == legacy


@pytest.mark.asyncio
async def test_reports_api_router(test_services):
    _, session_svc, _, report_svc = test_services
    meta = session_svc.start_session("g1", "G", "c1", "C")
    sid = meta["session_id"]
    session_svc.append_utterance("u1", "p1", "Speaker", None, "Test message")

    request = MagicMock()
    request.app.state.report_service = report_svc

    with patch.object(report_svc, "_call_agy", return_value="Summary content"):
        payload = CreateReportRequest(session_ids=[sid], language="en")
        rep = await create_report(payload, request)
        assert rep["content"] == "Summary content"

        report_list = await list_reports(request)
        assert len(report_list["reports"]) == 1

        single = await get_report(rep["report_id"], request)
        assert single["report_id"] == rep["report_id"]


@pytest.mark.asyncio
async def test_reports_api_hides_generation_details(test_services):
    _, session_svc, _, report_svc = test_services
    meta = session_svc.start_session("g1", "G", "c1", "C")
    sid = meta["session_id"]
    session_svc.append_utterance("u1", "p1", "Speaker", None, "Test message")
    request = MagicMock()
    request.app.state.report_service = report_svc

    with (
        patch.object(
            report_svc,
            "_call_agy",
            new_callable=AsyncMock,
            side_effect=ReportGenerationError("private authentication details"),
        ),
        pytest.raises(HTTPException) as caught,
    ):
        await create_report(CreateReportRequest(session_ids=[sid]), request)

    assert caught.value.status_code == 503
    assert caught.value.detail == GENERATION_ERROR
