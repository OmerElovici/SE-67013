import os

DEFAULT_WHISPER_MODEL = "small"
DEFAULT_WHISPER_THREADS = 6


class Settings:
    PROJECT_NAME: str = "Discord to Text API"
    API_V1_STR: str = "/v1"

    # Discord Settings
    DISCORD_BOT_TOKEN: str = os.getenv("DISCORD_BOT_TOKEN", "")

    # Transcription Settings
    MODEL_NAME: str = os.getenv("WHISPER_MODEL", DEFAULT_WHISPER_MODEL)
    SAMPLE_RATE: int = 16000
    THREADS: int = int(os.getenv("WHISPER_THREADS", str(DEFAULT_WHISPER_THREADS)))
    PARTIAL_INTERVAL_SECONDS: float = 1.0
    SILENCE_SECONDS: float = 1.0
    MAX_UTTERANCE_SECONDS: float = 15.0
    AUDIO_LEVEL_THRESHOLD: float = 0.008

settings = Settings()
