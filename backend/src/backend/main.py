import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.api.v1.discord_voice import router as discord_router
from backend.core.config import settings
from backend.services.discord_bot import DiscordBotService
from backend.services.events import EventBroker
from backend.services.transcription import TranscriptionPipeline
from backend.services.whisper import WhisperEngine

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Loading Whisper model '%s' on CPU", settings.MODEL_NAME)
    engine = await asyncio.to_thread(
        WhisperEngine,
        model_name=settings.MODEL_NAME,
        n_threads=settings.THREADS,
    )
    broker = EventBroker()
    pipeline = TranscriptionPipeline(engine, broker, settings)
    discord_service = DiscordBotService(
        settings.DISCORD_BOT_TOKEN,
        pipeline,
        broker,
    )

    app.state.event_broker = broker
    app.state.transcription_pipeline = pipeline
    app.state.discord_service = discord_service

    await pipeline.start()
    discord_service.start()
    logger.info("Whisper model loaded successfully")

    try:
        yield
    finally:
        await discord_service.stop()
        await pipeline.stop()


app = FastAPI(
    title=settings.PROJECT_NAME,
    openapi_url=f"{settings.API_V1_STR}/openapi.json",
    lifespan=lifespan,
)

# CORS configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register versioned routes
app.include_router(discord_router, prefix=settings.API_V1_STR)


@app.get("/")
async def root():
    return {"message": "Discord to Text API is running", "docs": "/docs"}
