import importlib

from backend.core import config


def test_default_whisper_runtime_profile(monkeypatch):
    with monkeypatch.context() as environment:
        environment.delenv("WHISPER_MODEL", raising=False)
        environment.delenv("WHISPER_THREADS", raising=False)
        reloaded_config = importlib.reload(config)

        assert reloaded_config.settings.MODEL_NAME == "small"
        assert reloaded_config.settings.THREADS == 6

    importlib.reload(config)
