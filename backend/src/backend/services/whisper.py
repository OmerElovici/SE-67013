import os

import numpy as np
from pywhispercpp.model import Model


class WhisperEngine:
    def __init__(
        self,
        model_name: str = "tiny",
        models_dir: str | None = None,
        n_threads: int = 4,
    ):
        """
        Initializes the whisper.cpp model.

        Args:
            model_name: The whisper model to use (e.g. 'tiny', 'base.en', etc.)
            models_dir: Directory where models are downloaded and cached.
            n_threads: Number of CPU threads to use for transcription.
        """
        if not models_dir:
            # Place models in a "models" folder inside the workspace root
            models_dir = os.path.abspath(
                os.path.join(
                    os.path.dirname(__file__), "..", "..", "..", "..", "models"
                )
            )

        os.makedirs(models_dir, exist_ok=True)
        self.model = Model(
            model=model_name,
            models_dir=models_dir,
            n_threads=n_threads,
            print_progress=False,
            print_realtime=False,
            print_special=False,
            print_timestamps=False,
        )

    def transcribe(self, audio_data: np.ndarray) -> str:
        """
        Transcribes a 1-dimensional float32 numpy array sampled at 16000 Hz.

        Args:
            audio_data: np.ndarray of shape (N,) and dtype np.float32

        Returns:
            String of concatenated transcribed segments.
        """
        if len(audio_data) == 0:
            return ""

        segments = self.model.transcribe(audio_data)
        text = " ".join(seg.text for seg in segments).strip()
        return text
