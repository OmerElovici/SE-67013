import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.api.v1.announcement import router as announcement_router
from backend.api.v1.discord_voice import router as discord_router
from backend.api.v1.reports import router as reports_router
from backend.api.v1.sessions import router as sessions_router
from backend.api.v1.vocabulary import router as vocabulary_router
from backend.core.config import settings
from backend.services.announcement import AnnouncementService
from backend.services.discord_bot import DiscordBotService
from backend.services.events import EventBroker
from backend.services.report import ReportService
from backend.services.session import SessionService
from backend.services.transcription import TranscriptionPipeline
from backend.services.vocabulary import VocabularyService
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
    vocabulary_service = VocabularyService()
    announcement_service = AnnouncementService()
    session_service = SessionService()
    report_service = ReportService(
        session_service=session_service,
        vocabulary_service=vocabulary_service,
        settings=settings,
    )
    broker = EventBroker()
    pipeline = TranscriptionPipeline(
        engine=engine,
        broker=broker,
        settings=settings,
        vocabulary_service=vocabulary_service,
        session_service=session_service,
    )
    discord_service = DiscordBotService(
        token=settings.DISCORD_BOT_TOKEN,
        pipeline=pipeline,
        broker=broker,
        announcement_service=announcement_service,
        session_service=session_service,
    )

    app.state.event_broker = broker
    app.state.transcription_pipeline = pipeline
    app.state.discord_service = discord_service
    app.state.vocabulary_service = vocabulary_service
    app.state.announcement_service = announcement_service
    app.state.session_service = session_service
    app.state.report_service = report_service

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
app.include_router(vocabulary_router, prefix=settings.API_V1_STR)
app.include_router(announcement_router, prefix=settings.API_V1_STR)
app.include_router(sessions_router, prefix=settings.API_V1_STR)
app.include_router(reports_router, prefix=settings.API_V1_STR)


@app.get("/")
async def root():
    return {"message": "Discord to Text API is running", "docs": "/docs"}
