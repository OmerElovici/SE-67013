from types import SimpleNamespace

import davey
from discord.ext.voice_recv.opus import PacketDecoder
from discord.ext.voice_recv.rtp import OPUS_SILENCE
from discord.opus import Decoder, OpusError

from backend.services.discord_voice_recv import (
    ResilientPacketDecoder,
    decrypt_dave_audio,
)


class FakeDAVESession:
    ready = True

    def __init__(self):
        self.calls = []

    def decrypt(self, user_id, media_type, payload):
        self.calls.append((user_id, media_type, payload))
        return b"decrypted-opus"


class FailingDAVESession(FakeDAVESession):
    def __init__(self, reason):
        super().__init__()
        self.reason = reason

    def decrypt(self, user_id, media_type, payload):
        raise ValueError(f"Failed to decrypt: DecryptionFailed({self.reason})")


def make_voice_client(session, user_id=42, protocol_version=1):
    connection = SimpleNamespace(
        dave_session=session,
        dave_protocol_version=protocol_version,
    )
    return SimpleNamespace(
        _connection=connection,
        _get_id_from_ssrc=lambda _ssrc: user_id,
    )


def test_dave_audio_is_decrypted_for_the_packet_speaker():
    session = FakeDAVESession()
    client = make_voice_client(session)
    packet = SimpleNamespace(ssrc=7)

    result = decrypt_dave_audio(client, packet, b"encrypted-opus")

    assert result == b"decrypted-opus"
    assert session.calls == [(42, davey.MediaType.audio, b"encrypted-opus")]


def test_non_dave_audio_passes_through():
    session = FakeDAVESession()
    client = make_voice_client(session, protocol_version=0)

    result = decrypt_dave_audio(
        client,
        SimpleNamespace(ssrc=7),
        b"plain-opus",
    )

    assert result == b"plain-opus"
    assert session.calls == []


def test_packet_without_speaker_mapping_becomes_silence():
    session = FakeDAVESession()
    client = make_voice_client(session, user_id=None)

    result = decrypt_dave_audio(
        client,
        SimpleNamespace(ssrc=7),
        b"encrypted-opus",
    )

    assert result == OPUS_SILENCE
    assert session.calls == []


def test_unencrypted_packet_during_dave_transition_becomes_silence():
    client = make_voice_client(FailingDAVESession("UnencryptedWhenPassthroughDisabled"))

    result = decrypt_dave_audio(
        client,
        SimpleNamespace(ssrc=7),
        b"plain-opus",
    )

    assert result == OPUS_SILENCE


def test_packet_without_a_valid_dave_cryptor_becomes_silence():
    client = make_voice_client(
        FailingDAVESession(
            "NoValidCryptorFound { media_type: AUDIO, encrypted_size: 171 }"
        )
    )

    result = decrypt_dave_audio(
        client,
        SimpleNamespace(ssrc=7),
        b"encrypted-opus",
    )

    assert result == OPUS_SILENCE


def test_corrupt_opus_frame_is_replaced_with_silence(monkeypatch):
    error = OpusError.__new__(OpusError)

    def corrupt_frame(_decoder, _packet):
        raise error

    monkeypatch.setattr(PacketDecoder, "_decode_packet", corrupt_frame)
    decoder = ResilientPacketDecoder.__new__(ResilientPacketDecoder)
    decoder.ssrc = 123
    packet = SimpleNamespace(sequence=9)

    returned_packet, pcm = decoder._decode_packet(packet)

    assert returned_packet is packet
    assert pcm == bytes(Decoder.FRAME_SIZE)
