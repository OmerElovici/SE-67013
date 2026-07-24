import numpy as np
import soxr

DISCORD_SAMPLE_RATE = 48000
DISCORD_CHANNELS = 2


def pcm_level(pcm: bytes) -> float:
    """Return the normalized RMS level of Discord int16 stereo PCM."""
    samples = np.frombuffer(pcm, dtype="<i2")
    if samples.size == 0:
        return 0.0

    normalized = samples.astype(np.float32) / 32768.0
    return float(np.sqrt(np.mean(normalized * normalized)))


def discord_pcm_to_whisper(pcm: bytes, output_rate: int = 16000) -> np.ndarray:
    """Convert 48 kHz stereo int16 Discord PCM to mono float32 audio."""
    samples = np.frombuffer(pcm, dtype="<i2")
    usable_samples = samples.size - (samples.size % DISCORD_CHANNELS)
    if usable_samples == 0:
        return np.array([], dtype=np.float32)

    stereo = samples[:usable_samples].reshape(-1, DISCORD_CHANNELS)
    mono = stereo.astype(np.float32).mean(axis=1) / 32768.0
    resampled = soxr.resample(mono, DISCORD_SAMPLE_RATE, output_rate)
    return np.asarray(resampled, dtype=np.float32)
