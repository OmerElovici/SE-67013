import asyncio
import logging
from typing import Any

import discord

from backend.services.announcement import AnnouncementService
from backend.services.discord_audio import DiscordAudioSink
from backend.services.discord_voice_recv import DAVEVoiceRecvClient
from backend.services.events import EventBroker
from backend.services.session import SessionService
from backend.services.transcription import TranscriptionPipeline

logger = logging.getLogger(__name__)


class DTTDiscordClient(discord.Client):
    def __init__(self, service: "DiscordBotService", **options: Any):
        super().__init__(**options)
        self._service = service

    async def on_ready(self) -> None:
        self._service.handle_ready()

    async def on_resumed(self) -> None:
        self._service.publish_status()

    async def on_voice_state_update(
        self,
        member: discord.Member,
        before: discord.VoiceState,
        after: discord.VoiceState,
    ) -> None:
        if self.user and member.id == self.user.id:
            self._service.handle_bot_voice_state(after.channel)


class DiscordBotService:
    """Own the Discord gateway client and its single voice connection."""

    def __init__(
        self,
        token: str,
        pipeline: TranscriptionPipeline,
        broker: EventBroker,
        announcement_service: AnnouncementService | None = None,
        session_service: SessionService | None = None,
    ):
        intents = discord.Intents.none()
        intents.guilds = True
        intents.voice_states = True

        self._token = token
        self._pipeline = pipeline
        self._broker = broker
        self._announcement_service = announcement_service
        self._session_service = session_service
        self._client = DTTDiscordClient(self, intents=intents)
        self._runner: asyncio.Task[None] | None = None
        self._ready = asyncio.Event()
        self._connection_lock = asyncio.Lock()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._voice_client: DAVEVoiceRecvClient | None = None
        self._sink: DiscordAudioSink | None = None
        self._error: str | None = None
        self._state = "starting" if token else "error"

        if not token:
            self._error = "DISCORD_BOT_TOKEN is missing"

    def start(self) -> None:
        if not self._token or self._runner:
            self.publish_status()
            return

        self._loop = asyncio.get_running_loop()
        self._runner = asyncio.create_task(
            self._client.start(self._token),
            name="discord-gateway",
        )
        self._runner.add_done_callback(self._handle_runner_done)
        self.publish_status()

    async def stop(self) -> None:
        await self.disconnect()
        if not self._client.is_closed():
            await self._client.close()
        if self._runner:
            await asyncio.gather(self._runner, return_exceptions=True)

    def handle_ready(self) -> None:
        self._ready.set()
        self._error = None
        if self._voice_client and self._voice_client.is_connected():
            self._state = "connected"
        else:
            self._state = "ready"
        logger.info("Discord bot logged in as %s", self._client.user)
        self.publish_status()

    def handle_bot_voice_state(
        self,
        channel: discord.VoiceChannel | discord.StageChannel | None,
    ) -> None:
        if channel is None:
            self._pipeline.finalize_all()
            if self._session_service:
                self._session_service.end_session()
            self._voice_client = None
            self._sink = None
            self._state = "ready" if self._ready.is_set() else "starting"
        elif self._voice_client:
            self._state = "connected"
        self.publish_status()

    async def list_channels(self) -> list[dict[str, str]]:
        await self._require_ready()
        channels: list[dict[str, str]] = []
        for guild in sorted(
            self._client.guilds,
            key=lambda item: item.name.casefold(),
        ):
            for channel in sorted(
                guild.voice_channels,
                key=lambda item: (item.position, item.name.casefold()),
            ):
                channels.append(
                    {
                        "guild_id": str(guild.id),
                        "guild_name": guild.name,
                        "channel_id": str(channel.id),
                        "channel_name": channel.name,
                    }
                )
        return channels

    async def connect(
        self,
        guild_id: int,
        channel_id: int,
    ) -> dict[str, Any]:
        await self._require_ready()

        async with self._connection_lock:
            channel = self._client.get_channel(channel_id)
            if (
                channel is None
                or not isinstance(channel, discord.VoiceChannel)
                or channel.guild.id != guild_id
            ):
                raise ValueError("The selected Discord voice channel was not found")

            if (
                self._voice_client
                and self._voice_client.is_connected()
                and self._voice_client.channel.id == channel.id
            ):
                return self.status()

            if self._voice_client:
                await self._disconnect_unlocked()

            self._state = "connecting"
            self._error = None
            self.publish_status()

            voice_client: DAVEVoiceRecvClient | None = None
            try:
                voice_client = await channel.connect(
                    cls=DAVEVoiceRecvClient,
                    self_deaf=False,
                )
                self._voice_client = voice_client
                loop = asyncio.get_running_loop()
                self._sink = DiscordAudioSink(self._pipeline, loop)
                voice_client.listen(
                    self._sink,
                    after=self._handle_listen_done,
                )
                if self._session_service:
                    self._session_service.start_session(
                        guild_id=channel.guild.id,
                        guild_name=channel.guild.name,
                        channel_id=channel.id,
                        channel_name=channel.name,
                    )
                self._play_announcement_if_configured(voice_client)
                self._state = "connected"
                self.publish_status()
                return self.status()
            except Exception as error:
                if voice_client:
                    await voice_client.disconnect(force=True)
                self._voice_client = None
                self._sink = None
                self._state = "error"
                self._error = f"Could not join voice channel: {error}"
                self.publish_status()
                raise

    async def disconnect(self) -> dict[str, Any]:
        async with self._connection_lock:
            await self._disconnect_unlocked()
            return self.status()

    async def _disconnect_unlocked(self) -> None:
        voice_client = self._voice_client
        self._state = "disconnecting"
        self.publish_status()

        self._pipeline.finalize_all()
        if self._session_service:
            self._session_service.end_session()
        self._voice_client = None
        self._sink = None

        if voice_client:
            try:
                if voice_client.is_listening():
                    voice_client.stop_listening()
                await voice_client.disconnect(force=True)
            except Exception:
                logger.exception("Failed to cleanly disconnect Discord voice")

        if not self._token:
            self._state = "error"
            self._error = "DISCORD_BOT_TOKEN is missing"
        else:
            self._state = "ready" if self._ready.is_set() else "starting"
            self._error = None
        self.publish_status()

    def status(self) -> dict[str, Any]:
        voice_client = self._voice_client
        channel = (
            voice_client.channel
            if voice_client and voice_client.is_connected()
            else None
        )
        guild = channel.guild if channel else None
        return {
            "state": self._state,
            "bot_ready": self._ready.is_set(),
            "bot_name": str(self._client.user) if self._client.user else None,
            "connected": channel is not None,
            "guild_id": str(guild.id) if guild else None,
            "guild_name": guild.name if guild else None,
            "channel_id": str(channel.id) if channel else None,
            "channel_name": channel.name if channel else None,
            "error": self._error,
        }

    def publish_status(self) -> None:
        self._broker.publish({"type": "status", **self.status()})

    async def _require_ready(self) -> None:
        if not self._token:
            raise RuntimeError("DISCORD_BOT_TOKEN is missing")
        try:
            await asyncio.wait_for(self._ready.wait(), timeout=15)
        except TimeoutError as error:
            raise RuntimeError("Discord bot is not ready") from error

    def _handle_listen_done(self, error: Exception | None) -> None:
        if self._loop is None or self._loop.is_closed():
            return
        self._loop.call_soon_threadsafe(self._listen_done_on_loop, error)

    def _listen_done_on_loop(self, error: Exception | None) -> None:
        if error:
            error_type = type(error).__name__
            error_message = (
                str(error).strip()
                or str(getattr(error, "message", "")).strip()
                or repr(error)
            )
            logger.error(
                "Discord voice receiver stopped: %s: %r",
                error_type,
                error,
            )
            self._pipeline.finalize_all()
            self._error = (
                f"Discord audio receiver stopped: {error_type}: {error_message}"
            )
            self._state = "error"
            self.publish_status()

    def _handle_runner_done(self, task: asyncio.Task[None]) -> None:
        if task.cancelled():
            return
        error = task.exception()
        if error:
            logger.error("Discord gateway stopped: %s", error)
            self._error = f"Discord bot stopped: {error}"
            self._state = "error"
            self.publish_status()

    def _play_announcement_if_configured(self, voice_client: DAVEVoiceRecvClient) -> None:
        if not self._announcement_service:
            return
        try:
            path = self._announcement_service.get_file_path()
            if not path or not voice_client.is_connected():
                return
            audio_source = discord.FFmpegPCMAudio(str(path))
            voice_client.play(audio_source)
        except Exception:
            logger.exception("Failed to play connection announcement clip")
