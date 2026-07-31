from fastapi import APIRouter, HTTPException, Request

from backend.services.session import SessionService
from backend.services.vocabulary import VocabularyService

router = APIRouter(prefix="/sessions", tags=["sessions"])


def get_session_service(request: Request) -> SessionService:
    return request.app.state.session_service


def get_vocab_service(request: Request) -> VocabularyService:
    return request.app.state.vocabulary_service


@router.get("")
async def list_sessions(request: Request):
    session_svc = get_session_service(request)
    vocab_svc = get_vocab_service(request)

    active_meta = session_svc.get_active_session()
    all_sessions = session_svc.list_sessions(vocab_svc)
    past_sessions = [s for s in all_sessions if s.get("session_id") != session_svc.active_session_id]

    return {
        "active_session": active_meta,
        "past_sessions": past_sessions,
        "all_sessions": all_sessions,
    }


@router.get("/{session_id}")
async def get_session_detail(session_id: str, request: Request):
    session_svc = get_session_service(request)
    vocab_svc = get_vocab_service(request)

    result = session_svc.get_full_session(session_id, vocab_svc)
    if not result:
        raise HTTPException(status_code=404, detail="Session not found")
    return result
