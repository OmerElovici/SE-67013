from unittest.mock import MagicMock

import pytest

from backend.api.v1.vocabulary import (
    VocabularyPayload,
    get_vocabulary,
    update_vocabulary,
)
from backend.services.vocabulary import VocabularyService


def test_vocabulary_service_redaction(tmp_path):
    vocab_file = tmp_path / "banned_words.txt"
    service = VocabularyService(storage_path=vocab_file)
    service.set_raw_text("ass\nshut up\nheck")

    # Case insensitivity
    assert service.redact("This is an ASS test") == "This is an **** test"
    # Substring inside another word must NOT be redacted
    assert service.redact("class assemble pass") == "class assemble pass"
    # Multi-word phrase matching
    assert service.redact("Please SHUT UP now!") == "Please **** now!"
    # Exact word with punctuation
    assert service.redact("What the heck?") == "What the ****?"
    # Re-loading from disk retains entries
    new_service = VocabularyService(storage_path=vocab_file)
    assert new_service.get_words() == ["ass", "shut up", "heck"]
    assert new_service.redact("ass") == "****"


@pytest.mark.asyncio
async def test_vocabulary_api(tmp_path):
    vocab_file = tmp_path / "banned_words.txt"
    service = VocabularyService(storage_path=vocab_file)
    request = MagicMock()
    request.app.state.vocabulary_service = service

    res1 = await get_vocabulary(request)
    assert res1["words"] == []

    res2 = await update_vocabulary(VocabularyPayload(raw_text="badword\nanother phrase"), request)
    assert res2["words"] == ["badword", "another phrase"]

    res3 = await get_vocabulary(request)
    assert res3["words"] == ["badword", "another phrase"]
