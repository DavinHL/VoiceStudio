"""Tests for matching a take's loudness to its reference (#3932).

Peak normalisation to a fixed -2 dBFS says nothing about how loud a take
*feels*: a dense compressed take and a dynamic reference can share a peak and
still sit 10 dB apart. These tests pin the RMS copy that replaced it.
"""

from __future__ import annotations

import math

import pytest
import torch

from services import audio_dsp as dsp


def _speech(sample_rate: int, seconds: float, amplitude: float = 0.5) -> torch.Tensor:
    """A voiced-ish signal: a fundamental plus harmonics, so RMS is meaningful."""
    t = torch.arange(int(sample_rate * seconds), dtype=torch.float32) / sample_rate
    out = torch.zeros_like(t)
    for f, amp in ((180.0, 1.0), (360.0, 0.5), (720.0, 0.25)):
        out += amp * torch.sin(2 * math.pi * f * t)
    peak = out.abs().max()
    return (out * (amplitude / peak)).unsqueeze(0)


def _write(tmp_path, tensor: torch.Tensor, sample_rate: int, name: str = "ref.wav"):
    """Save ``tensor`` as a real clip :func:`load_audio` can read back."""
    import soundfile as sf

    path = tmp_path / name
    sf.write(str(path), tensor.squeeze(0).numpy(), sample_rate)
    return str(path)


def _rms(tensor: torch.Tensor) -> float:
    return 20.0 * math.log10(float(torch.sqrt(torch.mean(tensor.to(torch.float64) ** 2))))


class TestRmsDb:
    def test_measures_level_in_dbfs(self):
        """Half of full scale is -6.02 dBFS, regardless of frequency."""
        half = _speech(24000, 1.0, amplitude=1.0) * 0.5
        # A sine at 0.5 peak reads -9.03 dBFS RMS; the harmonic mix differs, so
        # assert the scale relationship instead of a magic number.
        doubled = half * 2.0
        assert abs((_rms(doubled) - _rms(half)) - 6.0206) < 0.01

    def test_silence_is_negative_infinity(self):
        assert dsp._rms_db(torch.zeros(1, 2400)) == float("-inf")

    def test_an_empty_tensor_is_negative_infinity(self):
        assert dsp._rms_db(torch.zeros(0)) == float("-inf")


class TestMatchReferenceLevel:
    def test_brings_a_loud_take_down_to_the_reference(self, tmp_path):
        """The reported defect: a take ~9 dB hotter than the clip it clones."""
        ref = _speech(24000, 2.0, amplitude=0.06)
        ref_path = _write(tmp_path, ref, 24000)
        take = _speech(24000, 2.0, amplitude=0.5)

        out = dsp.match_reference_level(take, 24000, ref_path)

        assert abs(_rms(out) - _rms(ref)) < 0.05
        assert out.abs().max() < take.abs().max()

    def test_lifts_a_quiet_take_toward_the_reference(self, tmp_path):
        ref = _speech(24000, 2.0, amplitude=0.5)
        ref_path = _write(tmp_path, ref, 24000)
        take = _speech(24000, 2.0, amplitude=0.3)

        out = dsp.match_reference_level(take, 24000, ref_path)

        assert _rms(out) > _rms(take)
        assert abs(_rms(out) - _rms(ref)) < 0.05

    def test_a_lift_beyond_the_cap_stops_at_the_cap(self, tmp_path):
        """A very quiet reference must not drag the take into the limiter.

        The take is raised by ``max_gain_db`` and no further, so it lands short
        of the reference on purpose.
        """
        ref = _speech(24000, 2.0, amplitude=0.5)
        ref_path = _write(tmp_path, ref, 24000)
        take = _speech(24000, 2.0, amplitude=0.05)

        out = dsp.match_reference_level(take, 24000, ref_path, max_gain_db=3.0)

        gained = _rms(out) - _rms(take)
        assert abs(gained - 3.0) < 0.05
        assert _rms(out) < _rms(ref)  # capped, so still short of the reference

    def test_attenuation_is_never_capped(self, tmp_path):
        """Coming down is always safe, however far the take has to fall."""
        ref = _speech(24000, 2.0, amplitude=0.06)
        ref_path = _write(tmp_path, ref, 24000)
        take = _speech(24000, 2.0, amplitude=0.9)

        out = dsp.match_reference_level(take, 24000, ref_path, max_gain_db=1.0)

        assert _rms(out) < _rms(take) - 10.0
        assert abs(_rms(out) - _rms(ref)) < 0.05

    def test_a_reference_below_the_floor_is_treated_as_silence(self, tmp_path):
        """A reference at the noise floor has no level worth copying."""
        ref = _speech(24000, 2.0, amplitude=0.002)
        ref_path = _write(tmp_path, ref, 24000)
        assert _rms(ref) < dsp.LEVEL_MATCH_FLOOR_DB
        take = _speech(24000, 2.0, amplitude=0.5)

        out = dsp.match_reference_level(take, 24000, ref_path)

        assert torch.equal(out, take)

    def test_keeps_the_result_under_the_peak_ceiling(self, tmp_path):
        """Boosting a peaky take must not clip it on the way up."""
        ref = _speech(24000, 2.0, amplitude=0.5)
        ref_path = _write(tmp_path, ref, 24000)
        # A quiet take with one huge spike: raising its RMS would clip the spike.
        take = _speech(24000, 2.0, amplitude=0.05)
        take[0, 12000] = 0.95

        out = dsp.match_reference_level(take, 24000, ref_path)

        peak_db = 20.0 * math.log10(float(out.abs().max()))
        assert peak_db <= -3.0 + 0.1  # the peak_ceiling_dbfs default

    def test_does_not_reach_into_the_limiter(self, tmp_path):
        """The whole point: the result must not be pinned to the ceiling."""
        ref = _speech(24000, 2.0, amplitude=0.06)
        ref_path = _write(tmp_path, ref, 24000)
        take = _speech(24000, 2.0, amplitude=0.5)

        out = dsp.match_reference_level(take, 24000, ref_path)

        assert float(out.abs().max()) < 0.5  # well below the -2 dBFS the old stage used

    def test_shape_is_preserved(self, tmp_path):
        ref = _speech(24000, 1.0, amplitude=0.06)
        ref_path = _write(tmp_path, ref, 24000)
        take = _speech(24000, 1.0, amplitude=0.5)

        out = dsp.match_reference_level(take, 24000, ref_path)

        assert out.shape == take.shape

    def test_no_reference_is_a_no_op(self):
        take = _speech(24000, 1.0)
        assert torch.equal(dsp.match_reference_level(take, 24000, None), take)

    def test_a_missing_reference_is_a_no_op(self, tmp_path):
        take = _speech(24000, 1.0)
        missing = str(tmp_path / "nope.wav")
        assert torch.equal(dsp.match_reference_level(take, 24000, missing), take)

    def test_a_silent_reference_is_a_no_op(self, tmp_path):
        ref_path = _write(tmp_path, torch.zeros(1, 24000), 24000)
        take = _speech(24000, 1.0)
        assert torch.equal(dsp.match_reference_level(take, 24000, ref_path), take)

    def test_a_silent_take_is_a_no_op(self, tmp_path):
        ref = _speech(24000, 1.0, amplitude=0.5)
        ref_path = _write(tmp_path, ref, 24000)
        take = torch.zeros(1, 24000)
        assert torch.equal(dsp.match_reference_level(take, 24000, ref_path), take)

    def test_an_empty_take_is_a_no_op(self, tmp_path):
        ref = _speech(24000, 1.0, amplitude=0.5)
        ref_path = _write(tmp_path, ref, 24000)
        take = torch.zeros(0)
        assert torch.equal(dsp.match_reference_level(take, 24000, ref_path), take)

    def test_a_broken_reference_never_raises(self, tmp_path):
        """A cosmetic stage must never lose a take."""
        broken = tmp_path / "broken.wav"
        broken.write_bytes(b"not a wav at all")
        take = _speech(24000, 1.0)
        out = dsp.match_reference_level(take, 24000, str(broken))
        assert out.shape == take.shape

    def test_is_deterministic(self, tmp_path):
        ref = _speech(24000, 1.0, amplitude=0.06)
        ref_path = _write(tmp_path, ref, 24000)
        take = _speech(24000, 1.0, amplitude=0.5)

        once = dsp.match_reference_level(take, 24000, ref_path)
        twice = dsp.match_reference_level(take, 24000, ref_path)

        assert torch.equal(once, twice)

    def test_an_already_matched_take_is_left_alone(self, tmp_path):
        """Within 0.1 dB there is nothing worth scaling."""
        ref = _speech(24000, 1.0, amplitude=0.3)
        ref_path = _write(tmp_path, ref, 24000)
        take = ref.clone()

        out = dsp.match_reference_level(take, 24000, ref_path)

        assert torch.equal(out, take)


class TestLevelMatchEnabled:
    def test_on_by_default(self, monkeypatch):
        monkeypatch.delenv(dsp.LEVEL_MATCH_ENV, raising=False)
        monkeypatch.setattr("core.prefs.resolve", lambda *a, **k: "on")
        assert dsp.level_match_enabled() is True

    @pytest.mark.parametrize("value", ["off", "0", "false", "no", "OFF", "Off"])
    def test_off_values_disable_it(self, monkeypatch, value):
        monkeypatch.setenv(dsp.LEVEL_MATCH_ENV, value)
        assert dsp.level_match_enabled() is False

    @pytest.mark.parametrize("value", ["on", "1", "true", "yes"])
    def test_on_values_keep_it(self, monkeypatch, value):
        monkeypatch.setenv(dsp.LEVEL_MATCH_ENV, value)
        assert dsp.level_match_enabled() is True

    def test_an_empty_value_falls_back_to_the_default(self, monkeypatch):
        """``""`` means "not set here", so the caller's default still wins."""
        monkeypatch.setenv(dsp.LEVEL_MATCH_ENV, "")
        monkeypatch.setattr("core.prefs.resolve", lambda *a, **k: "")
        assert dsp.level_match_enabled() is True

    def test_an_unreadable_setting_keeps_the_default(self, monkeypatch):
        def boom(*a, **k):
            raise RuntimeError("prefs unavailable")

        monkeypatch.setattr("core.prefs.resolve", boom)
        # prefs is imported inside the function, so patching the module attr is
        # what the call site sees.
        assert dsp.level_match_enabled() is True
