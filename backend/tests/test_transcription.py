import asyncio
import threading
from datetime import datetime, timedelta
from types import SimpleNamespace
from unittest.mock import MagicMock

import numpy as np
import pytest

from backend.services.discord_audio import DiscordAudioSink
from backend.services.discord_bot import DiscordBotService
from backend.services.events import EventBroker
from backend.services.session import SessionService
from backend.services.transcription import Speaker, TranscriptionPipeline


class FakeWhisperEngine:
    def __init__(self, text: str = " hello from discord "):
        self.received_audio: list[np.ndarray] = []
        self.text = text

    def transcribe(self, audio: np.ndarray) -> str:
        self.received_audio.append(audio)
        return self.text


class DelayedWhisperEngine(FakeWhisperEngine):
    def __init__(self, text: str = "delayed final transcript"):
        super().__init__(text)
        self.started = threading.Event()
        self.release = threading.Event()

    def transcribe(self, audio: np.ndarray) -> str:
        self.started.set()
        if not self.release.wait(timeout=5):
            raise RuntimeError("test transcription release timed out")
        return super().transcribe(audio)


class FakeVoiceClient:
    def __init__(self):
        self.listening = True
        self.disconnected = False

    def is_listening(self) -> bool:
        return self.listening

    def stop_listening(self) -> None:
        self.listening = False

    def is_connected(self) -> bool:
        return False

    async def disconnect(self, *, force: bool) -> None:
        assert force is True
        self.disconnected = True


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


@pytest.mark.asyncio
async def test_disconnect_waits_for_delayed_final_transcript(tmp_path):
    engine = DelayedWhisperEngine()
    broker = EventBroker()
    session_service = SessionService(storage_dir=tmp_path)
    pipeline = TranscriptionPipeline(
        engine,
        broker,
        make_settings(),
        session_service=session_service,
    )
    bot = DiscordBotService(
        token="",
        pipeline=pipeline,
        broker=broker,
        session_service=session_service,
    )
    voice_client = FakeVoiceClient()
    bot._voice_client = voice_client
    first = session_service.start_session("1", "Guild", "10", "First")
    speaker = Speaker(id="42", name="Ada")
    pcm = np.full((12000, 2), 1000, dtype="<i2").tobytes()

    await pipeline.start()
    pipeline.ingest_frame(speaker, pcm)
    disconnect = asyncio.create_task(bot.disconnect())
    assert await asyncio.to_thread(engine.started.wait, 2)

    reconnect_started = asyncio.Event()

    async def reconnect() -> dict:
        async with bot._connection_lock:
            reconnect_started.set()
            return session_service.start_session("1", "Guild", "20", "Second")

    reconnect_task = asyncio.create_task(reconnect())
    await asyncio.sleep(0)
    assert not disconnect.done()
    assert not reconnect_started.is_set()

    engine.release.set()
    await disconnect
    second = await reconnect_task

    first_session = session_service.get_full_session(first["session_id"])
    assert first_session is not None
    assert first_session["session"]["status"] == "closed"
    assert [item["text"] for item in first_session["transcripts"]] == [
        "delayed final transcript"
    ]
    assert session_service.active_session_id == second["session_id"]
    assert session_service.get_full_session(second["session_id"]) is None
    await pipeline.stop()


@pytest.mark.asyncio
async def test_finalized_job_remains_bound_to_originating_session(tmp_path):
    session_service = SessionService(storage_dir=tmp_path)
    pipeline = TranscriptionPipeline(
        FakeWhisperEngine("originating session transcript"),
        EventBroker(),
        make_settings(),
        session_service=session_service,
    )
    first = session_service.start_session("1", "Guild", "10", "First")
    session_service.append_utterance("existing-1", "1", "Ada", None, "First")
    speaker = Speaker(id="42", name="Ada")
    pcm = np.full((12000, 2), 1000, dtype="<i2").tobytes()

    await pipeline.start()
    pipeline.ingest_frame(speaker, pcm)
    second = session_service.start_session("1", "Guild", "20", "Second")
    session_service.append_utterance("existing-2", "2", "Linus", None, "Second")
    pipeline.finalize_all()
    await pipeline.wait_until_idle()

    first_result = session_service.get_full_session(first["session_id"])
    second_result = session_service.get_full_session(second["session_id"])
    assert first_result is not None
    assert second_result is not None
    assert [item["text"] for item in first_result["transcripts"]] == [
        "First",
        "originating session transcript",
    ]
    assert [item["text"] for item in second_result["transcripts"]] == ["Second"]
    await pipeline.stop()


@pytest.mark.asyncio
async def test_transcript_timing_comes_from_capture_not_whisper_completion(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setattr("backend.services.session.time.monotonic", lambda: 100.0)
    session_service = SessionService(storage_dir=tmp_path)
    broker = EventBroker()
    events = broker.subscribe()
    pipeline = TranscriptionPipeline(
        FakeWhisperEngine("capture timed transcript"),
        broker,
        make_settings(),
        session_service=session_service,
    )
    meta = session_service.start_session("1", "Guild", "10", "Channel")
    speaker = Speaker(id="42", name="Ada")
    pcm = np.full((12000, 2), 1000, dtype="<i2").tobytes()

    await pipeline.start()
    pipeline.ingest_frame(speaker, pcm, captured_at=102.5)
    pipeline.finalize_speaker(speaker.id)
    await pipeline.wait_until_idle()

    transcript_event = next(
        event for event in list(events._queue) if event["type"] == "transcript"
    )
    persisted = session_service.get_full_session(meta["session_id"])["transcripts"][0]
    expected_timestamp = (
        datetime.fromisoformat(meta["started_at"]) + timedelta(seconds=2.5)
    ).isoformat()
    assert transcript_event["start_seconds"] == 2.5
    assert transcript_event["end_seconds"] == 2.75
    assert persisted["start_seconds"] == 2.5
    assert persisted["end_seconds"] == 2.75
    assert persisted["timestamp"] == expected_timestamp
    await pipeline.stop()


@pytest.mark.asyncio
async def test_recording_failure_does_not_stop_transcription(tmp_path, monkeypatch):
    session_service = SessionService(storage_dir=tmp_path)
    broker = EventBroker()
    pipeline = TranscriptionPipeline(
        FakeWhisperEngine("recording-independent transcript"),
        broker,
        make_settings(),
        session_service=session_service,
    )
    meta = session_service.start_session("1", "Guild", "10", "Channel")
    monkeypatch.setattr(
        session_service,
        "_mix_recording_frame",
        MagicMock(side_effect=OSError("disk unavailable")),
    )
    speaker = Speaker(id="42", name="Ada")
    pcm = np.full((12000, 2), 1000, dtype="<i2").tobytes()

    await pipeline.start()
    pipeline.ingest_frame(
        speaker,
        pcm,
        captured_at=100.0,
        rtp_timestamp=10_000,
        rtp_sequence=100,
    )
    pipeline.finalize_speaker(speaker.id)
    await pipeline.wait_until_idle()

    detail = session_service.get_full_session(meta["session_id"])
    assert detail["transcripts"][0]["text"] == "recording-independent transcript"
    assert detail["recording"]["available"] is False
    await pipeline.stop()


@pytest.mark.asyncio
async def test_receiver_failure_drains_and_closes_session(tmp_path):
    engine = FakeWhisperEngine("receiver final transcript")
    broker = EventBroker()
    session_service = SessionService(storage_dir=tmp_path)
    pipeline = TranscriptionPipeline(
        engine,
        broker,
        make_settings(),
        session_service=session_service,
    )
    bot = DiscordBotService(
        token="token",
        pipeline=pipeline,
        broker=broker,
        session_service=session_service,
    )
    voice_client = FakeVoiceClient()
    bot._voice_client = voice_client
    meta = session_service.start_session("1", "Guild", "10", "Channel")
    speaker = Speaker(id="42", name="Ada")
    pcm = np.full((12000, 2), 1000, dtype="<i2").tobytes()

    await pipeline.start()
    pipeline.ingest_frame(speaker, pcm)
    bot._listen_done_on_loop(RuntimeError("receiver stopped"))
    while bot._cleanup_tasks:
        await asyncio.gather(*tuple(bot._cleanup_tasks))

    result = session_service.get_full_session(meta["session_id"])
    assert result is not None
    assert result["session"]["status"] == "closed"
    assert result["transcripts"][0]["text"] == "receiver final transcript"
    assert voice_client.disconnected is True
    assert bot.status()["state"] == "error"
    await pipeline.stop()


@pytest.mark.asyncio
async def test_shutdown_drains_finalized_audio_before_closing_session(tmp_path):
    engine = FakeWhisperEngine("shutdown final transcript")
    broker = EventBroker()
    session_service = SessionService(storage_dir=tmp_path)
    pipeline = TranscriptionPipeline(
        engine,
        broker,
        make_settings(),
        session_service=session_service,
    )
    bot = DiscordBotService(
        token="",
        pipeline=pipeline,
        broker=broker,
        session_service=session_service,
    )
    bot._voice_client = FakeVoiceClient()
    meta = session_service.start_session("1", "Guild", "10", "Channel")
    speaker = Speaker(id="42", name="Ada")
    pcm = np.full((12000, 2), 1000, dtype="<i2").tobytes()

    await pipeline.start()
    pipeline.ingest_frame(speaker, pcm)
    await bot.stop()
    await pipeline.stop()

    result = session_service.get_full_session(meta["session_id"])
    assert result is not None
    assert result["session"]["status"] == "closed"
    assert result["transcripts"][0]["text"] == "shutdown final transcript"


def test_ingest_frame_does_not_hide_programming_errors(monkeypatch):
    pipeline = TranscriptionPipeline(
        FakeWhisperEngine(),
        EventBroker(),
        make_settings(),
    )
    speaker = Speaker(id="42", name="Ada")
    monkeypatch.setattr(
        "backend.services.transcription.pcm_level",
        MagicMock(side_effect=TypeError("bad frame")),
    )

    with pytest.raises(TypeError, match="bad frame"):
        pipeline.ingest_frame(speaker, b"audio")


@pytest.mark.asyncio
async def test_discord_audio_sink_excludes_missing_users_bots_and_empty_frames():
    pipeline = MagicMock()
    sink = DiscordAudioSink(pipeline, asyncio.get_running_loop())
    human = SimpleNamespace(
        id=42,
        name="Ada",
        display_name="Ada",
        display_avatar=None,
        bot=False,
    )
    bot = SimpleNamespace(
        id=7,
        name="DTT",
        display_name="DTT",
        display_avatar=None,
        bot=True,
    )

    sink.write(None, SimpleNamespace(pcm=b"human audio"))
    sink.write(bot, SimpleNamespace(pcm=b"bot audio"))
    sink.write(human, SimpleNamespace(pcm=b""))
    await asyncio.sleep(0)

    pipeline.ingest_frame.assert_not_called()


@pytest.mark.asyncio
async def test_discord_audio_sink_forwards_rtp_timing(monkeypatch):
    monkeypatch.setattr(
        "backend.services.discord_audio.time.monotonic",
        lambda: 123.5,
    )
    pipeline = MagicMock()
    sink = DiscordAudioSink(pipeline, asyncio.get_running_loop())
    human = SimpleNamespace(
        id=42,
        name="Ada",
        display_name="Ada",
        display_avatar=None,
        bot=False,
    )
    packet = SimpleNamespace(timestamp=987_654, sequence=321)

    sink.write(human, SimpleNamespace(pcm=b"human audio", packet=packet))
    await asyncio.sleep(0)

    pipeline.ingest_frame.assert_called_once_with(
        Speaker(id="42", name="Ada"),
        b"human audio",
        123.5,
        987_654,
        321,
    )
