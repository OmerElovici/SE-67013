import os


class Settings:
    PROJECT_NAME: str = "Discord to Text API"
    API_V1_STR: str = "/v1"

    # Discord Settings
    DISCORD_BOT_TOKEN: str = os.getenv("DISCORD_BOT_TOKEN", "")

    # Transcription Settings
    MODEL_NAME: str = os.getenv("WHISPER_MODEL", "small")
    SAMPLE_RATE: int = 16000
    THREADS: int = int(os.getenv("WHISPER_THREADS", "6"))
    PARTIAL_INTERVAL_SECONDS: float = 1.0
    SILENCE_SECONDS: float = 1.0
    MAX_UTTERANCE_SECONDS: float = 15.0
    AUDIO_LEVEL_THRESHOLD: float = 0.008

    # Ollama Settings
    OLLAMA_BASE_URL: str = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
    OLLAMA_MODEL: str = os.getenv("OLLAMA_MODEL", "qwen3:8b")


settings = Settings()
