import asyncio
import os
import sys

import discord
from discord.ext import voice_recv

from backend.services.discord_voice_recv import DAVEVoiceRecvClient


class CountingSink(voice_recv.AudioSink):
    def __init__(self):
        super().__init__()
        self.frames = 0
        self.users: set[str] = set()

    def wants_opus(self) -> bool:
        return False

    def write(
        self,
        user: discord.Member | discord.User | None,
        data: voice_recv.VoiceData,
    ) -> None:
        if user and not user.bot and data.pcm:
            self.frames += 1
            self.users.add(str(user))


async def run(channel_id: int, seconds: float) -> None:
    token = os.getenv("DISCORD_BOT_TOKEN", "")
    if not token:
        raise RuntimeError("DISCORD_BOT_TOKEN is missing")

    intents = discord.Intents.none()
    intents.guilds = True
    intents.voice_states = True
    client = discord.Client(intents=intents)
    ready = asyncio.Event()

    @client.event
    async def on_ready():
        ready.set()

    runner = asyncio.create_task(client.start(token))
    voice_client = None
    try:
        await asyncio.wait_for(ready.wait(), timeout=15)
        channel = client.get_channel(channel_id)
        if not isinstance(channel, discord.VoiceChannel):
            raise TypeError("Voice channel was not found")

        voice_client = await channel.connect(
            cls=DAVEVoiceRecvClient,
            self_deaf=False,
        )
        sink = CountingSink()
        voice_client.listen(sink)
        print(f"Listening in {channel.guild.name} / {channel.name}")
        await asyncio.sleep(seconds)
        print(f"Received {sink.frames} PCM frames from {sorted(sink.users)}")
        if sink.frames == 0:
            raise RuntimeError("No PCM frames received; ask someone to speak")
    finally:
        if voice_client:
            if voice_client.is_listening():
                voice_client.stop_listening()
            await voice_client.disconnect(force=True)
        await client.close()
        await asyncio.gather(runner, return_exceptions=True)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("Usage: discord_voice CHANNEL_ID [SECONDS]")
    asyncio.run(
        run(
            channel_id=int(sys.argv[1]),
            seconds=float(sys.argv[2]) if len(sys.argv) > 2 else 10.0,
        )
    )
