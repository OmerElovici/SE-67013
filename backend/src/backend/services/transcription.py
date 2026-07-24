import asyncio
import re
import time
from dataclasses import dataclass, field
from typing import Any
from uuid import uuid4

from backend.core.config import Settings
from backend.services.audio import (
    DISCORD_CHANNELS,
    DISCORD_SAMPLE_RATE,
    discord_pcm_to_whisper,
    pcm_level,
)
from backend.services.events import EventBroker
from backend.services.whisper import WhisperEngine

BYTES_PER_SECOND = DISCORD_SAMPLE_RATE * DISCORD_CHANNELS * 2


@dataclass(frozen=True)
class Speaker:
    id: str
    name: str
    avatar_url: str | None = None

    def as_event_fields(self) -> dict[str, str | None]:
        return {
            "speaker_id": self.id,
            "speaker_name": self.name,
            "avatar_url": self.avatar_url,
        }


@dataclass
class SpeakerBuffer:
    speaker: Speaker
    utterance_id: str = field(default_factory=lambda: uuid4().hex)
    pcm: bytearray = field(default_factory=bytearray)
    started_at: float = field(default_factory=time.monotonic)
    last_packet_at: float = field(default_factory=time.monotonic)
    last_voice_at: float = field(default_factory=time.monotonic)
    last_partial_at: float = field(default_factory=time.monotonic)
    revision: int = 0


@dataclass(frozen=True)
class TranscriptionJob:
    speaker: Speaker
    utterance_id: str
    revision: int
    pcm: bytes
    finalized: bool


class TranscriptionPipeline:
    """Buffers Discord audio per speaker and serializes local Whisper work."""

    def __init__(
        self,
        engine: WhisperEngine,
        broker: EventBroker,
        settings: Settings,
    ):
        self._engine = engine
        self._broker = broker
        self._settings = settings
        self._buffers: dict[str, SpeakerBuffer] = {}
        self._jobs: asyncio.Queue[TranscriptionJob | None] = asyncio.Queue()
        self._latest_partial_revision: dict[str, int] = {}
        self._closed_utterances: set[str] = set()
        self._worker_task: asyncio.Task[None] | None = None
        self._monitor_task: asyncio.Task[None] | None = None
        self._last_level_event: dict[str, float] = {}

    async def start(self) -> None:
        self._worker_task = asyncio.create_task(
            self._transcription_worker(),
            name="whisper-worker",
        )
        self._monitor_task = asyncio.create_task(
            self._monitor_silence(),
            name="discord-silence-monitor",
        )

    async def stop(self) -> None:
        self.finalize_all()

        if self._monitor_task:
            self._monitor_task.cancel()
            await asyncio.gather(self._monitor_task, return_exceptions=True)

        await self._jobs.put(None)
        if self._worker_task:
            await self._worker_task

    def ingest_frame(self, speaker: Speaker, pcm: bytes) -> None:
        if not pcm:
            return

        now = time.monotonic()
        buffer = self._buffers.get(speaker.id)
        level = pcm_level(pcm)
        if buffer is None:
            if level < self._settings.AUDIO_LEVEL_THRESHOLD:
                return
            buffer = SpeakerBuffer(speaker=speaker)
            self._buffers[speaker.id] = buffer
            self._publish_speaking(speaker, True)

        buffer.pcm.extend(pcm)
        buffer.last_packet_at = now
        buffer.revision += 1

        if level >= self._settings.AUDIO_LEVEL_THRESHOLD:
            buffer.last_voice_at = now

        if now - self._last_level_event.get(speaker.id, 0.0) >= 0.1:
            self._last_level_event[speaker.id] = now
            self._broker.publish(
                {
                    "type": "audio_level",
                    **speaker.as_event_fields(),
                    "level": min(level * 4.0, 1.0),
                }
            )

        duration = len(buffer.pcm) / BYTES_PER_SECOND
        if duration >= self._settings.MAX_UTTERANCE_SECONDS:
            self.finalize_speaker(speaker.id)
            return

        if (
            duration >= 0.75
            and now - buffer.last_partial_at >= self._settings.PARTIAL_INTERVAL_SECONDS
        ):
            buffer.last_partial_at = now
            self._submit_job(buffer, finalized=False)

    def finalize_speaker(
        self,
        speaker_id: str,
        fallback_speaker: Speaker | None = None,
    ) -> None:
        buffer = self._buffers.pop(speaker_id, None)
        speaker = buffer.speaker if buffer else fallback_speaker
        if speaker is None:
            return

        if buffer and len(buffer.pcm) >= int(BYTES_PER_SECOND * 0.2):
            self._closed_utterances.add(buffer.utterance_id)
            self._submit_job(buffer, finalized=True)

        self._last_level_event.pop(speaker_id, None)
        self._publish_speaking(speaker, False)
        self._broker.publish(
            {
                "type": "audio_level",
                **speaker.as_event_fields(),
                "level": 0.0,
            }
        )

    def finalize_all(self) -> None:
        for speaker_id in tuple(self._buffers):
            self.finalize_speaker(speaker_id)

    def _submit_job(
        self,
        buffer: SpeakerBuffer,
        *,
        finalized: bool,
    ) -> None:
        job = TranscriptionJob(
            speaker=buffer.speaker,
            utterance_id=buffer.utterance_id,
            revision=buffer.revision,
            pcm=bytes(buffer.pcm),
            finalized=finalized,
        )

        if not finalized:
            self._latest_partial_revision[job.utterance_id] = job.revision
            if self._jobs.qsize() >= 4:
                return

        self._jobs.put_nowait(job)

    async def _transcription_worker(self) -> None:
        while True:
            job = await self._jobs.get()
            if job is None:
                self._jobs.task_done()
                break

            try:
                if self._is_stale_partial(job):
                    continue

                audio = await asyncio.to_thread(
                    discord_pcm_to_whisper,
                    job.pcm,
                    self._settings.SAMPLE_RATE,
                )
                text = await asyncio.to_thread(self._engine.transcribe, audio)
                text = re.sub(
                    r"\[BLANK_AUDIO\]",
                    "",
                    text,
                    flags=re.IGNORECASE,
                ).strip()

                if self._is_stale_partial(job):
                    continue

                self._broker.publish(
                    {
                        "type": "transcript",
                        **job.speaker.as_event_fields(),
                        "utterance_id": job.utterance_id,
                        "text": text,
                        "finalized": job.finalized,
                    }
                )
            except Exception as error:  # noqa: BLE001
                self._broker.publish(
                    {
                        "type": "error",
                        "message": f"Transcription failed: {error}",
                    }
                )
            finally:
                if job.finalized:
                    self._latest_partial_revision.pop(job.utterance_id, None)
                    self._closed_utterances.discard(job.utterance_id)
                self._jobs.task_done()

    def _is_stale_partial(self, job: TranscriptionJob) -> bool:
        if job.finalized:
            return False
        return (
            job.utterance_id in self._closed_utterances
            or self._latest_partial_revision.get(job.utterance_id) != job.revision
        )

    async def _monitor_silence(self) -> None:
        while True:
            await asyncio.sleep(0.2)
            now = time.monotonic()
            silent_speakers = [
                speaker_id
                for speaker_id, buffer in self._buffers.items()
                if now - buffer.last_voice_at >= self._settings.SILENCE_SECONDS
            ]
            for speaker_id in silent_speakers:
                self.finalize_speaker(speaker_id)

    def _publish_speaking(self, speaker: Speaker, speaking: bool) -> None:
        self._broker.publish(
            {
                "type": "speaker",
                **speaker.as_event_fields(),
                "speaking": speaking,
            }
        )

    def snapshot(self) -> dict[str, Any]:
        return {
            "active_speakers": [
                buffer.speaker.as_event_fields() for buffer in self._buffers.values()
            ]
        }
