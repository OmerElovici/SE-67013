import json
import subprocess
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from backend.api.v1.announcement import (
    get_announcement_status,
    remove_announcement,
    upload_announcement,
)
from backend.services.announcement import AnnouncementService
from backend.services.discord_bot import DiscordBotService


class FakeGuild:
    id = 123
    name = "Test Guild"


class FakeVoiceClient:
    def __init__(self, events: list[str]) -> None:
        self.channel = None
        self.events = events
        self.sink = None
        self.source = None
        self.after = None
        self._listening = False
        self.stop_listening_calls = 0
        self.play_error: Exception | None = None

    def is_connected(self) -> bool:
        return True

    def is_listening(self) -> bool:
        return self._listening

    def listen(self, sink, *, after) -> None:
        self.events.append("listen")
        self.sink = sink
        self.after = after
        self._listening = True

    def stop_listening(self) -> None:
        self.stop_listening_calls += 1
        self._listening = False

    def play(self, source) -> None:
        self.events.append("play")
        if self.play_error:
            raise self.play_error
        self.source = source


class FakeVoiceChannel:
    id = 456
    name = "Test Channel"
    guild = FakeGuild()

    def __init__(self, voice_client: FakeVoiceClient) -> None:
        self.voice_client = voice_client
        voice_client.channel = self

    async def connect(self, **kwargs) -> FakeVoiceClient:
        return self.voice_client


def ffprobe_result(
    *,
    duration: str = "5.0",
    codec_name: str = "mp3",
    format_name: str = "mp3",
) -> subprocess.CompletedProcess[str]:
    output = json.dumps(
        {
            "format": {"duration": duration, "format_name": format_name},
            "streams": [{"codec_name": codec_name}],
        }
    )
    return subprocess.CompletedProcess([], 0, stdout=output, stderr="")


def configured_service(tmp_path: Path, data: bytes = b"valid clip") -> AnnouncementService:
    service = AnnouncementService(storage_dir=tmp_path)
    with patch.object(service, "_inspect_duration", return_value=5.0):
        service.save_announcement(data)
    return service


async def connect_bot(
    announcement_service: AnnouncementService,
    voice_client: FakeVoiceClient,
    *,
    ffmpeg_side_effect: Exception | None = None,
) -> tuple[dict, object]:
    bot = DiscordBotService(
        token="token",
        pipeline=MagicMock(),
        broker=MagicMock(),
        announcement_service=announcement_service,
    )
    bot._ready.set()
    channel = FakeVoiceChannel(voice_client)
    bot._client.get_channel = MagicMock(return_value=channel)
    sink = object()
    source = object()

    def create_source(path: str):
        voice_client.events.append("ffmpeg")
        if ffmpeg_side_effect:
            raise ffmpeg_side_effect
        assert path == str(announcement_service.get_file_path())
        return source

    with (
        patch("backend.services.discord_bot.discord.VoiceChannel", FakeVoiceChannel),
        patch("backend.services.discord_bot.DiscordAudioSink", return_value=sink),
        patch(
            "backend.services.discord_bot.discord.FFmpegPCMAudio",
            side_effect=create_source,
        ),
    ):
        result = await bot.connect(FakeGuild.id, FakeVoiceChannel.id)

    return result, sink


def test_announcement_size_limit(tmp_path):
    service = configured_service(tmp_path, b"original clip")
    oversized = b"a" * (10 * 1024 * 1024 + 1)

    with pytest.raises(ValueError, match="10 MB limit"):
        service.save_announcement(oversized)

    assert service.get_file_path().read_bytes() == b"original clip"


def test_announcement_validation_and_lifecycle(tmp_path):
    service = AnnouncementService(storage_dir=tmp_path)
    assert service.get_status() == {
        "exists": False,
        "filename": None,
        "duration_seconds": None,
    }

    with patch.object(service, "_inspect_duration") as inspect_duration:
        inspect_duration.return_value = 5.0
        saved = service.save_announcement(b"first clip")
        assert saved == {
            "exists": True,
            "filename": "announcement.mp3",
            "duration_seconds": 5.0,
        }

        inspect_duration.return_value = 12.0
        replaced = service.save_announcement(b"replacement clip")
        assert replaced["duration_seconds"] == 12.0
        assert service.get_file_path().read_bytes() == b"replacement clip"

        inspect_duration.return_value = 35.0
        with pytest.raises(ValueError, match="30 seconds limit"):
            service.save_announcement(b"long clip")

        inspect_duration.return_value = 12.0
        assert service.get_status() == {
            "exists": True,
            "filename": "announcement.mp3",
            "duration_seconds": 12.0,
        }
        assert service.get_file_path().read_bytes() == b"replacement clip"

    assert service.remove_announcement() == {
        "exists": False,
        "filename": None,
        "duration_seconds": None,
    }
    assert service.get_file_path() is None


@pytest.mark.parametrize(
    ("probe_result", "expected_message"),
    [
        (ffprobe_result(codec_name="aac", format_name="mov"), "Invalid MP3"),
        (ffprobe_result(duration="31.0"), "30 seconds limit"),
    ],
)
def test_rejected_media_preserves_previous_clip(
    tmp_path,
    probe_result,
    expected_message,
):
    service = configured_service(tmp_path, b"original clip")

    with (
        patch(
            "backend.services.announcement.subprocess.run",
            return_value=probe_result,
        ),
        pytest.raises(ValueError, match=expected_message),
    ):
        service.save_announcement(b"rejected clip")

    assert service.get_file_path().read_bytes() == b"original clip"


def test_missing_ffprobe_preserves_previous_clip_and_status(tmp_path):
    service = configured_service(tmp_path, b"original clip")

    with patch(
        "backend.services.announcement.subprocess.run",
        side_effect=FileNotFoundError("ffprobe"),
    ):
        with pytest.raises(ValueError, match="Invalid MP3"):
            service.save_announcement(b"replacement clip")
        assert service.get_status() == {
            "exists": True,
            "filename": "announcement.mp3",
            "duration_seconds": None,
        }

    assert service.get_file_path().read_bytes() == b"original clip"


@pytest.mark.asyncio
async def test_announcement_api_routes(tmp_path):
    service = AnnouncementService(storage_dir=tmp_path)
    request = MagicMock()
    request.app.state.announcement_service = service

    status = await get_announcement_status(request)
    assert status["exists"] is False

    with patch.object(service, "_inspect_duration", return_value=3.5):
        request.body = AsyncMock(return_value=b"mp3_data")
        uploaded = await upload_announcement(request)
        assert uploaded["exists"] is True
        assert uploaded["duration_seconds"] == 3.5

    removed = await remove_announcement(request)
    assert removed["exists"] is False


@pytest.mark.asyncio
async def test_connection_plays_announcement_once_after_listening_starts(tmp_path):
    service = configured_service(tmp_path)
    events: list[str] = []
    voice_client = FakeVoiceClient(events)

    result, sink = await connect_bot(service, voice_client)

    assert result["connected"] is True
    assert events == ["listen", "ffmpeg", "play"]
    assert voice_client.sink is sink
    assert voice_client.source is not None
    assert voice_client.is_listening() is True
    assert voice_client.stop_listening_calls == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", [FileNotFoundError("ffmpeg"), RuntimeError("play")])
async def test_playback_tool_and_player_errors_do_not_affect_connection(
    tmp_path,
    failure,
):
    service = configured_service(tmp_path)
    voice_client = FakeVoiceClient([])
    if isinstance(failure, RuntimeError):
        voice_client.play_error = failure
        ffmpeg_error = None
    else:
        ffmpeg_error = failure

    result, sink = await connect_bot(
        service,
        voice_client,
        ffmpeg_side_effect=ffmpeg_error,
    )

    assert result["connected"] is True
    assert voice_client.sink is sink
    assert voice_client.is_listening() is True
    assert voice_client.stop_listening_calls == 0


@pytest.mark.asyncio
async def test_missing_media_does_not_affect_connection(tmp_path):
    service = AnnouncementService(storage_dir=tmp_path)
    voice_client = FakeVoiceClient([])

    result, sink = await connect_bot(service, voice_client)

    assert result["connected"] is True
    assert voice_client.events == ["listen"]
    assert voice_client.sink is sink
    assert voice_client.is_listening() is True
    assert voice_client.stop_listening_calls == 0


def test_file_lookup_error_is_nonfatal():
    announcement_service = MagicMock()
    announcement_service.get_file_path.side_effect = OSError("disk error")
    bot = DiscordBotService(
        token="",
        pipeline=MagicMock(),
        broker=MagicMock(),
        announcement_service=announcement_service,
    )
    voice_client = MagicMock()

    bot._play_announcement_if_configured(voice_client)

    voice_client.play.assert_not_called()
