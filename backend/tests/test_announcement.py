from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from backend.api.v1.announcement import (
    get_announcement_status,
    remove_announcement,
    upload_announcement,
)
from backend.services.announcement import AnnouncementService
from backend.services.discord_bot import DiscordBotService


def test_announcement_size_limit(tmp_path):
    service = AnnouncementService(storage_dir=tmp_path)
    oversized = b"a" * (10 * 1024 * 1024 + 1)
    with pytest.raises(ValueError, match="10 MB limit"):
        service.save_announcement(oversized)


def test_announcement_validation_and_lifecycle(tmp_path):
    service = AnnouncementService(storage_dir=tmp_path)

    # Initial status
    assert service.get_status() == {"exists": False, "filename": None, "duration_seconds": None}

    # Mock ffprobe duration inspection
    with patch.object(service, "_inspect_duration") as mock_inspect:
        mock_inspect.return_value = 5.0
        res = service.save_announcement(b"fake_mp3_content")
        assert res["exists"] is True
        assert res["duration_seconds"] == 5.0

        # Replace with another valid file
        mock_inspect.return_value = 12.0
        res2 = service.save_announcement(b"new_mp3_content")
        assert res2["duration_seconds"] == 12.0

        # Attempt to upload oversized duration file -> rejected, previous file kept
        mock_inspect.return_value = 35.0
        with pytest.raises(ValueError, match="30 seconds limit"):
            service.save_announcement(b"long_mp3_content")

        # Previous file still intact
        mock_inspect.return_value = 12.0
        status = service.get_status()
        assert status["exists"] is True
        assert status["duration_seconds"] == 12.0

        # Remove announcement
        removed = service.remove_announcement()
        assert removed["exists"] is False
        assert service.get_file_path() is None


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


def test_silent_connection_fallback_on_playback_error():
    bot = DiscordBotService(token="", pipeline=MagicMock(), broker=MagicMock())
    voice_client = MagicMock()
    voice_client.is_connected.return_value = True

    announcement_svc = MagicMock()
    announcement_svc.get_file_path.side_effect = Exception("Disk error")
    bot._announcement_service = announcement_svc

    # Should not raise exception
    bot._play_announcement_if_configured(voice_client)
