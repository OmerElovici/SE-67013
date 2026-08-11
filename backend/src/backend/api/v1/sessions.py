import asyncio
from collections import deque

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse

from backend.services.audio import DISCORD_CHANNELS, DISCORD_SAMPLE_RATE
from backend.services.session import SessionService
from backend.services.vocabulary import VocabularyService

router = APIRouter(prefix="/sessions", tags=["sessions"])

_AUDIO_CHUNK_SIZE = 64 * 1024
_AUDIO_MAX_UNCONFIRMED = 1024 * 1024
_AUDIO_SAMPLE_WIDTH = 2
_AUDIO_FRAME_WIDTH = DISCORD_CHANNELS * _AUDIO_SAMPLE_WIDTH


def get_session_service(request: Request) -> SessionService:
    return request.app.state.session_service


def get_vocab_service(request: Request) -> VocabularyService:
    return request.app.state.vocabulary_service


@router.get("")
async def list_sessions(request: Request):
    session_svc = get_session_service(request)
    vocab_svc = get_vocab_service(request)

    active_meta = session_svc.get_active_session(vocab_svc)
    all_sessions = session_svc.list_sessions(vocab_svc)
    past_sessions = [s for s in all_sessions if s.get("session_id") != session_svc.active_session_id]

    return {
        "active_session": active_meta,
        "past_sessions": past_sessions,
        "all_sessions": all_sessions,
    }


@router.get("/{session_id}/audio")
async def get_session_audio(session_id: str, request: Request):
    session_svc = get_session_service(request)
    recording = session_svc.get_recording_info(session_id)
    recording_path = session_svc.get_recording_path(session_id)
    if not recording["available"] or recording_path is None:
        raise HTTPException(status_code=404, detail="Session recording unavailable")
    return FileResponse(
        recording_path,
        media_type="audio/wav",
        headers={"Cache-Control": "no-store"},
    )


@router.websocket("/{session_id}/audio/stream")
async def stream_session_audio(session_id: str, websocket: WebSocket):
    """Stream durable active-session PCM with resumable byte offsets."""
    await websocket.accept()
    session_svc: SessionService = websocket.app.state.session_service
    if session_svc.active_session_id != session_id:
        await websocket.close(code=1008, reason="Session is not active")
        return
    if not session_svc.open_recording_stream(session_id):
        await websocket.close(code=1008, reason="Session is not active")
        return

    try:
        try:
            resume = await asyncio.wait_for(websocket.receive_json(), timeout=5)
        except (TimeoutError, ValueError):
            await websocket.close(code=1008, reason="Invalid resume request")
            return
        offset = resume.get("offset") if isinstance(resume, dict) else None
        revision = resume.get("revision") if isinstance(resume, dict) else None
        if (
            not isinstance(resume, dict)
            or resume.get("type") != "resume"
            or not isinstance(offset, int)
            or isinstance(offset, bool)
            or offset < 0
            or offset % _AUDIO_FRAME_WIDTH
            or not isinstance(revision, int)
            or isinstance(revision, bool)
            or revision < 0
        ):
            await websocket.close(code=1008, reason="Invalid resume request")
            return

        state = session_svc.get_recording_stream_state(
            session_id,
            after_revision=revision,
        )
        if (
            state is None
            or offset > state["captured_bytes"]
            or revision > state["revision"]
        ):
            await websocket.close(code=1008, reason="Invalid resume offset")
            return

        reset = not state["history_complete"] or any(
            mutation["offset"] < offset for mutation in state["mutations"]
        )
        if reset:
            offset = 0
        sent_offset = offset
        observed_revision = state["revision"]
        outstanding: deque[tuple[int, int]] = deque()
        pending_replacements: deque[dict[str, int]] = deque()
        pending_replacement_bytes = 0
        unconfirmed_bytes = 0
        next_message_id = 1
        await websocket.send_json(
            {
                "type": "ready",
                "session_id": session_id,
                "offset": offset,
                "captured_bytes": state["captured_bytes"],
                "revision": observed_revision,
                "reset": reset,
                "sample_rate": DISCORD_SAMPLE_RATE,
                "channels": DISCORD_CHANNELS,
                "sample_width": _AUDIO_SAMPLE_WIDTH,
            }
        )

        while True:
            state = session_svc.get_recording_stream_state(
                session_id,
                after_revision=observed_revision,
            )
            active = session_svc.active_session_id == session_id
            if state is None:
                if active:
                    await websocket.send_json(
                        {"type": "error", "message": "Recording unavailable"}
                    )
                    await websocket.close(code=1011)
                else:
                    await websocket.send_json(
                        {
                            "type": "complete",
                            "offset": sent_offset,
                            "url": f"/sessions/{session_id}/audio",
                        }
                    )
                    await websocket.close()
                return

            if not state["history_complete"]:
                await websocket.close(code=1013, reason="Stream resync required")
                return

            for mutation in state["mutations"]:
                replacement_end = min(
                    mutation["offset"] + mutation["size"],
                    sent_offset,
                )
                if replacement_end > mutation["offset"]:
                    pending_replacements.append(
                        {
                            "offset": mutation["offset"],
                            "size": replacement_end - mutation["offset"],
                            "revision": mutation["revision"],
                        }
                    )
                    pending_replacement_bytes += replacement_end - mutation["offset"]
            if pending_replacement_bytes > _AUDIO_MAX_UNCONFIRMED:
                await websocket.close(code=1013, reason="Stream resync required")
                return
            observed_revision = state["revision"]
            captured = state["captured_bytes"]

            capacity = _AUDIO_MAX_UNCONFIRMED - unconfirmed_bytes
            replacement = pending_replacements[0] if pending_replacements else None
            chunk_offset = replacement["offset"] if replacement else sent_offset
            available = replacement["size"] if replacement else captured - sent_offset
            if available > 0 and capacity >= _AUDIO_FRAME_WIDTH:
                chunk_size = min(_AUDIO_CHUNK_SIZE, available, capacity)
                chunk_size -= chunk_size % _AUDIO_FRAME_WIDTH
                chunk = session_svc.read_recording_data(
                    session_id,
                    chunk_offset,
                    chunk_size,
                )
                if not chunk:
                    await websocket.send_json(
                        {"type": "error", "message": "Recording unavailable"}
                    )
                    await websocket.close(code=1011)
                    return
                await websocket.send_json(
                    {
                        "type": "chunk",
                        "id": next_message_id,
                        "offset": chunk_offset,
                        "size": len(chunk),
                        "revision": (
                            replacement["revision"]
                            if replacement
                            else observed_revision
                        ),
                    }
                )
                await websocket.send_bytes(chunk)
                outstanding.append((next_message_id, len(chunk)))
                unconfirmed_bytes += len(chunk)
                next_message_id += 1
                if replacement:
                    replacement["offset"] += len(chunk)
                    replacement["size"] -= len(chunk)
                    pending_replacement_bytes -= len(chunk)
                    if replacement["size"] == 0:
                        pending_replacements.popleft()
                else:
                    sent_offset += len(chunk)

            if (
                not active
                and sent_offset >= captured
                and not pending_replacements
                and not outstanding
                and observed_revision >= state["revision"]
            ):
                await websocket.send_json(
                    {
                        "type": "complete",
                        "offset": sent_offset,
                        "url": f"/sessions/{session_id}/audio",
                    }
                )
                await websocket.close()
                return

            try:
                message = await asyncio.wait_for(
                    websocket.receive_json(),
                    timeout=0.05,
                )
            except TimeoutError:
                continue
            except ValueError:
                await websocket.close(code=1008, reason="Invalid acknowledgement")
                return

            acknowledged = message.get("id") if isinstance(message, dict) else None
            if (
                not isinstance(message, dict)
                or message.get("type") != "ack"
                or not isinstance(acknowledged, int)
                or isinstance(acknowledged, bool)
                or not outstanding
                or acknowledged != outstanding[0][0]
            ):
                await websocket.close(code=1008, reason="Invalid acknowledgement")
                return
            _, acknowledged_size = outstanding.popleft()
            unconfirmed_bytes -= acknowledged_size
    except (WebSocketDisconnect, RuntimeError):
        return
    finally:
        session_svc.close_recording_stream(session_id)


@router.get("/{session_id}")
async def get_session_detail(session_id: str, request: Request):
    session_svc = get_session_service(request)
    vocab_svc = get_vocab_service(request)

    result = session_svc.get_full_session(session_id, vocab_svc)
    if not result:
        raise HTTPException(status_code=404, detail="Session not found")
    if result["recording"]["available"]:
        result["recording"]["url"] = f"/sessions/{session_id}/audio"
        if result["session"]["status"] == "active":
            result["recording"]["stream_url"] = (
                f"/sessions/{session_id}/audio/stream"
            )
    return result
