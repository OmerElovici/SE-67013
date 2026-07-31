import json
import logging
import os
import subprocess
import tempfile
from pathlib import Path

logger = logging.getLogger(__name__)

MAX_SIZE_BYTES = 10 * 1024 * 1024  # 10 MB
MAX_DURATION_SECONDS = 30.0


class AnnouncementService:
    """Manages an optional local Discord connection announcement audio clip."""

    def __init__(self, storage_dir: str | Path | None = None) -> None:
        if storage_dir is None:
            storage_dir = Path(os.getenv("DATA_DIR", "data"))
        self._dir = Path(storage_dir)
        self._dir.mkdir(parents=True, exist_ok=True)
        self._file_path = self._dir / "announcement.mp3"

    def get_file_path(self) -> Path | None:
        if self._file_path.exists():
            return self._file_path
        return None

    def get_status(self) -> dict:
        path = self.get_file_path()
        if not path:
            return {"exists": False, "filename": None, "duration_seconds": None}

        duration = self._inspect_duration(path)
        return {
            "exists": True,
            "filename": path.name,
            "duration_seconds": duration,
        }

    def save_announcement(self, data: bytes) -> dict:
        if len(data) > MAX_SIZE_BYTES:
            raise ValueError("File size exceeds 10 MB limit")

        if not data:
            raise ValueError("File is empty")

        with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
            tmp.write(data)
            tmp_path = Path(tmp.name)

        try:
            duration = self._validate_and_get_duration(tmp_path)
            # Atomically replace target file
            tmp_path.replace(self._file_path)
            return {
                "exists": True,
                "filename": self._file_path.name,
                "duration_seconds": duration,
            }
        finally:
            if tmp_path.exists():
                tmp_path.unlink(missing_ok=True)

    def remove_announcement(self) -> dict:
        if self._file_path.exists():
            self._file_path.unlink()
        return {"exists": False, "filename": None, "duration_seconds": None}

    def _validate_and_get_duration(self, path: Path) -> float:
        duration = self._inspect_duration(path)
        if duration is None:
            raise ValueError("Invalid MP3 file format")
        if duration > MAX_DURATION_SECONDS:
            raise ValueError(f"Audio duration ({duration:.1f}s) exceeds 30 seconds limit")
        return duration

    def _inspect_duration(self, path: Path) -> float | None:
        try:
            cmd = [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_entries",
                "stream=codec_name:format=duration,format_name",
                "-of",
                "json",
                str(path),
            ]
            result = subprocess.run(cmd, capture_output=True, text=True, check=True)
            info = json.loads(result.stdout)
            format_info = info.get("format", {})
            duration_str = format_info.get("duration")

            streams = info.get("streams", [])
            codec_name = streams[0].get("codec_name", "") if streams else ""
            format_name = format_info.get("format_name", "")

            if "mp3" not in codec_name.lower() and "mp3" not in format_name.lower():
                return None

            if duration_str is not None:
                return float(duration_str)
            return None
        except Exception:  # noqa: BLE001
            return None
