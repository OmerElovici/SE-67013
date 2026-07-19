import os

class Settings:
    PROJECT_NAME: str = "Whisper Live Transcribe API"
    API_V1_STR: str = "/v1"
    
    # Transcription Settings
    MODEL_NAME: str = os.getenv("WHISPER_MODEL", "tiny")
    SAMPLE_RATE: int = 16000
    THREADS: int = int(os.getenv("WHISPER_THREADS", "4"))

settings = Settings()
