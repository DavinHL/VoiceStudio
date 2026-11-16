"""Tests for matching a take's register to its reference (#3935).

The model clones a reference's delivery but not reliably its register: the same
text and reference land anywhere from 189 to 261 Hz against a 184.6 Hz
reference, which users hear as "sometimes right, sometimes too high". These
tests pin the tracker, the two guards that keep it off artifacts, and the
safety net that discards a shift which did not land closer.

The fixtures are REAL takes, not synthesised tones. See ``tests/fixtures`` for
why a synthetic harmonic series cannot be used: it is more periodic at a
multiple of its period than at the period itself, so a correct detector answers
an octave or a twelfth below the frequency it was built for. Three attempts to
test against one produced readings 12 to 19 semitones off.
"""

from __future__ import annotations

import math

import numpy as np
import pytest
import torch

from fixtures import HIGH, LOW, MID, REF, TAKE_HIGH_HZ, TAKE_MID_HZ, path
from services import audio_dsp as dsp

SR = 24000


def _load(name: str) -> torch.Tensor:
    """A fixture as a (1, n) float32 tensor, the shape the stage receives."""
    import soundfile as sf

    audio, _ = sf.read(path(name))
    clip = torch.from_numpy(np.asarray(audio, dtype=np.float32))
    return clip.unsqueeze(0) if clip.dim() == 1 else clip


def _mono(tensor: torch.Tensor) -> np.ndarray:
    if tensor.dim() > 1:
        tensor = tensor.mean(dim=0)
    return tensor.to(torch.float64).detach().numpy()


def _semitones(a: float, b: float) -> float:
    return 12.0 * math.log2(a / b) if a > 0.0 and b > 0.0 else float("nan")


class TestMeasurePitch:
    def test_reads_each_real_register(self):
        """The four fixtures measure what they were recorded at."""
        for name, expected in ((LOW, 154.84), (MID, 184.62), (HIGH, 260.87)):
            measured = dsp.measure_pitch_hz(_load(name), SR)
            assert abs(_semitones(measured, expected)) < 0.6, f"{name}"

    def test_keeps_a_low_voice_in_its_own_octave(self):
        """154.84 Hz is a low voice, not a 77 Hz one and not a 310 Hz one.

        The octave error is the failure mode that matters here: answering a
        multiple of the period reads as "too high" or "too low" to a listener,
        which is the whole defect being corrected.
        """
        measured = dsp.measure_pitch_hz(_load(LOW), SR)
        assert abs(_semitones(measured, TAKE_HIGH_HZ)) > 6.0

    def test_silence_has_no_pitch(self):
        assert dsp.measure_pitch_hz(torch.zeros(1, SR), SR) == 0.0

    def test_an_empty_tensor_has_no_pitch(self):
        assert dsp.measure_pitch_hz(torch.zeros(0), SR) == 0.0

    def test_a_clip_too_short_to_hold_a_period_has_no_pitch(self):
        assert dsp.measure_pitch_hz(torch.zeros(1, int(SR * 0.01)), SR) == 0.0

    def test_the_median_holds_the_base_register_across_a_signal(self):
        """Real takes move in pitch; the reading is their centre, not an edge."""
        clip = _load(MID)
        measured = dsp.measure_pitch_hz(clip, SR)
        half = clip.shape[-1] // 2
        first = dsp.measure_pitch_hz(clip[..., :half], SR)
        second = dsp.measure_pitch_hz(clip[..., half:], SR)
        assert abs(_semitones(measured, TAKE_MID_HZ)) < 0.6
        assert abs(_semitones(first, measured)) < 3.0
        assert abs(_semitones(second, measured)) < 3.0


class TestHarmonicShare:
    """The voiced guard: a voice spreads energy over a harmonic stack."""

    def test_real_takes_score_well_above_the_guard(self):
        for name in (LOW, MID, HIGH, REF):
            clip = _load(name)
            f0 = dsp.measure_pitch_hz(clip, SR)
            share = dsp._harmonic_share(_mono(clip), SR, f0)
            assert share > dsp._PITCH_MIN_HARMONIC_SHARE, f"{name}: {share:.3f}"

    def test_a_pure_tone_off_the_fundamental_is_caught_by_the_other_guard(self):
        """A tone can sit on a harmonic by accident, so this guard alone misses it.

        Measured: a 612 Hz tone read against a 184 Hz fundamental scores 42.5%
        — above the 25% guard, because 612 Hz is close to 184 x 3.3 and enough
        of its energy lands in the harmonic bins. What catches that shape is the
        body guard, which asks whether the take has energy at its OWN measured
        fundamental. Both guards are needed; this test records the division of
        labour rather than pretending either is sufficient.
        """
        t = torch.arange(SR, dtype=torch.float32) / SR
        tone = (0.4 * torch.sin(2 * math.pi * 612.0 * t)).to(torch.float64).numpy()
        assert dsp._harmonic_share(tone, SR, 184.0) > dsp._PITCH_MIN_HARMONIC_SHARE
        assert dsp._body_share(tone, SR, 184.0) < dsp._PITCH_MIN_BODY_SHARE

    def test_a_broadband_hiss_is_caught_by_the_body_guard(self):
        """White noise spreads energy evenly, so it lands on harmonics by chance.

        Measured: 32.9% of a flat noise floor falls inside the harmonic bins of
        a 184 Hz fundamental — a seventh of the spectrum, times the bins' width.
        The harmonic guard alone would pass it. The body guard does not, because
        noise carries no energy specifically at the reading it produced.
        """
        rng = np.random.default_rng(9)
        hiss = rng.normal(0, 0.3, SR).astype(np.float64)
        assert dsp._body_share(hiss, SR, 184.0) < dsp._PITCH_MIN_BODY_SHARE

    def test_an_unmeasurable_fundamental_scores_zero(self):
        assert dsp._harmonic_share(_mono(_load(MID)), SR, 0.0) == 0.0

    def test_silence_scores_zero(self):
        assert dsp._harmonic_share(torch.zeros(SR).numpy(), SR, 184.0) == 0.0


class TestBodyShare:
    """The subharmonic guard: a real voice keeps energy at its fundamental."""

    def test_real_takes_keep_their_own_fundamental(self):
        """Measured on the fixtures: 5.75% and up, the guard sits at 2%."""
        for name in (LOW, MID, HIGH, REF):
            clip = _load(name)
            f0 = dsp.measure_pitch_hz(clip, SR)
            share = dsp._body_share(_mono(clip), SR, f0)
            assert share > dsp._PITCH_MIN_BODY_SHARE, f"{name}: {share:.4f}"

    def test_a_subharmonic_reading_has_no_body(self):
        """The measured shape behind the takes that got worse.

        A series rooted at 724 Hz that the tracker answered at 347.8 Hz, with
        0.00% of its energy below 300 Hz. Correcting that reading moved the
        register further from the reference.
        """
        t = torch.arange(SR, dtype=torch.float32) / SR
        tone = torch.zeros_like(t)
        for f in (724.0, 1086.0, 1448.0):
            tone += (0.3 / (f / 724.0)) * torch.sin(2 * math.pi * f * t)
        samples = tone.to(torch.float64).numpy()
        assert dsp._body_share(samples, SR, 347.8) < dsp._PITCH_MIN_BODY_SHARE

    def test_the_same_series_at_its_real_root_is_voiced(self):
        t = torch.arange(SR, dtype=torch.float32) / SR
        tone = torch.zeros_like(t)
        for f in (724.0, 1086.0, 1448.0):
            tone += (0.3 / (f / 724.0)) * torch.sin(2 * math.pi * f * t)
        samples = tone.to(torch.float64).numpy()
        assert dsp._body_share(samples, SR, 724.0) > dsp._PITCH_MIN_BODY_SHARE

    def test_an_unmeasurable_fundamental_scores_zero(self):
        assert dsp._body_share(_mono(_load(MID)), SR, 0.0) == 0.0

    def test_the_guard_separates_the_two_populations(self):
        """Real takes measured 5.75-20.45%; subharmonic reads 0.00-0.01%."""
        assert 0.01 < dsp._PITCH_MIN_BODY_SHARE < 5.75
        assert 0.01 < dsp._PITCH_MIN_HARMONIC_SHARE < 0.299


class TestMatchReferencePitch:
    def test_brings_a_high_take_down_to_the_reference(self):
        """The reported defect: a take a register above the clip it clones."""
        reference = path(MID)
        take = _load(HIGH)

        out = dsp.match_reference_pitch(take, SR, reference)

        moved = dsp.measure_pitch_hz(out, SR)
        assert abs(_semitones(moved, TAKE_MID_HZ)) < abs(_semitones(TAKE_HIGH_HZ, TAKE_MID_HZ))
        assert abs(_semitones(moved, TAKE_MID_HZ)) < 1.0

    def test_brings_a_low_take_up_to_the_reference(self):
        """A rise the clamp allows: 154.84 to 184.62 Hz is +3.1 semitones."""
        take = _load(LOW)

        out = dsp.match_reference_pitch(take, SR, path(MID))

        moved = dsp.measure_pitch_hz(out, SR)
        assert abs(_semitones(moved, TAKE_MID_HZ)) < 1.0

    def test_a_rise_beyond_the_clamp_stops_at_the_clamp(self):
        """154.84 to 260.87 Hz is +9 semitones; 6 is the most this stage moves."""
        take = _load(LOW)

        out = dsp.match_reference_pitch(take, SR, path(HIGH))

        moved = dsp.measure_pitch_hz(out, SR)
        rose = _semitones(moved, 154.84)
        assert 6.0 - 0.6 <= rose <= 6.0 + 0.6
        assert abs(_semitones(moved, TAKE_HIGH_HZ)) < 4.0

    def test_keeps_the_duration(self):
        take = _load(HIGH)
        out = dsp.match_reference_pitch(take, SR, path(MID))
        assert out.shape == take.shape

    def test_does_not_compound(self):
        """A second pass sees the corrected register and leaves it alone."""
        reference = path(MID)
        once = dsp.match_reference_pitch(_load(HIGH), SR, reference)
        twice = dsp.match_reference_pitch(once, SR, reference)
        assert abs(_semitones(dsp.measure_pitch_hz(twice, SR), TAKE_MID_HZ)) < 1.0

    def test_the_move_is_bounded(self):
        """An unusual reference must not drag a take an octave away."""
        take = _load(HIGH)
        out = dsp.match_reference_pitch(take, SR, path(LOW), max_semitones=3.0)
        moved = abs(_semitones(dsp.measure_pitch_hz(out, SR), TAKE_HIGH_HZ))
        assert moved <= 3.0 + 0.6

    def test_an_already_matched_take_is_left_alone(self):
        """Same register as the reference: nothing worth a phase vocoder."""
        reference = path(MID)
        take = _load(MID)
        out = dsp.match_reference_pitch(take, SR, reference)
        assert torch.equal(out, take)

    def test_a_shift_that_moves_away_is_discarded(self, monkeypatch):
        """The safety net: verify the result instead of trusting the vocoder."""
        monkeypatch.setattr(dsp, "_shift_pitch", lambda tensor, rate, steps: tensor * 1.0)
        take = _load(HIGH)
        out = dsp.match_reference_pitch(take, SR, path(MID))
        assert torch.equal(out, take)

    def test_no_reference_is_a_no_op(self):
        take = _load(HIGH)
        assert torch.equal(dsp.match_reference_pitch(take, SR, None), take)

    def test_a_missing_reference_file_is_a_no_op(self, tmp_path):
        take = _load(HIGH)
        out = dsp.match_reference_pitch(take, SR, str(tmp_path / "nope.wav"))
        assert torch.equal(out, take)

    def test_a_silent_reference_is_a_no_op(self, tmp_path):
        import soundfile as sf

        silent = tmp_path / "silent.wav"
        sf.write(str(silent), np.zeros(SR * 2, dtype=np.float32), SR)
        take = _load(HIGH)
        assert torch.equal(dsp.match_reference_pitch(take, SR, str(silent)), take)

    def test_an_empty_take_is_a_no_op(self):
        empty = torch.zeros(0)
        assert torch.equal(dsp.match_reference_pitch(empty, SR, path(MID)), empty)

    def test_a_broken_reference_never_raises(self, tmp_path):
        broken = tmp_path / "broken.wav"
        broken.write_bytes(b"not audio at all")
        take = _load(HIGH)
        out = dsp.match_reference_pitch(take, SR, str(broken))
        assert out.shape == take.shape

    def test_is_deterministic(self):
        reference = path(MID)
        take = _load(HIGH)
        once = dsp.match_reference_pitch(take, SR, reference)
        twice = dsp.match_reference_pitch(take, SR, reference)
        assert torch.equal(once, twice)


class TestPitchMatchEnabled:
    def test_on_by_default(self, monkeypatch):
        monkeypatch.delenv(dsp.PITCH_MATCH_ENV, raising=False)
        monkeypatch.setattr("core.prefs.resolve", lambda *a, **k: "on")
        assert dsp.pitch_match_enabled() is True

    @pytest.mark.parametrize("value", ["off", "0", "false", "no", "OFF", "Off"])
    def test_off_values_disable_it(self, monkeypatch, value):
        monkeypatch.setenv(dsp.PITCH_MATCH_ENV, value)
        assert dsp.pitch_match_enabled() is False

    @pytest.mark.parametrize("value", ["on", "1", "true", "yes"])
    def test_on_values_keep_it(self, monkeypatch, value):
        monkeypatch.setenv(dsp.PITCH_MATCH_ENV, value)
        assert dsp.pitch_match_enabled() is True

    def test_an_empty_value_falls_back_to_the_default(self, monkeypatch):
        """``""`` means "not set here", so the caller's default still wins."""
        monkeypatch.setenv(dsp.PITCH_MATCH_ENV, "")
        monkeypatch.setattr("core.prefs.resolve", lambda *a, **k: "")
        assert dsp.pitch_match_enabled() is True

    def test_an_unreadable_setting_keeps_the_default(self, monkeypatch):
        def boom(*a, **k):
            raise RuntimeError("prefs unavailable")

        monkeypatch.setattr("core.prefs.resolve", boom)
        assert dsp.pitch_match_enabled() is True
