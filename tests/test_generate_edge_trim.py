"""Generated takes must not start or end with the engine's own silence padding.

Engines pad every render with near-silence at both ends; only the dub path
trimmed it, so every Generate / OpenAI-API take opened and closed on a blank.
"""
from types import SimpleNamespace

import pytest
import torch

import services.audio_dsp as dsp
from api.routers import generation as gen
from api.routers import openai_compat as oc

SR = 1000  # 1 sample per ms keeps the arithmetic readable
HEAD = dsp.HEAD_MARGIN_MS  # context kept before the first sound
TAIL = dsp.TAIL_MARGIN_MS  # ...and after the last one, to keep a word's release
MARGIN = HEAD + TAIL  # total samples a trimmed take keeps around its speech


def _padded(lead=400, speech=1000, tail=600):
    """[1, n] take: `lead` ms of engine silence, speech, `tail` ms of silence."""
    return torch.cat([torch.zeros(1, lead), torch.full((1, speech), 0.5),
                      torch.zeros(1, tail)], dim=-1)


@pytest.fixture
def no_dsp(monkeypatch):
    # Isolate the trim from mastering / pedalboard: both become identity.
    monkeypatch.setattr(dsp, "apply_mastering", lambda a, sample_rate=None: a)
    monkeypatch.setattr(dsp, "apply_effects_chain", lambda a, sample_rate, chain: a)


def test_whole_take_trim_strips_engine_padding(no_dsp):
    out = gen._apply_effect_chain(_padded(), SR, "broadcast", trim_edges=True)
    assert out.shape[-1] == 1000 + HEAD + TAIL


def test_trimmed_take_opens_on_its_sound(no_dsp):
    # #3926: the engine's leading block of digital silence used to survive as
    # 50 ms of blank before the first word, which read as a clipped opening.
    out = gen._apply_effect_chain(_padded(), SR, "broadcast", trim_edges=True)
    # Only the head context is silent; the speech starts right after it.
    assert torch.all(out[..., :HEAD] == 0)
    assert torch.all(out[..., HEAD:HEAD + 100] != 0)


def test_head_context_outlasts_a_consonant_attack():
    # The trim is cut against a voicing floor, and a consonant spends its first
    # tens of milliseconds below that floor. A 2 ms head margin therefore sliced
    # into the sound itself ("Hmmm" arrived as "mmm"), so the context kept has
    # to cover a realistic attack, not just the sample that first crosses the
    # floor.
    assert dsp.HEAD_MARGIN_MS >= 40
    # A ramp that climbs from silence crosses the floor 1 ms in (its very first
    # step is already above -50 dBFS), so the trim can only find the attack if
    # the retained context reaches back before it.
    attack, speech, lead = 30, 200, 400
    ramp = torch.cat([torch.linspace(0, 0.5, attack).unsqueeze(0),
                      torch.full((1, speech), 0.5)], dim=-1)
    padded = torch.cat([torch.zeros(1, lead), ramp], dim=-1)
    out = dsp.trim_speech_padding(padded, SR)
    # The floor is met at the ramp's first step (lead + 1), so the take opens
    # HEAD samples before it and keeps the ramp inside that context.
    assert out.shape[-1] == padded.shape[-1] - (lead + 1 - HEAD)
    assert torch.all(out[..., :HEAD] == 0)
    # The attack survives sample for sample, quietest steps included, so the
    # first sound ramps in instead of starting part-way up. The quietest step
    # is the ramp's first one, which is the whole point of the wider margin.
    assert torch.equal(out[..., (lead + 1) - (lead + 1 - HEAD):], padded[..., lead + 1:])
    assert out[..., HEAD] == ramp[..., 1] < ramp[..., attack - 1]


def test_preview_chunks_and_raw_keep_their_edges(no_dsp):
    assert gen._apply_effect_chain(_padded(), SR, "broadcast").shape[-1] == 2000
    assert gen._apply_effect_chain(_padded(), SR, "raw", trim_edges=True).shape[-1] == 2000


def test_dead_render_is_not_shrunk(no_dsp):
    silent = torch.zeros(1, 2000)
    assert gen._apply_effect_chain(silent, SR, "broadcast", trim_edges=True).shape[-1] == 2000


@pytest.mark.parametrize("preset,duration,expected", [
    ("broadcast", None, True), (None, None, True), ("raw", None, False),
    ("broadcast", 5.0, False),
])
def test_wants_edge_trim(preset, duration, expected):
    assert gen._wants_edge_trim(preset, duration) is expected


def test_pause_spans_trimmed_so_requested_pause_is_exact():
    segs = [("", 300), ("hello", 500), ("world", 200)]
    out = gen._render_with_pauses(lambda t: _padded(), segs, SR, trim_spans=True)
    span = 1000 + HEAD + TAIL
    # Deliberate leading and trailing pauses survive; engine padding does not.
    assert out.shape[-1] == 300 + span + 500 + span + 200
    assert torch.all(out[:, :300] == 0)
    assert torch.all(out[:, -200:] == 0)


def test_pause_spans_untrimmed_by_default():
    out = gen._render_with_pauses(lambda t: _padded(), [("hi", 0)], SR)
    assert out.shape[-1] == 2000


class _Backend:
    sample_rate = SR
    applies_own_mastering = True

    def generate(self, text, **kw):
        return _padded()


@pytest.fixture
def openai_tts(monkeypatch):
    import services.watermark as wm
    monkeypatch.setattr(wm, "mark_synthetic", lambda w, sr, **k: w)
    return lambda kw: oc._run_tts(_Backend(), "hi", kw)[0]


def test_openai_speech_trims_edges(openai_tts):
    assert openai_tts({}).shape[-1] == 1000 + HEAD + TAIL


def test_openai_speech_keeps_explicit_duration(openai_tts):
    assert openai_tts({"duration": 2.0}).shape[-1] == 2000
