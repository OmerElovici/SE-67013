# Backend service

FastAPI application that joins a Discord voice channel and transcribes each
speaker locally with Whisper.

Run all project commands from the repository root:

```console
just sync
just backend-dev
```

The backend reads `DISCORD_BOT_TOKEN`, `WHISPER_MODEL`, and `WHISPER_THREADS`
from `backend/.env`. The UI can then list the bot's available voice channels
and connect or disconnect it.

Discord PCM decoding requires native Opus. On macOS:

```console
brew install opus
```

Homebrew's Apple Silicon and Intel paths are detected automatically. Use
`DISCORD_OPUS_LIBRARY` only when Opus is installed somewhere else.

To verify Discord PCM reception without loading Whisper:

```console
just discord-smoke VOICE_CHANNEL_ID 10
```
