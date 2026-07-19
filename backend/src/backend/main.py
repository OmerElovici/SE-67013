from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from backend.core.config import settings
from backend.api.v1.transcribe import router as transcribe_router

app = FastAPI(
    title=settings.PROJECT_NAME,
    openapi_url=f"{settings.API_V1_STR}/openapi.json"
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
app.include_router(transcribe_router, prefix=settings.API_V1_STR)

@app.get("/")
async def root():
    return {
        "message": "Whisper Live Transcribe API is running",
        "docs": "/docs"
    }
