import logging
import os
from collections.abc import Callable
from ctypes.util import find_library
from pathlib import Path
from typing import Any

import davey
import discord
from discord.ext import voice_recv
from discord.ext.voice_recv.opus import PacketDecoder
from discord.ext.voice_recv.reader import AudioReader
from discord.ext.voice_recv.router import PacketRouter
from discord.ext.voice_recv.rtp import OPUS_SILENCE
from discord.opus import Decoder, OpusError

logger = logging.getLogger(__name__)


def ensure_opus_loaded() -> None:
    """Load the native Opus decoder used by discord.py on macOS."""
    if discord.opus.is_loaded():
        return

    configured_path = os.getenv("DISCORD_OPUS_LIBRARY", "")
    candidates = [
        configured_path,
        find_library("opus"),
        "/opt/homebrew/opt/opus/lib/libopus.dylib",
        "/usr/local/opt/opus/lib/libopus.dylib",
    ]
    errors = []

    for candidate in candidates:
        if not candidate:
            continue
        if "/" in candidate and not Path(candidate).exists():
            continue
        try:
            discord.opus.load_opus(candidate)
        except OSError as error:
            errors.append(f"{candidate}: {error}")
            continue
        if discord.opus.is_loaded():
            logger.info("Loaded Discord Opus decoder from %s", candidate)
            return

    detail = f" Tried: {'; '.join(errors)}" if errors else ""
    raise RuntimeError(
        "Discord's native Opus decoder is unavailable. "
        "On macOS run `brew install opus`, or set DISCORD_OPUS_LIBRARY."
        f"{detail}"
    )


def decrypt_dave_audio(
    voice_client: voice_recv.VoiceRecvClient,
    packet: Any,
    opus: bytes,
) -> bytes:
    """Remove Discord's DAVE layer after RTP transport decryption."""
    connection = voice_client._connection
    session = connection.dave_session
    if session is None or connection.dave_protocol_version == 0 or not session.ready:
        return opus

    user_id = voice_client._get_id_from_ssrc(packet.ssrc)
    if user_id is None:
        return OPUS_SILENCE

    try:
        return session.decrypt(user_id, davey.MediaType.audio, opus)
    except Exception as error:  # noqa: BLE001
        detail = repr(error)
        transient_errors = (
            "NoValidCryptorFound",
            "UnencryptedWhenPassthroughDisabled",
        )
        log = (
            logger.debug
            if any(name in detail for name in transient_errors)
            else logger.warning
        )
        log(
            "Dropping DAVE audio packet from user %s: %s: %r",
            user_id,
            type(error).__name__,
            error,
        )

        # Never pass a packet that failed authenticated decryption into Opus.
        # DAVE key transitions should cost one 20 ms frame, not the receiver.
        return OPUS_SILENCE


class DAVEAudioReader(AudioReader):
    """AudioReader that adds the DAVE layer missing from voice-recv 0.5."""

    def __init__(
        self,
        sink: voice_recv.AudioSink,
        voice_client: voice_recv.VoiceRecvClient,
        *,
        after: Callable[[Exception | None], Any] | None = None,
    ):
        super().__init__(sink, voice_client, after=after)
        self.packet_router = ResilientPacketRouter(sink, self)
        transport_decrypt = self.decryptor.decrypt_rtp

        def decrypt_rtp(packet: Any) -> bytes:
            opus = transport_decrypt(packet)
            return decrypt_dave_audio(voice_client, packet, opus)

        self.decryptor.decrypt_rtp = decrypt_rtp


class ResilientPacketDecoder(PacketDecoder):
    """Keep a speaker stream alive when one Opus frame is malformed."""

    def _decode_packet(self, packet: Any) -> tuple[Any, bytes]:
        try:
            return super()._decode_packet(packet)
        except OpusError as error:
            logger.warning(
                "Dropping corrupt Opus frame for SSRC %s, sequence %s: %s",
                self.ssrc,
                getattr(packet, "sequence", "unknown"),
                error,
            )
            return packet, bytes(Decoder.FRAME_SIZE)


class ResilientPacketRouter(PacketRouter):
    """Create an independent fault-tolerant decoder for every SSRC."""

    def get_decoder(self, ssrc: int) -> PacketDecoder:
        with self._lock:
            decoder = self.decoders.get(ssrc)
            if decoder is None:
                decoder = self.decoders[ssrc] = ResilientPacketDecoder(
                    self,
                    ssrc,
                )
            return decoder


class DAVEVoiceRecvClient(voice_recv.VoiceRecvClient):
    """Voice receive client compatible with discord.py 2.7 DAVE sessions."""

    def listen(
        self,
        sink: voice_recv.AudioSink,
        *,
        after: Callable[[Exception | None], Any] | None = None,
    ) -> None:
        ensure_opus_loaded()
        if not self.is_connected():
            raise discord.ClientException("Not connected to voice.")
        if not isinstance(sink, voice_recv.AudioSink):
            raise TypeError(f"sink must be an AudioSink not {sink.__class__.__name__}")
        if self.is_listening():
            raise discord.ClientException("Already receiving audio.")

        self._reader = DAVEAudioReader(sink, self, after=after)
        self._reader.start()
