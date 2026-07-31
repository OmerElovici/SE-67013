from fastapi import APIRouter, Request
from pydantic import BaseModel

from backend.services.vocabulary import VocabularyService

router = APIRouter(prefix="/vocabulary", tags=["vocabulary"])


class VocabularyPayload(BaseModel):
    raw_text: str


def get_vocabulary_service(request: Request) -> VocabularyService:
    return request.app.state.vocabulary_service


@router.get("")
async def get_vocabulary(request: Request):
    service = get_vocabulary_service(request)
    return {"raw_text": service.get_raw_text(), "words": service.get_words()}


@router.post("")
async def update_vocabulary(payload: VocabularyPayload, request: Request):
    service = get_vocabulary_service(request)
    words = service.set_raw_text(payload.raw_text)
    return {"raw_text": service.get_raw_text(), "words": words}
