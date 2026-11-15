"""Backend tests for #3933: the target length must come from the reference's
own audio duration, not from how long its transcript happens to be.

Before the fix the estimator divided the target by ``ref_weight /
ref_duration``, where ``ref_duration`` is an audio-token count. A transcript
shorter than its audio lowered ``ref_weight`` alone, so the pace looked slower
and the render was stretched: a 13.61 s reference transcribed in full asked for
247 frames, while a 46-character trim of the SAME audio asked for 935 — the
take came out 3.3x too long and the reading dropped to half speed.

These tests exercise ``_target_tokens_from_reference`` on a bare object: the
method reads only ``duration_estimator`` and ``audio_tokenizer.config.
frame_rate``, so no model weights are needed.
"""
import types

import pytest

from omnivoice.models.omnivoice import OmniVoice
from omnivoice.utils.audio import MAX_REFERENCE_PACE, MIN_REFERENCE_PACE
from omnivoice.utils.duration import RuleDurationEstimator

# The tokenizer's real configuration (downsample_factor 320 at 24 kHz).
_FRAME_RATE = 24000 / 320
_REF_SECONDS = 13.609796
_REF_TOKENS = int(_REF_SECONDS * _FRAME_RATE)

_FULL_TRANSCRIPT = (
    "Airoh, kalau begitu aku akan membantumu, Pong. Aku akan keluarkan "
    "gelombang yang akan membuat para kuman melambat. Dengan begitu, "
    "mereka tidak akan bisa melarikan diri lagi."
)
_TRIMMED_TRANSCRIPT = "Airoh, kalau begitu aku akan membantumu, Pong."
_TEXT = "helo aku siapa pong airoh kamu dimana pong"


class _Estimator:
    """The two attributes ``_target_tokens_from_reference`` actually reads."""

    def __init__(self, frame_rate=_FRAME_RATE):
        self.duration_estimator = RuleDurationEstimator()
        self.audio_tokenizer = types.SimpleNamespace(
            config=types.SimpleNamespace(frame_rate=frame_rate)
        )

    _target_tokens_from_reference = OmniVoice._target_tokens_from_reference
    _estimate_target_tokens = OmniVoice._estimate_target_tokens


def _tokens(text, ref_text, ref_seconds=_REF_SECONDS, speed=1.0):
    return _Estimator()._target_tokens_from_reference(
        text, ref_text, _REF_TOKENS, ref_seconds=ref_seconds, speed=speed
    )


class TestReferencePace:
    def test_a_trimmed_transcript_no_longer_balloons_the_render(self):
        """The reference audio is identical, so describing it with fewer
        characters must not stretch the target. This is the defect (#3933): the
        old token-count path returned 935 frames for the 46-character trim
        against 247 for the full transcript. It now returns 682 — still not
        247, because a 2.92 weight/s transcript really is a slower pace than
        11.02, so the clamp bounds it rather than pretending the two agree."""
        full = _tokens(_TEXT, _FULL_TRANSCRIPT)
        trimmed = _tokens(_TEXT, _TRIMMED_TRANSCRIPT)
        assert trimmed < 935
        assert trimmed <= full * 3

    def test_the_full_transcript_gets_the_length_its_audio_implies(self):
        """With a transcript that matches its audio, the estimate follows the
        measured pace — this is the path that must stay exactly right."""
        assert _tokens(_TEXT, _FULL_TRANSCRIPT) == 247

    def test_the_length_matches_the_reference_reading_pace(self):
        """A 13.61 s clip reading 173 characters is 12.71 characters/s, so a
        42-character target needs about 3.3 s — not the 9.1 s the unclamped
        ratio asks for, and not the 12.5 s the old path asked for."""
        tokens = _tokens(_TEXT, _FULL_TRANSCRIPT)
        seconds = tokens / _FRAME_RATE
        expected = len(_TEXT) / (len(_FULL_TRANSCRIPT) / _REF_SECONDS)
        assert seconds == pytest.approx(expected, abs=0.35)

    def test_a_slower_reference_asks_for_a_longer_target(self):
        """The pace is measured, not pinned: a reference that takes twice as
        long to say the same words must produce a longer target."""
        fast = _tokens(_TEXT, _FULL_TRANSCRIPT, ref_seconds=_REF_SECONDS)
        slow = _tokens(_TEXT, _FULL_TRANSCRIPT, ref_seconds=_REF_SECONDS * 2)
        assert slow > fast * 1.8

    def test_longer_target_text_asks_for_more_frames(self):
        short = _tokens("hello", _FULL_TRANSCRIPT)
        long = _tokens(_TEXT * 4, _FULL_TRANSCRIPT)
        assert long > short * 3


class TestClamp:
    def test_a_transcript_far_shorter_than_its_audio_is_clamped(self):
        """A 46-character transcript spanning 13.61 s of audio implies 2.92
        weight/s, well below any real reading. The clamp must stop the target
        from ballooning."""
        tokens = _tokens(_TEXT, _TRIMMED_TRANSCRIPT)
        # Without the clamp this would be 42 / (39.7/13.61) * 75 = ~1080 frames.
        assert tokens < 42 / (39.7 / _REF_SECONDS) * _FRAME_RATE
        assert tokens / _FRAME_RATE < 10.0

    def test_the_clamp_bounds_the_pace_at_both_ends(self):
        """An absurdly long transcript must not shrink the render to nothing
        either."""
        # 3000 characters over 13.61 s is 220 weight/s, far above a real pace.
        absurd = "a" * 3000
        tokens = _tokens(_TEXT, absurd)
        expected = (
            _Estimator().duration_estimator.calculate_total_weight(_TEXT)
            / MAX_REFERENCE_PACE
            * _FRAME_RATE
        )
        assert tokens == pytest.approx(expected, rel=0.02)
        assert tokens >= 1

    def test_the_bounds_sit_around_measured_speech(self):
        """The measured range in this project: 11.03 weight/s over a clip's
        full length, 14.34 over its voiced part, 3.60 in the half-speed render
        the bug produced. The bounds must contain the former and exclude the
        latter."""
        assert MIN_REFERENCE_PACE < 11.03 < MAX_REFERENCE_PACE
        assert MIN_REFERENCE_PACE < 14.34 < MAX_REFERENCE_PACE
        assert MIN_REFERENCE_PACE > 3.60


class TestFallbacks:
    def test_without_a_reference_duration_the_token_path_still_applies(self):
        """Prompts saved before ``ref_seconds`` existed carry 0.0, and those
        must keep working rather than erroring."""
        est = _Estimator()
        tokens = est._target_tokens_from_reference(_TEXT, _FULL_TRANSCRIPT, _REF_TOKENS)
        assert tokens > 1

    def test_without_any_reference_the_plain_estimator_is_used(self):
        est = _Estimator()
        tokens = est._target_tokens_from_reference(_TEXT, None, None)
        assert tokens == est._estimate_target_tokens(_TEXT, None, None)

    def test_an_empty_reference_text_falls_back(self):
        est = _Estimator()
        tokens = est._target_tokens_from_reference(_TEXT, "", 0, ref_seconds=_REF_SECONDS)
        assert tokens > 1

    def test_an_unknown_frame_rate_falls_back_without_raising(self):
        est = _Estimator(frame_rate=0)
        tokens = est._target_tokens_from_reference(
            _TEXT, _FULL_TRANSCRIPT, _REF_TOKENS, ref_seconds=_REF_SECONDS
        )
        assert tokens > 1

    def test_speed_still_scales_the_result(self):
        normal = _tokens(_TEXT, _FULL_TRANSCRIPT)
        faster = _tokens(_TEXT, _FULL_TRANSCRIPT, speed=2.0)
        slower = _tokens(_TEXT, _FULL_TRANSCRIPT, speed=0.5)
        assert faster == pytest.approx(normal / 2, rel=0.02)
        assert slower == pytest.approx(normal * 2, rel=0.02)

    def test_the_result_is_always_at_least_one_frame(self):
        assert _tokens("a", _FULL_TRANSCRIPT) >= 1


class TestReferenceSecondsIsRecorded:
    def test_the_clone_prompt_records_its_clip_length(self):
        """The pace has to span the same audio the tokens came from, so the
        prompt carries the duration it was built from."""
        from omnivoice.models.omnivoice import VoiceClonePrompt

        prompt = VoiceClonePrompt(
            ref_audio_tokens=None, ref_text=_FULL_TRANSCRIPT, ref_rms=0.1,
            ref_seconds=_REF_SECONDS,
        )
        assert prompt.ref_seconds == _REF_SECONDS

    def test_a_prompt_without_the_field_defaults_to_zero(self):
        from omnivoice.models.omnivoice import VoiceClonePrompt

        prompt = VoiceClonePrompt(
            ref_audio_tokens=None, ref_text=_FULL_TRANSCRIPT, ref_rms=0.1
        )
        assert prompt.ref_seconds == 0.0

    def test_the_saved_prompt_round_trips_the_duration(self, tmp_path):
        import torch

        from omnivoice.models.omnivoice import VoiceClonePrompt

        prompt = VoiceClonePrompt(
            ref_audio_tokens=torch.zeros(1, 4, dtype=torch.long),
            ref_text=_FULL_TRANSCRIPT,
            ref_rms=0.1,
            ref_seconds=_REF_SECONDS,
        )
        path = tmp_path / "prompt.pt"
        prompt.save(str(path))
        restored = VoiceClonePrompt.load(str(path))
        assert restored.ref_seconds == _REF_SECONDS
        assert restored.ref_text == _FULL_TRANSCRIPT
