import asyncio

import discord
from discord.ext import voice_recv

from backend.services.transcription import Speaker, TranscriptionPipeline


def speaker_from_member(member: discord.Member | discord.User) -> Speaker:
    display_name = getattr(member, "display_name", member.name)
    display_avatar = getattr(member, "display_avatar", None)
    avatar_url = str(display_avatar.url) if display_avatar else None
    return Speaker(
        id=str(member.id),
        name=display_name,
        avatar_url=avatar_url,
    )


class DiscordAudioSink(voice_recv.AudioSink):
    """Bridge discord-ext-voice-recv's thread into the asyncio pipeline."""

    def __init__(
        self,
        pipeline: TranscriptionPipeline,
        loop: asyncio.AbstractEventLoop,
    ):
        super().__init__()
        self._pipeline = pipeline
        self._loop = loop

    def wants_opus(self) -> bool:
        return False

    def write(
        self,
        user: discord.Member | discord.User | None,
        data: voice_recv.VoiceData,
    ) -> None:
        if user is None or user.bot or not data.pcm:
            return

        speaker = speaker_from_member(user)
        pcm = bytes(data.pcm)
        self._loop.call_soon_threadsafe(
            self._pipeline.ingest_frame,
            speaker,
            pcm,
        )

    def cleanup(self) -> None:
        pass
