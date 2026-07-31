import json
import logging
import os
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import aiohttp

from backend.core.config import Settings
from backend.services.session import SessionService
from backend.services.vocabulary import VocabularyService

logger = logging.getLogger(__name__)

MAX_CHUNK_CHARS = 3500


def _utc_now_iso() -> str:
    return datetime.now(UTC).isoformat()


class ReportService:
    """Generates and persists factual local reports via local Ollama LLM."""

    def __init__(
        self,
        session_service: SessionService,
        vocabulary_service: VocabularyService,
        settings: Settings,
        storage_dir: str | Path | None = None,
    ) -> None:
        self._session_svc = session_service
        self._vocab_svc = vocabulary_service
        self._settings = settings

        if storage_dir is None:
            storage_dir = Path(os.getenv("DATA_DIR", "data")) / "reports"
        self._dir = Path(storage_dir)
        self._dir.mkdir(parents=True, exist_ok=True)

    async def generate_report(self, session_ids: list[str], language: str = "en") -> dict:
        if not session_ids:
            raise ValueError("At least one session must be selected")

        if language not in ("en", "he"):
            raise ValueError("Language must be 'en' or 'he'")

        session_data_list = []
        session_previews = []

        for sid in session_ids:
            full = self._session_svc.get_full_session(sid, self._vocab_svc)
            if not full:
                raise ValueError(f"Session '{sid}' not found")
            session_data_list.append(full)

            sess_info = full["session"]
            session_previews.append(
                {
                    "session_id": sid,
                    "guild_name": sess_info.get("guild_name", "Discord Server"),
                    "channel_name": sess_info.get("channel_name", "Voice Channel"),
                    "started_at": sess_info.get("started_at"),
                }
            )

        formatted_input = self._format_sessions_input(session_data_list)
        report_text = await self._generate_llm_summary(formatted_input, language)

        report_id = uuid4().hex
        created_at = _utc_now_iso()

        report_record = {
            "report_id": report_id,
            "created_at": created_at,
            "language": language,
            "model": self._settings.OLLAMA_MODEL,
            "session_ids": session_ids,
            "session_previews": session_previews,
            "content": report_text,
        }

        report_file = self._dir / f"{report_id}.json"
        report_file.write_text(json.dumps(report_record, ensure_ascii=False, indent=2), encoding="utf-8")

        return report_record

    def list_reports(self) -> list[dict]:
        reports: list[dict] = []
        for path in self._dir.glob("*.json"):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                reports.append(data)
            except Exception as error:  # noqa: BLE001
                logger.warning("Could not read report file %s: %s", path, error)
                continue

        reports.sort(key=lambda item: item.get("created_at", ""), reverse=True)
        return reports

    def get_report(self, report_id: str) -> dict | None:
        file_path = self._dir / f"{report_id}.json"
        if not file_path.exists():
            return None
        try:
            return json.loads(file_path.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            return None

    def _format_sessions_input(self, session_data_list: list[dict]) -> str:
        lines: list[str] = []
        for data in session_data_list:
            meta = data["session"]
            lines.append(
                f"--- SESSION: {meta.get('channel_name')} in {meta.get('guild_name')} (Started: {meta.get('started_at')}) ---"
            )
            for utt in data.get("transcripts", []):
                speaker = utt.get("speaker_name", "Unknown")
                text = utt.get("text", "")
                ts = utt.get("timestamp", "")
                lines.append(f"[{ts}] {speaker}: {text}")
            lines.append("")
        return "\n".join(lines)

    async def _generate_llm_summary(self, text: str, language: str) -> str:
        if len(text) <= MAX_CHUNK_CHARS:
            return await self._call_ollama(text, language)

        # Handle oversized transcript input without silent truncation
        chunks = self._split_into_chunks(text, MAX_CHUNK_CHARS)
        chunk_summaries: list[str] = []
        for index, chunk in enumerate(chunks, 1):
            sub_prompt_intro = (
                f"Partial transcript section {index} of {len(chunks)}:\n\n{chunk}"
            )
            summary = await self._call_ollama(sub_prompt_intro, language)
            chunk_summaries.append(f"Section {index} Summary:\n{summary}")

        combined = "\n\n".join(chunk_summaries)
        final_prompt = (
            f"Synthesize the following section summaries into a single comprehensive report:\n\n{combined}"
        )
        return await self._call_ollama(final_prompt, language)

    def _split_into_chunks(self, text: str, max_chars: int) -> list[str]:
        lines = text.splitlines()
        chunks: list[str] = []
        current_chunk: list[str] = []
        current_len = 0

        for line in lines:
            if current_len + len(line) + 1 > max_chars and current_chunk:
                chunks.append("\n".join(current_chunk))
                current_chunk = []
                current_len = 0
            current_chunk.append(line)
            current_len += len(line) + 1

        if current_chunk:
            chunks.append("\n".join(current_chunk))

        return chunks

    async def _call_ollama(self, content_to_summarize: str, language: str) -> str:
        url = f"{self._settings.OLLAMA_BASE_URL.rstrip('/')}/api/generate"

        if language == "he":
            prompt = (
                "סכם את תמלילי שיחות ה-Discord הבאים בעברית. צור פלט ברור בפורמט markdown עם הסעיפים הבאים:\n"
                "1. סיכום כללי\n"
                "2. משתתפים\n"
                "3. נושאי שיחה מרכזיים לפי משתתף\n"
                "4. נקודות חשובות והחלטות\n\n"
                "היה תמציתי ועובדתי בלבד. אל תמציא מידע או שיוך שאינם מופיעים בתמליל.\n\n"
                f"{content_to_summarize}"
            )
        else:
            prompt = (
                "Summarize the following Discord voice channel transcripts in English. Format the output clearly in markdown with the following sections:\n"
                "1. Executive Summary\n"
                "2. Participants\n"
                "3. Key Discussion Topics by Participant\n"
                "4. Noteworthy Points and Decisions\n\n"
                "Be concise and strictly factual. Do not invent any information or attribution.\n\n"
                f"{content_to_summarize}"
            )

        payload = {
            "model": self._settings.OLLAMA_MODEL,
            "prompt": prompt,
            "stream": False,
        }

        try:
            async with (
                aiohttp.ClientSession() as session,
                session.post(url, json=payload, timeout=aiohttp.ClientTimeout(total=60)) as response,
            ):
                if response.status == 404:
                    raise RuntimeError(f"Model '{self._settings.OLLAMA_MODEL}' not found in Ollama")
                if response.status != 200:
                    body_text = await response.text()
                    raise RuntimeError(f"Ollama error ({response.status}): {body_text}")
                data = await response.json()
                response_text = data.get("response", "").strip()
                if not response_text:
                    raise RuntimeError("Ollama returned empty report response")
                return response_text
        except aiohttp.ClientConnectorError as error:
            raise RuntimeError(
                f"Ollama service unreachable at {self._settings.OLLAMA_BASE_URL}. Ensure Ollama is running."
            ) from error
        except TimeoutError as error:
            raise RuntimeError("Ollama report generation timed out") from error
        except RuntimeError:
            raise
        except Exception as error:
            raise RuntimeError(f"Report generation failed: {error}") from error
