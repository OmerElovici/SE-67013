# Backend service

FastAPI application that joins a Discord voice channel and transcribes each
speaker locally with Whisper.

Run all project commands from the repository root:

```console
just sync
just backend-dev
```

The backend reads `DISCORD_BOT_TOKEN` from `backend/.env`. The UI can then list
the bot's available voice channels and connect or disconnect it.

Local speech-to-text defaults to the Whisper `small` model with six worker
threads. Override the model with `WHISPER_MODEL` and the thread count with
`WHISPER_THREADS`. Compared with the `tiny` and `base` models, `small` generally
requires more CPU time and memory in exchange for better transcription quality.
Six threads can produce sustained CPU load; lower the thread count when sharing
the machine with other workloads, at the cost of slower transcription.

Whisper is independent of report generation. Reports use Ollama at
`OLLAMA_BASE_URL` with `OLLAMA_MODEL`, which defaults to `qwen3:8b`. Changing the
Ollama model does not change speech-to-text behavior or resource use.

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
