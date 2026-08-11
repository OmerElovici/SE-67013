import json
import logging
import math
import os
import struct
import threading
import time
import wave
from collections import deque
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

import numpy as np

from backend.services.audio import DISCORD_CHANNELS, DISCORD_SAMPLE_RATE
from backend.services.vocabulary import VocabularyService

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class _RtpCaptureState:
    sequence: int
    timestamp: int
    start_frame: int
    frame_count: int
    captured_at: float


@dataclass(frozen=True)
class _RecordingMutation:
    revision: int
    offset: int
    size: int


def _utc_now_iso() -> str:
    return datetime.now(UTC).isoformat()


class SessionService:
    """Manages connection-scoped transcript sessions persisted in JSONL format."""

    _TRANSCRIPT_FILENAME = "transcript.jsonl"
    _RECORDING_FILENAME = "recording.wav"
    _SAMPLE_WIDTH = 2
    _WAV_HEADER_SIZE = 44
    _RECORDING_MUTATION_HISTORY = 4096

    def __init__(self, storage_dir: str | Path | None = None) -> None:
        if storage_dir is None:
            storage_dir = Path(os.getenv("DATA_DIR", "data")) / "sessions"
        self._dir = Path(storage_dir)
        self._dir.mkdir(parents=True, exist_ok=True)
        self._active_session_id: str | None = None
        self._recording_started_at: dict[str, float] = {}
        self._speaker_capture_ends: dict[tuple[str, str], int] = {}
        self._speaker_rtp_captures: dict[
            tuple[str, str],
            _RtpCaptureState,
        ] = {}
        self._recording_failures: set[str] = set()
        self._recording_stream_lock = threading.RLock()
        self._recording_revisions: dict[str, int] = {}
        self._recording_mutations: dict[
            str,
            deque[_RecordingMutation],
        ] = {}
        self._recording_stream_subscribers: dict[str, int] = {}
        self._recording_stream_cleanup_pending: set[str] = set()
        self._migration_failures = self._migrate_flat_sessions()
        self._discard_interrupted_empty_sessions()

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

        session_file = self._new_session_file(session_id)
        session_file.parent.mkdir(parents=True, exist_ok=True)
        with session_file.open("a", encoding="utf-8") as file:
            file.write(json.dumps(meta) + "\n")

        self._active_session_id = session_id
        self._recording_started_at[session_id] = time.monotonic()
        self._recording_revisions[session_id] = 0
        self._recording_mutations[session_id] = deque(
            maxlen=self._RECORDING_MUTATION_HISTORY,
        )
        self._initialize_recording(session_id)
        return meta

    def capture_audio(
        self,
        speaker_id: str,
        pcm: bytes,
        *,
        captured_at: float | None = None,
        rtp_timestamp: int | None = None,
        rtp_sequence: int | None = None,
        session_id: str | None = None,
    ) -> tuple[float, float] | None:
        """Mix one human PCM frame onto its session-relative timeline."""
        target_session_id = session_id or self._active_session_id
        if not target_session_id or not pcm:
            return None

        frame_width = DISCORD_CHANNELS * self._SAMPLE_WIDTH
        if len(pcm) % frame_width:
            logger.warning("Ignoring malformed Discord PCM recording frame")
            return None

        origin = self._recording_started_at.get(target_session_id)
        if origin is None:
            return None

        captured_at = captured_at if captured_at is not None else time.monotonic()
        frame_count = len(pcm) // frame_width
        speaker_key = (target_session_id, speaker_id)
        start_frame = self._recording_start_frame(
            speaker_key,
            origin,
            captured_at,
            frame_count,
            rtp_timestamp,
            rtp_sequence,
        )
        end_frame = start_frame + frame_count
        self._speaker_capture_ends[speaker_key] = end_frame

        timing = (
            start_frame / DISCORD_SAMPLE_RATE,
            end_frame / DISCORD_SAMPLE_RATE,
        )
        if target_session_id in self._recording_failures:
            return timing

        try:
            with self._recording_stream_lock:
                if target_session_id not in self._recording_started_at:
                    return timing
                self._mix_recording_frame(target_session_id, start_frame, pcm)
                revision = self._recording_revisions.get(target_session_id, 0) + 1
                self._recording_revisions[target_session_id] = revision
                mutations = self._recording_mutations.setdefault(
                    target_session_id,
                    deque(maxlen=self._RECORDING_MUTATION_HISTORY),
                )
                mutations.append(
                    _RecordingMutation(
                        revision=revision,
                        offset=start_frame * frame_width,
                        size=len(pcm),
                    )
                )
        except (OSError, ValueError):
            logger.exception(
                "Could not write session recording for %s",
                target_session_id,
            )
            self._invalidate_recording(target_session_id)
        return timing

    def append_utterance(
        self,
        utterance_id: str,
        speaker_id: str,
        speaker_name: str,
        avatar_url: str | None,
        text: str,
        timestamp: str | None = None,
        session_id: str | None = None,
        start_seconds: float | None = None,
        end_seconds: float | None = None,
    ) -> None:
        target_session_id = session_id or self._active_session_id
        if not target_session_id:
            return

        session_file = self._existing_session_file(target_session_id)
        if not session_file:
            return
        record = {
            "type": "utterance",
            "utterance_id": utterance_id,
            "speaker_id": speaker_id,
            "speaker_name": speaker_name,
            "avatar_url": avatar_url,
            "text": text,
            "timestamp": timestamp
            or self._timestamp_for_offset(target_session_id, start_seconds)
            or _utc_now_iso(),
        }
        if start_seconds is not None:
            record["start_seconds"] = start_seconds
        if end_seconds is not None:
            record["end_seconds"] = end_seconds

        with session_file.open("a", encoding="utf-8") as file:
            file.write(json.dumps(record) + "\n")

    def end_session(self, session_id: str | None = None) -> dict | None:
        target_session_id = session_id or self._active_session_id
        if not target_session_id:
            return None

        ended_at = _utc_now_iso()
        record = {"type": "end", "ended_at": ended_at, "status": "closed"}

        session_file = self._existing_session_file(target_session_id)
        if session_file:
            if self._is_start_only_session(session_file):
                self._discard_session_file(session_file)
            else:
                with session_file.open("a", encoding="utf-8") as file:
                    file.write(json.dumps(record) + "\n")

        if target_session_id == self._active_session_id:
            self._active_session_id = None
        self._recording_started_at.pop(target_session_id, None)
        self._recording_failures.discard(target_session_id)
        self._speaker_capture_ends = {
            key: value
            for key, value in self._speaker_capture_ends.items()
            if key[0] != target_session_id
        }
        self._speaker_rtp_captures = {
            key: value
            for key, value in self._speaker_rtp_captures.items()
            if key[0] != target_session_id
        }
        with self._recording_stream_lock:
            if self._recording_stream_subscribers.get(target_session_id, 0):
                self._recording_stream_cleanup_pending.add(target_session_id)
            else:
                self._release_recording_stream_state(target_session_id)
        return {
            "session_id": target_session_id,
            "ended_at": ended_at,
            "status": "closed",
        }

    def open_recording_stream(self, session_id: str) -> bool:
        """Retain active-session mutation state for one stream subscriber."""
        with self._recording_stream_lock:
            if self._active_session_id != session_id:
                return False
            self._recording_stream_subscribers[session_id] = (
                self._recording_stream_subscribers.get(session_id, 0) + 1
            )
            return True

    def close_recording_stream(self, session_id: str) -> None:
        """Release one subscriber and any stream state deferred by closure."""
        with self._recording_stream_lock:
            subscribers = self._recording_stream_subscribers.get(session_id, 0)
            if subscribers <= 1:
                self._recording_stream_subscribers.pop(session_id, None)
                if (
                    session_id in self._recording_stream_cleanup_pending
                    or self._active_session_id != session_id
                ):
                    self._release_recording_stream_state(session_id)
            else:
                self._recording_stream_subscribers[session_id] = subscribers - 1

    def _release_recording_stream_state(self, session_id: str) -> None:
        self._recording_revisions.pop(session_id, None)
        self._recording_mutations.pop(session_id, None)
        self._recording_stream_cleanup_pending.discard(session_id)

    def get_active_session(
        self,
        vocabulary_service: VocabularyService | None = None,
    ) -> dict | None:
        if not self._active_session_id:
            return None
        session_file = self._existing_session_file(self._active_session_id)
        if not session_file:
            return None
        return self._read_session_metadata(session_file, vocabulary_service)

    def list_sessions(
        self,
        vocabulary_service: VocabularyService | None = None,
    ) -> list[dict]:
        sessions: list[dict] = []
        for path in self._iter_session_files():
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
        session_file = self._existing_session_file(session_id)
        if not session_file:
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
        if not utterances:
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

        return {
            "session": session_info,
            "transcripts": utterances,
            "recording": self.get_recording_info(session_id),
        }

    def get_recording_info(self, session_id: str) -> dict:
        if session_id in self._recording_failures:
            return {
                "available": False,
                "duration_seconds": 0.0,
                "mime_type": "audio/wav",
            }
        recording_path = self.get_recording_path(session_id)
        if recording_path is None:
            return {
                "available": False,
                "duration_seconds": 0.0,
                "mime_type": "audio/wav",
            }

        try:
            with wave.open(str(recording_path), "rb") as recording:
                if (
                    recording.getnchannels() != DISCORD_CHANNELS
                    or recording.getsampwidth() != self._SAMPLE_WIDTH
                    or recording.getframerate() != DISCORD_SAMPLE_RATE
                ):
                    raise wave.Error("Unexpected recording format")
                frames = recording.getnframes()
                if frames <= 0:
                    raise wave.Error("Recording is empty")
        except (EOFError, OSError, wave.Error):
            return {
                "available": False,
                "duration_seconds": 0.0,
                "mime_type": "audio/wav",
            }

        return {
            "available": True,
            "duration_seconds": frames / DISCORD_SAMPLE_RATE,
            "mime_type": "audio/wav",
        }

    def get_recording_path(self, session_id: str) -> Path | None:
        if not self._existing_session_file(session_id):
            return None
        path = self._dir / session_id / self._RECORDING_FILENAME
        return path if path.is_file() else None

    def get_recording_data_size(self, session_id: str) -> int | None:
        """Return the durable PCM byte count, excluding the WAV header."""
        with self._recording_stream_lock:
            if session_id in self._recording_failures:
                return None
            path = self.get_recording_path(session_id)
            if path is None:
                return None
            try:
                size = max(0, path.stat().st_size - self._WAV_HEADER_SIZE)
            except OSError:
                return None
            frame_width = DISCORD_CHANNELS * self._SAMPLE_WIDTH
            return size - (size % frame_width)

    def get_recording_stream_state(
        self,
        session_id: str,
        after_revision: int = 0,
    ) -> dict | None:
        """Return an atomic durable size and mutation journal snapshot."""
        with self._recording_stream_lock:
            captured = self.get_recording_data_size(session_id)
            if captured is None:
                return None
            revision = self._recording_revisions.get(session_id, 0)
            journal = self._recording_mutations.get(session_id, ())
            history_complete = not journal or after_revision >= journal[0].revision - 1
            mutations = [
                {
                    "revision": mutation.revision,
                    "offset": mutation.offset,
                    "size": mutation.size,
                }
                for mutation in journal
                if mutation.revision > after_revision
            ]
            return {
                "captured_bytes": captured,
                "revision": revision,
                "mutations": mutations,
                "history_complete": history_complete,
            }

    def read_recording_data(
        self,
        session_id: str,
        offset: int,
        size: int,
    ) -> bytes:
        """Read a frame-aligned slice of durable PCM recording data."""
        frame_width = DISCORD_CHANNELS * self._SAMPLE_WIDTH
        if offset < 0 or size <= 0 or offset % frame_width:
            return b""
        with self._recording_stream_lock:
            path = self.get_recording_path(session_id)
            if path is None or session_id in self._recording_failures:
                return b""
            try:
                with path.open("rb") as recording:
                    recording.seek(self._WAV_HEADER_SIZE + offset)
                    data = recording.read(size)
            except OSError:
                return b""
            return data[: len(data) - (len(data) % frame_width)]

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
        if utterance_count == 0:
            return None

        session_id = start_meta.get("session_id", self._session_id_from_path(path))
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

    @staticmethod
    def _is_start_only_session(path: Path) -> bool:
        start_records = 0
        with path.open("r", encoding="utf-8") as file:
            for line in file:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    return False
                if record.get("type") != "start":
                    return False
                start_records += 1
        return start_records == 1

    def _new_session_file(self, session_id: str) -> Path:
        return self._dir / session_id / self._TRANSCRIPT_FILENAME

    def _recording_file(self, session_id: str) -> Path:
        return self._dir / session_id / self._RECORDING_FILENAME

    def _initialize_recording(self, session_id: str) -> None:
        try:
            path = self._recording_file(session_id)
            with path.open("xb") as recording:
                recording.write(self._wav_header(0))
        except (FileExistsError, OSError):
            logger.exception("Could not initialize session recording for %s", session_id)
            self._invalidate_recording(session_id)

    def _mix_recording_frame(
        self,
        session_id: str,
        start_frame: int,
        pcm: bytes,
    ) -> None:
        path = self._recording_file(session_id)
        frame_width = DISCORD_CHANNELS * self._SAMPLE_WIDTH
        byte_offset = self._WAV_HEADER_SIZE + start_frame * frame_width

        with path.open("r+b") as recording:
            recording.seek(0, os.SEEK_END)
            current_data_size = max(0, recording.tell() - self._WAV_HEADER_SIZE)
            recording.seek(byte_offset)
            existing = recording.read(len(pcm))
            if len(existing) < len(pcm):
                existing += bytes(len(pcm) - len(existing))

            mixed = np.frombuffer(existing, dtype="<i2").astype(np.int32)
            mixed += np.frombuffer(pcm, dtype="<i2").astype(np.int32)
            mixed = np.clip(mixed, -32768, 32767).astype("<i2").tobytes()
            recording.seek(byte_offset)
            recording.write(mixed)

            data_size = max(current_data_size, start_frame * frame_width + len(pcm))
            recording.seek(0)
            recording.write(self._wav_header(data_size))
            recording.flush()

    def _recording_start_frame(
        self,
        speaker_key: tuple[str, str],
        origin: float,
        captured_at: float,
        frame_count: int,
        rtp_timestamp: int | None,
        rtp_sequence: int | None,
    ) -> int:
        valid_capture_time = (
            isinstance(captured_at, (int, float))
            and not isinstance(captured_at, bool)
            and math.isfinite(captured_at)
        )
        wall_start = (
            max(0, round((captured_at - origin) * DISCORD_SAMPLE_RATE))
            if valid_capture_time
            else None
        )
        previous_end = self._speaker_capture_ends.get(speaker_key)
        previous_rtp = self._speaker_rtp_captures.get(speaker_key)
        fallback_start = max(previous_end or 0, wall_start or 0)
        has_rtp_timing = rtp_timestamp is not None or rtp_sequence is not None
        if not has_rtp_timing and previous_rtp is None:
            jitter_tolerance = max(1, frame_count // 4)
            if (
                wall_start is not None
                and previous_end is not None
                and abs(wall_start - previous_end) <= jitter_tolerance
            ):
                return previous_end
            return fallback_start

        valid_rtp_timing = self._valid_rtp_value(
            rtp_timestamp,
            2**32 - 1,
        ) and self._valid_rtp_value(rtp_sequence, 2**16 - 1)
        if not valid_capture_time or not valid_rtp_timing:
            self._speaker_rtp_captures.pop(speaker_key, None)
            return fallback_start

        if previous_rtp is None:
            start_frame = fallback_start
        else:
            sequence_delta = (rtp_sequence - previous_rtp.sequence) % 2**16
            timestamp_delta = (rtp_timestamp - previous_rtp.timestamp) % 2**32
            callback_delta = max(0.0, captured_at - previous_rtp.captured_at)
            maximum_delta = round(
                (callback_delta + 5.0) * DISCORD_SAMPLE_RATE,
            )
            if (
                sequence_delta == 0
                or sequence_delta >= 2**15
                or timestamp_delta < previous_rtp.frame_count
                or timestamp_delta > maximum_delta
            ):
                start_frame = fallback_start
            else:
                start_frame = previous_rtp.start_frame + timestamp_delta

        self._speaker_rtp_captures[speaker_key] = _RtpCaptureState(
            sequence=rtp_sequence,
            timestamp=rtp_timestamp,
            start_frame=start_frame,
            frame_count=frame_count,
            captured_at=captured_at,
        )
        return start_frame

    @staticmethod
    def _valid_rtp_value(value: object, maximum: int) -> bool:
        return (
            isinstance(value, int)
            and not isinstance(value, bool)
            and 0 <= value <= maximum
        )

    def _invalidate_recording(self, session_id: str) -> None:
        self._recording_failures.add(session_id)
        try:
            self._recording_file(session_id).unlink()
        except FileNotFoundError:
            pass
        except OSError:
            logger.warning(
                "Could not remove failed session recording for %s",
                session_id,
                exc_info=True,
            )

    @classmethod
    def _wav_header(cls, data_size: int) -> bytes:
        byte_rate = DISCORD_SAMPLE_RATE * DISCORD_CHANNELS * cls._SAMPLE_WIDTH
        block_align = DISCORD_CHANNELS * cls._SAMPLE_WIDTH
        return struct.pack(
            "<4sI4s4sIHHIIHH4sI",
            b"RIFF",
            36 + data_size,
            b"WAVE",
            b"fmt ",
            16,
            1,
            DISCORD_CHANNELS,
            DISCORD_SAMPLE_RATE,
            byte_rate,
            block_align,
            cls._SAMPLE_WIDTH * 8,
            b"data",
            data_size,
        )

    def _timestamp_for_offset(
        self,
        session_id: str,
        offset_seconds: float | None,
    ) -> str | None:
        if offset_seconds is None:
            return None
        session_file = self._existing_session_file(session_id)
        if not session_file:
            return None
        with session_file.open("r", encoding="utf-8") as file:
            for line in file:
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if record.get("type") != "start":
                    continue
                started_at = record.get("started_at")
                if not started_at:
                    return None
                try:
                    start = datetime.fromisoformat(started_at)
                except ValueError:
                    return None
                return (start + timedelta(seconds=offset_seconds)).isoformat()
        return None

    def _legacy_session_file(self, session_id: str) -> Path:
        return self._dir / f"{session_id}.jsonl"

    def _existing_session_file(self, session_id: str) -> Path | None:
        legacy_file = self._legacy_session_file(session_id)
        if legacy_file.is_file():
            return legacy_file

        session_file = self._new_session_file(session_id)
        if session_file.is_file():
            return session_file
        return None

    def _session_id_from_path(self, path: Path) -> str:
        if path.name == self._TRANSCRIPT_FILENAME:
            return path.parent.name
        return path.stem

    def _iter_session_files(self) -> Iterator[Path]:
        legacy_session_ids: set[str] = set()
        for path in self._dir.glob("*.jsonl"):
            if path.is_file():
                legacy_session_ids.add(path.stem)
                yield path

        for path in self._dir.glob(f"*/{self._TRANSCRIPT_FILENAME}"):
            if path.is_file() and path.parent.name not in legacy_session_ids:
                yield path

    def _migrate_flat_sessions(self) -> set[Path]:
        failures: set[Path] = set()
        for path in self._dir.glob("*.jsonl"):
            if path.is_file() and not self._migrate_flat_session(path):
                failures.add(path)
        return failures

    def _migrate_flat_session(self, legacy_file: Path) -> bool:
        session_file = self._new_session_file(legacy_file.stem)
        target_created = False
        try:
            session_file.parent.mkdir(exist_ok=True)
            if session_file.exists():
                if session_file.is_file() and self._files_match(
                    legacy_file,
                    session_file,
                ):
                    legacy_file.unlink()
                    return True
                logger.warning(
                    "Could not migrate legacy session %s: destination exists",
                    legacy_file,
                )
                return False

            os.link(legacy_file, session_file)
            target_created = True
            legacy_file.unlink()
            return True
        except OSError:
            if target_created and legacy_file.exists():
                try:
                    session_file.unlink()
                except OSError:
                    pass
            logger.warning(
                "Could not migrate legacy session %s",
                legacy_file,
                exc_info=True,
            )
            return False

    @staticmethod
    def _files_match(first: Path, second: Path) -> bool:
        with first.open("rb") as first_file, second.open("rb") as second_file:
            while True:
                first_chunk = first_file.read(1024 * 1024)
                second_chunk = second_file.read(1024 * 1024)
                if first_chunk != second_chunk:
                    return False
                if not first_chunk:
                    return True

    def _discard_session_file(self, path: Path) -> None:
        path.unlink()
        if path.parent.parent == self._dir:
            recording_path = path.parent / self._RECORDING_FILENAME
            try:
                recording_path.unlink()
            except FileNotFoundError:
                pass
            try:
                path.parent.rmdir()
            except OSError:
                pass

    def _discard_interrupted_empty_sessions(self) -> None:
        for path in self._iter_session_files():
            if (
                path not in self._migration_failures
                and self._is_start_only_session(path)
            ):
                self._discard_session_file(path)
