import numpy as np
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from backend.services.whisper import WhisperEngine
from backend.core.config import settings

router = APIRouter()

# Initialize the engine once at startup
print(f"Loading Whisper model '{settings.MODEL_NAME}' on CPU...")
engine = WhisperEngine(model_name=settings.MODEL_NAME, n_threads=settings.THREADS)
print("Whisper model loaded successfully.")

@router.websocket("/transcribe")
async def transcribe_websocket(websocket: WebSocket):
    await websocket.accept()
    
    # Audio buffer for the current segment
    active_buffer = np.array([], dtype=np.float32)
    
    # Track samples received since last transcription
    samples_since_last_transcribe = 0
    
    # Transcribe interval: 0.5s
    TRANSCRIBE_EVERY_SAMPLES = int(0.5 * settings.SAMPLE_RATE)
    
    # Silence detection: 1.5s window
    SILENCE_DURATION_SAMPLES = int(1.5 * settings.SAMPLE_RATE)
    SILENCE_THRESHOLD = 0.015
    
    # Force finalize after 15s to keep buffers responsive
    MAX_BUFFER_SAMPLES = int(15.0 * settings.SAMPLE_RATE)
    
    try:
        while True:
            data = await websocket.receive_bytes()
            if not data:
                continue
                
            # Decode chunk (float32 array)
            chunk = np.frombuffer(data, dtype=np.float32)
            active_buffer = np.concatenate([active_buffer, chunk])
            samples_since_last_transcribe += len(chunk)
            
            # Run model periodically
            if samples_since_last_transcribe >= TRANSCRIBE_EVERY_SAMPLES:
                samples_since_last_transcribe = 0
                
                # Transcribe current buffer
                text = engine.transcribe(active_buffer)
                
                # Clean text from whisper artifacts
                import re
                text = re.sub(r'\[BLANK_AUDIO\]', '', text, flags=re.IGNORECASE).strip()
                
                # Check for silence to finalize the segment
                finalized = False
                
                if len(active_buffer) >= SILENCE_DURATION_SAMPLES:
                    recent_audio = active_buffer[-SILENCE_DURATION_SAMPLES:]
                    rms = np.sqrt(np.mean(recent_audio ** 2))
                    
                    if rms < SILENCE_THRESHOLD and len(text) > 0:
                        finalized = True
                
                if len(active_buffer) >= MAX_BUFFER_SAMPLES:
                    finalized = True
                    
                await websocket.send_json({
                    "text": text,
                    "finalized": finalized
                })
                
                if finalized:
                    # Reset buffer for next utterance
                    active_buffer = np.array([], dtype=np.float32)
                    
    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"Error in transcription websocket: {e}")
