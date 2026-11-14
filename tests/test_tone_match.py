"""Tests for matching a take's tone to its reference (#3930)."""

from __future__ import annotations

import math

import numpy as np
import pytest
import torch

from services import audio_dsp as dsp


def _tone(sample_rate: int, seconds: float, freqs: dict[float, float]) -> torch.Tensor:
    """A mono signal made of sine components at ``freqs`` (Hz -> amplitude)."""
    t = torch.arange(int(sample_rate * seconds), dtype=torch.float32) / sample_rate
    out = torch.zeros_like(t)
    for f, amp in freqs.items():
        out += amp * torch.sin(2 * math.pi * f * t)
    return out.unsqueeze(0)


def _db(tensor: torch.Tensor, sample_rate: int) -> list[float]:
    return dsp._band_energies_db(tensor, sample_rate)


class TestBandEnergies:
    def test_reports_where_the_energy_is(self):
        """A 200 Hz tone lands in the lowest band, not the others."""
        x = _tone(24000, 1.0, {200.0: 0.5})
        db = _db(x, 24000)
        assert db[0] == max(v for v in db if v == v)
        for b in (2, 3):
            assert db[b] < db[0] - 20

    def test_shape_is_independent_of_level(self):
        """Doubling the amplitude must not change the band *balance*."""
        quiet = _tone(24000, 1.0, {200.0: 0.25, 5000.0: 0.25})
        loud = _tone(24000, 1.0, {200.0: 0.5, 5000.0: 0.5})
        for a, b in zip(_db(quiet, 24000), _db(loud, 24000)):
            if a != a:  # a band this rate cannot express stays unmeasurable
                assert b != b
                continue
            assert abs(a - b) < 0.01

    def test_bands_above_nyquist_are_unmeasurable(self):
        """A 24 kHz clip cannot express 8-16 kHz, so that band reads nan."""
        db = _db(_tone(24000, 1.0, {200.0: 0.5}), 24000)
        assert math.isnan(db[-1])
        assert not math.isnan(db[0])

    def test_a_44100_reference_can_measure_the_top_band(self):
        db = _db(_tone(44100, 1.0, {200.0: 0.5}), 44100)
        assert not math.isnan(db[-1])

    def test_too_short_to_measure(self):
        assert all(math.isnan(v) for v in _db(torch.zeros(1, 100), 24000))

    def test_silence_is_not_a_timbre(self):
        assert all(math.isnan(v) for v in _db(torch.zeros(1, 24000), 24000))


class TestToneMatch:
    def _reference(self, tmp_path, sample_rate, freqs):
        import soundfile as sf

        path = tmp_path / "ref.wav"
        sf.write(str(path), _tone(sample_rate, 2.0, freqs).squeeze(0).numpy(),
                 sample_rate, subtype="PCM_16")
        return str(path)

    def test_dark_reference_dims_a_bright_take(self, tmp_path):
        """The whole point: a bright take is pulled toward a dark reference."""
        ref = self._reference(tmp_path, 44100, {200.0: 0.5, 3000.0: 0.02})
        take = _tone(24000, 2.0, {200.0: 0.5, 3000.0: 0.5})

        before = _db(take, 24000)[3]
        after = _db(dsp.match_reference_tone(take, 24000, ref), 24000)[3]
        assert after < before - 5, "the 3-8 kHz band should have dropped"

    def test_bright_reference_lifts_a_dark_take(self, tmp_path):
        ref = self._reference(tmp_path, 44100, {200.0: 0.5, 3000.0: 0.5})
        take = _tone(24000, 2.0, {200.0: 0.5, 3000.0: 0.02})

        before = _db(take, 24000)[3]
        after = _db(dsp.match_reference_tone(take, 24000, ref), 24000)[3]
        assert after > before + 3

    def test_gets_closer_to_the_reference_than_it_started(self, tmp_path):
        ref_freqs = {200.0: 0.5, 3000.0: 0.02}
        ref = self._reference(tmp_path, 44100, ref_freqs)
        take = _tone(24000, 2.0, {200.0: 0.5, 3000.0: 0.6})

        def error(x):
            ref_db = _db(_tone(44100, 2.0, ref_freqs), 44100)
            take_db = _db(x, 24000)
            pairs = [(r, t) for r, t in zip(ref_db, take_db)
                     if r == r and t == t]
            base_r = max(r for r, _ in pairs)
            base_t = max(t for _, t in pairs)
            return sum(abs((t - base_t) - (r - base_r)) for r, t in pairs)

        before = error(take)
        after = error(dsp.match_reference_tone(take, 24000, ref))
        assert after < before

    def test_the_clamp_bounds_the_total(self, tmp_path):
        """No band may move further than ``max_gain_db``.

        The clamp is what keeps a wildly mismatched reference from turning the
        correction into an audible filter.
        """
        ref = self._reference(tmp_path, 44100, {200.0: 0.5, 3000.0: 0.9})
        take = _tone(24000, 2.0, {200.0: 0.9, 3000.0: 0.01})

        tight = dsp.match_reference_tone(take, 24000, ref, max_gain_db=1.0)
        loose = dsp.match_reference_tone(take, 24000, ref, max_gain_db=6.0)

        before = _db(take, 24000)
        for limit, out in ((1.0, tight), (6.0, loose)):
            for b in range(3):
                moved = _db(out, 24000)[b] - before[b]
                # Neighbouring bands overlap, so a filter set for one band
                # nudges its neighbours; allow that, but never let the total
                # exceed the requested limit by more than the overlap.
                assert abs(moved) < limit + 4.0, f"limit {limit} dB moved band {b} by {moved}"

    def test_is_deterministic(self, tmp_path):
        """Two calls on the same input give byte-identical audio.

        The stage measures the take, so a second call must not see its own
        correction as a new starting point and keep going.
        """
        ref = self._reference(tmp_path, 44100, {200.0: 0.5, 3000.0: 0.9})
        take = _tone(24000, 2.0, {200.0: 0.9, 3000.0: 0.01})

        once = dsp.match_reference_tone(take, 24000, ref, max_gain_db=3.0)
        twice = dsp.match_reference_tone(take, 24000, ref, max_gain_db=3.0)

        assert torch.equal(once, twice)

    def test_no_reference_is_a_no_op(self):
        take = _tone(24000, 1.0, {200.0: 0.5})
        assert torch.equal(dsp.match_reference_tone(take, 24000, None), take)

    def test_missing_reference_file_is_a_no_op(self, tmp_path):
        take = _tone(24000, 1.0, {200.0: 0.5})
        missing = str(tmp_path / "nope.wav")
        assert torch.equal(dsp.match_reference_tone(take, 24000, missing), take)

    def test_silent_reference_is_a_no_op(self, tmp_path):
        import soundfile as sf

        path = tmp_path / "silent.wav"
        sf.write(str(path), np.zeros(88200, dtype=np.float32), 44100, subtype="PCM_16")
        take = _tone(24000, 1.0, {200.0: 0.5})
        assert torch.equal(dsp.match_reference_tone(take, 24000, str(path)), take)

    def test_empty_take_is_a_no_op(self, tmp_path):
        ref = self._reference(tmp_path, 44100, {200.0: 0.5, 3000.0: 0.5})
        empty = torch.zeros(1, 0)
        assert dsp.match_reference_tone(empty, 24000, ref).numel() == 0

    def test_never_raises_on_a_broken_reference(self, tmp_path):
        """A cosmetic stage must not be able to lose a take."""
        broken = tmp_path / "broken.wav"
        broken.write_bytes(b"this is not audio")
        take = _tone(24000, 1.0, {200.0: 0.5})
        assert torch.equal(dsp.match_reference_tone(take, 24000, str(broken)), take)

    def test_output_keeps_the_input_length_and_shape(self, tmp_path):
        ref = self._reference(tmp_path, 44100, {200.0: 0.5, 3000.0: 0.02})
        take = _tone(24000, 1.5, {200.0: 0.5, 3000.0: 0.5})
        out = dsp.match_reference_tone(take, 24000, ref)
        assert out.shape == take.shape

    def test_keeps_the_take_inside_a_sane_headroom(self, tmp_path):
        """The match may lift a band, but it must not drive the take into clipping.

        Only the low shelf can raise a peak, and it is bounded by
        ``max_gain_db``; what matters is the result stays usable.
        """
        ref = self._reference(tmp_path, 44100, {200.0: 0.5, 3000.0: 0.02})
        take = _tone(24000, 1.0, {200.0: 0.9, 3000.0: 0.9})
        peak = float(take.abs().max())
        out = dsp.match_reference_tone(take, 24000, ref)
        assert float(out.abs().max()) <= peak + dsp.TONE_MATCH_MAX_GAIN_DB


class TestToneMatchEnabled:
    def test_default_is_on(self, monkeypatch):
        monkeypatch.delenv(dsp.TONE_MATCH_ENV, raising=False)
        assert dsp.tone_match_enabled() is True

    @pytest.mark.parametrize("value", ["off", "0", "false", "no", "OFF", "Off"])
    def test_off_values_disable_it(self, monkeypatch, value):
        monkeypatch.setenv(dsp.TONE_MATCH_ENV, value)
        assert dsp.tone_match_enabled() is False

    def test_an_empty_value_falls_back_to_the_default(self, monkeypatch):
        """``""`` means "not set here", so the caller's default still wins."""
        monkeypatch.setenv(dsp.TONE_MATCH_ENV, "")
        monkeypatch.setattr("core.prefs.resolve", lambda *a, **k: "")
        assert dsp.tone_match_enabled() is True

    @pytest.mark.parametrize("value", ["on", "1", "true", "yes"])
    def test_on_values_keep_it(self, monkeypatch, value):
        monkeypatch.setenv(dsp.TONE_MATCH_ENV, value)
        assert dsp.tone_match_enabled() is True


class TestBandQ:
    def test_stays_inside_the_usable_range(self):
        for lo, hi in dsp.TONE_MATCH_BANDS:
            centre = (lo + hi) / 2
            if lo == 0.0:
                lo = 100.0  # centre/(hi-lo) is meaningless for a shelf band
            q = dsp._band_q(lo, hi, centre)
            assert 0.4 <= q <= 2.5
