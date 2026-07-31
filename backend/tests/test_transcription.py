import asyncio
from types import SimpleNamespace

import numpy as np
import pytest

from backend.services.events import EventBroker
from backend.services.transcription import Speaker, TranscriptionPipeline


class FakeWhisperEngine:
    def __init__(self, text: str = " hello from discord "):
        self.received_audio: list[np.ndarray] = []
        self.text = text

    def transcribe(self, audio: np.ndarray) -> str:
        self.received_audio.append(audio)
        return self.text


def make_settings(**overrides):
    values = {
        "SAMPLE_RATE": 16000,
        "AUDIO_LEVEL_THRESHOLD": 0.008,
        "MAX_UTTERANCE_SECONDS": 15.0,
        "PARTIAL_INTERVAL_SECONDS": 100.0,
        "SILENCE_SECONDS": 100.0,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


@pytest.mark.asyncio
async def test_finalized_transcript_keeps_discord_speaker():
    engine = FakeWhisperEngine()
    broker = EventBroker()
    events = broker.subscribe()
    settings = make_settings()
    pipeline = TranscriptionPipeline(engine, broker, settings)
    speaker = Speaker(id="42", name="Ada", avatar_url="https://example.test/a.png")
    pcm = np.full((12000, 2), 1000, dtype="<i2").tobytes()

    await pipeline.start()
    pipeline.ingest_frame(speaker, pcm)
    pipeline.finalize_speaker(speaker.id)
    await pipeline._jobs.join()

    published = []
    while not events.empty():
        published.append(events.get_nowait())

    transcript = next(event for event in published if event["type"] == "transcript")
    assert transcript["speaker_id"] == "42"
    assert transcript["speaker_name"] == "Ada"
    assert transcript["text"] == "hello from discord"
    assert transcript["finalized"] is True
    assert engine.received_audio[0].dtype == np.float32

    await pipeline.stop()


@pytest.mark.asyncio
async def test_laughter_markers_are_replaced_with_emoji():
    engine = FakeWhisperEngine("That was funny [LAUGHTER] and (Laughing)")
    broker = EventBroker()
    events = broker.subscribe()
    pipeline = TranscriptionPipeline(engine, broker, make_settings())
    speaker = Speaker(id="42", name="Ada")
    pcm = np.full((12000, 2), 1000, dtype="<i2").tobytes()

    await pipeline.start()
    pipeline.ingest_frame(speaker, pcm)
    pipeline.finalize_speaker(speaker.id)
    await pipeline._jobs.join()

    transcript = next(
        event
        for event in list(events._queue)
        if event["type"] == "transcript"
    )
    assert transcript["text"] == "That was funny 🤣 and 🤣"

    await pipeline.stop()


@pytest.mark.asyncio
async def test_speaker_activity_ignores_silence_and_clears_after_timeout():
    engine = FakeWhisperEngine()
    broker = EventBroker()
    events = broker.subscribe()
    pipeline = TranscriptionPipeline(
        engine,
        broker,
        make_settings(SILENCE_SECONDS=0.01),
    )
    speaker = Speaker(id="42", name="Ada")
    silence = bytes(3840)
    signal = np.full((4800, 2), 2000, dtype="<i2").tobytes()

    await pipeline.start()
    pipeline.ingest_frame(speaker, silence)
    assert events.empty()

    pipeline.ingest_frame(speaker, signal)
    await asyncio.sleep(0.25)

    speaking_events = []
    while not events.empty():
        event = events.get_nowait()
        if event["type"] == "speaker":
            speaking_events.append(event["speaking"])

    assert speaking_events == [True, False]
    await pipeline.stop()


@pytest.mark.asyncio
async def test_overlapping_speakers_have_independent_activity():
    engine = FakeWhisperEngine()
    broker = EventBroker()
    events = broker.subscribe()
    pipeline = TranscriptionPipeline(
        engine,
        broker,
        make_settings(SILENCE_SECONDS=0.01),
    )
    first_speaker = Speaker(id="1", name="Ada")
    second_speaker = Speaker(id="2", name="Linus")
    signal = np.full((4800, 2), 2000, dtype="<i2").tobytes()

    await pipeline.start()
    pipeline.ingest_frame(first_speaker, signal)
    pipeline.ingest_frame(second_speaker, signal)
    await asyncio.sleep(0.25)

    speaking_events = [
        (event["speaker_id"], event["speaking"])
        for event in list(events._queue)
        if event["type"] == "speaker"
    ]

    assert speaking_events == [
        ("1", True),
        ("2", True),
        ("1", False),
        ("2", False),
    ]
    await pipeline.stop()
