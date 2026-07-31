import os
import re
from pathlib import Path


class VocabularyService:
    """Manages local newline-delimited banned words and performs text redaction."""

    def __init__(self, storage_path: str | Path | None = None) -> None:
        if storage_path is None:
            base_dir = Path(os.getenv("DATA_DIR", "data"))
            storage_path = base_dir / "banned_words.txt"
        self._path = Path(storage_path)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._words: list[str] = []
        self._load()

    def _load(self) -> None:
        if self._path.exists():
            content = self._path.read_text(encoding="utf-8")
            self._words = self._parse_words(content)
        else:
            self._words = []

    @staticmethod
    def _parse_words(text: str) -> list[str]:
        lines = [line.strip() for line in text.splitlines()]
        return [line for line in lines if line]

    def get_raw_text(self) -> str:
        return "\n".join(self._words)

    def get_words(self) -> list[str]:
        return list(self._words)

    def set_raw_text(self, text: str) -> list[str]:
        words = self._parse_words(text)
        self._words = words
        self._path.write_text("\n".join(words), encoding="utf-8")
        return list(self._words)

    def redact(self, text: str) -> str:
        if not text or not self._words:
            return text

        # Sort terms by length descending so longer phrases match first
        sorted_terms = sorted(self._words, key=len, reverse=True)

        result = text
        for term in sorted_terms:
            escaped = re.escape(term)
            pattern = re.compile(rf"(?<!\w){escaped}(?!\w)", flags=re.IGNORECASE)
            result = pattern.sub("****", result)

        return result
