import json
import logging
import os
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from backend.services.vocabulary import VocabularyService

logger = logging.getLogger(__name__)


def _utc_now_iso() -> str:
    return datetime.now(UTC).isoformat()


class SessionService:
    """Manages connection-scoped transcript sessions persisted in JSONL format."""

    def __init__(self, storage_dir: str | Path | None = None) -> None:
        if storage_dir is None:
            storage_dir = Path(os.getenv("DATA_DIR", "data")) / "sessions"
        self._dir = Path(storage_dir)
        self._dir.mkdir(parents=True, exist_ok=True)
        self._active_session_id: str | None = None

    @property
    def active_session_id(self) -> str | None:
        return self._active_session_id

    def start_session(
        self,
        guild_id: str | int,
        guild_name: str,
        channel_id: str | int,
        channel_name: str,
    ) -> dict:
        if self._active_session_id:
            self.end_session()

        session_id = uuid4().hex
        started_at = _utc_now_iso()
        meta = {
            "type": "start",
            "session_id": session_id,
            "started_at": started_at,
            "guild_id": str(guild_id),
            "guild_name": guild_name,
            "channel_id": str(channel_id),
            "channel_name": channel_name,
            "status": "active",
        }

        session_file = self._dir / f"{session_id}.jsonl"
        with session_file.open("a", encoding="utf-8") as file:
            file.write(json.dumps(meta) + "\n")

        self._active_session_id = session_id
        return meta

    def append_utterance(
        self,
        utterance_id: str,
        speaker_id: str,
        speaker_name: str,
        avatar_url: str | None,
        text: str,
        timestamp: str | None = None,
    ) -> None:
        if not self._active_session_id:
            return

        session_file = self._dir / f"{self._active_session_id}.jsonl"
        record = {
            "type": "utterance",
            "utterance_id": utterance_id,
            "speaker_id": speaker_id,
            "speaker_name": speaker_name,
            "avatar_url": avatar_url,
            "text": text,
            "timestamp": timestamp or _utc_now_iso(),
        }

        with session_file.open("a", encoding="utf-8") as file:
            file.write(json.dumps(record) + "\n")

    def end_session(self) -> dict | None:
        if not self._active_session_id:
            return None

        session_id = self._active_session_id
        ended_at = _utc_now_iso()
        record = {"type": "end", "ended_at": ended_at, "status": "closed"}

        session_file = self._dir / f"{session_id}.jsonl"
        if session_file.exists():
            with session_file.open("a", encoding="utf-8") as file:
                file.write(json.dumps(record) + "\n")

        self._active_session_id = None
        return {"session_id": session_id, "ended_at": ended_at, "status": "closed"}

    def get_active_session(self) -> dict | None:
        if not self._active_session_id:
            return None
        session_file = self._dir / f"{self._active_session_id}.jsonl"
        if not session_file.exists():
            return None
        return self._read_session_metadata(session_file)

    def list_sessions(
        self,
        vocabulary_service: VocabularyService | None = None,
    ) -> list[dict]:
        sessions: list[dict] = []
        for path in self._dir.glob("*.jsonl"):
            meta = self._read_session_metadata(path, vocabulary_service)
            if meta:
                sessions.append(meta)

        sessions.sort(key=lambda item: item.get("started_at", ""), reverse=True)
        return sessions

    def get_full_session(
        self,
        session_id: str,
        vocabulary_service: VocabularyService | None = None,
    ) -> dict | None:
        session_file = self._dir / f"{session_id}.jsonl"
        if not session_file.exists():
            return None

        start_meta: dict | None = None
        end_meta: dict | None = None
        utterances: list[dict] = []

        with session_file.open("r", encoding="utf-8") as file:
            for line in file:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                    rec_type = record.get("type")
                    if rec_type == "start":
                        start_meta = record
                    elif rec_type == "end":
                        end_meta = record
                    elif rec_type == "utterance":
                        text = record.get("text", "")
                        if vocabulary_service:
                            text = vocabulary_service.redact(text)
                        record["text"] = text
                        utterances.append(record)
                except json.JSONDecodeError:
                    continue

        if not start_meta:
            return None

        status = start_meta.get("status", "active")
        if session_id == self._active_session_id:
            status = "active"
        elif end_meta:
            status = end_meta.get("status", "closed")
        else:
            status = "interrupted"

        session_info = {
            "session_id": start_meta.get("session_id", session_id),
            "started_at": start_meta.get("started_at"),
            "ended_at": end_meta.get("ended_at") if end_meta else None,
            "status": status,
            "guild_id": start_meta.get("guild_id"),
            "guild_name": start_meta.get("guild_name"),
            "channel_id": start_meta.get("channel_id"),
            "channel_name": start_meta.get("channel_name"),
            "utterance_count": len(utterances),
        }

        return {"session": session_info, "transcripts": utterances}

    def _read_session_metadata(
        self,
        path: Path,
        vocabulary_service: VocabularyService | None = None,
    ) -> dict | None:
        start_meta: dict | None = None
        end_meta: dict | None = None
        utterance_count = 0
        first_utterance_text = ""

        with path.open("r", encoding="utf-8") as file:
            for line in file:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                    rec_type = record.get("type")
                    if rec_type == "start":
                        start_meta = record
                    elif rec_type == "end":
                        end_meta = record
                    elif rec_type == "utterance":
                        utterance_count += 1
                        if not first_utterance_text:
                            text = record.get("text", "")
                            if vocabulary_service:
                                text = vocabulary_service.redact(text)
                            first_utterance_text = text
                except json.JSONDecodeError:
                    continue

        if not start_meta:
            return None

        session_id = start_meta.get("session_id", path.stem)
        status = start_meta.get("status", "active")
        if session_id == self._active_session_id:
            status = "active"
        elif end_meta:
            status = end_meta.get("status", "closed")
        else:
            status = "interrupted"

        return {
            "session_id": session_id,
            "started_at": start_meta.get("started_at"),
            "ended_at": end_meta.get("ended_at") if end_meta else None,
            "status": status,
            "guild_id": start_meta.get("guild_id"),
            "guild_name": start_meta.get("guild_name"),
            "channel_id": start_meta.get("channel_id"),
            "channel_name": start_meta.get("channel_name"),
            "utterance_count": utterance_count,
            "preview_text": first_utterance_text[:120],
        }
