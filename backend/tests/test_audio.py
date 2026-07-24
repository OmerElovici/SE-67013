import numpy as np

from backend.services.audio import discord_pcm_to_whisper, pcm_level


def make_stereo_pcm(duration_seconds: float = 0.1) -> bytes:
    sample_count = int(48000 * duration_seconds)
    time = np.arange(sample_count, dtype=np.float32) / 48000
    mono = np.sin(2 * np.pi * 440 * time) * 0.5
    stereo = np.column_stack((mono, mono))
    return (stereo * 32767).astype("<i2").tobytes()


def test_discord_pcm_is_converted_for_whisper():
    converted = discord_pcm_to_whisper(make_stereo_pcm())

    assert converted.dtype == np.float32
    assert abs(len(converted) - 1600) <= 1
    assert np.max(np.abs(converted)) <= 1.0
    assert np.max(np.abs(converted)) > 0.4


def test_pcm_level_reports_silence_and_signal():
    assert pcm_level(bytes(3840)) == 0.0
    assert pcm_level(make_stereo_pcm()) > 0.3
