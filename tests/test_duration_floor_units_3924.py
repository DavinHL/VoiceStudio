"""Issue #3924 — the short-utterance duration floor must use the caller's unit.

``RuleDurationEstimator.estimate_duration`` boosts utterances shorter than
``low_threshold`` along a power curve.  ``low_threshold`` therefore has to be
expressed in the *same unit* as ``ref_duration``:

* ``omnivoice/cli/infer_batch.py`` passes SECONDS and asks for ``2.0``;
* ``OmniVoice._estimate_target_tokens`` passes an audio-**token** count.

The model call used to inherit the estimator's default, which was the CLI's
``50`` — a value that means ~4 seconds once the reference is a token count.  On
that scale *every* short utterance was floored far above its natural length, the
extra frames were filled by stretching the vowels, and "Hello" rendered as
"Halloooooo".

These tests fail before the fix (the inflated floor) and pass after.  Long text
is unaffected either way, which is why full scripts sounded fine and a
one-word script did not.
"""
import pytest

from omnivoice.utils.duration import RuleDurationEstimator

# The model's fallback reference when none is available (see
# ``OmniVoice._estimate_target_tokens``), and the frame rate the tokens are
# converted back to seconds with (``target_tokens = int(duration * frame_rate)``).
_REF_TEXT = "Nice to meet you."
_REF_TOKENS = 25.0
_FRAME_RATE = 12.5

# The bug's signature utterance.
_HELLO = "Hello"
_LONG_TEXT = (
    "This is a longer sentence that should be unaffected by the floor "
    "because it is well above it."
)


def _estimate_tokens(text, low_threshold):
    """The model's call shape: a token count in, a token count out."""
    est = RuleDurationEstimator()
    return est.estimate_duration(text, _REF_TEXT, _REF_TOKENS, low_threshold=low_threshold)


def test_default_floor_is_in_seconds_not_tokens():
    """The default must stay in seconds so the CLI and the module's own
    ``__main__`` demo (which pass ``1.5`` s) keep the documented behavior."""
    import inspect

    default = inspect.signature(RuleDurationEstimator.estimate_duration).parameters[
        "low_threshold"
    ].default
    assert default == 2.0


def test_short_utterance_is_not_inflated_by_the_floor():
    """Fail-before guard: the old 50-token default floors "Hello" at ~2.25 s
    (28.09 tokens) instead of its natural ~0.71 s (8.87 tokens)."""
    natural = _estimate_tokens(_HELLO, low_threshold=2.0)
    buggy = _estimate_tokens(_HELLO, low_threshold=50)

    assert natural == pytest.approx(8.87, abs=0.05)
    assert buggy == pytest.approx(28.09, abs=0.05)
    # The bug more than tripled the render: 2.25 s instead of 0.71 s.
    assert buggy / natural > 3.0


def test_short_utterances_scale_with_their_text():
    """With the floor in tokens, a shorter word gets a shorter estimate —
    "Hi" < "Yes" < "Hello" < "Thank you.".  Under the old default they were
    squashed together (20.7 / 23.7 / 28.1 / 33.8), which is what made "Hello"
    indistinguishable from a held vowel."""
    estimates = [
        _estimate_tokens(text, low_threshold=2.0)
        for text in ("Hi", "Yes", "Hello", "Thank you.")
    ]
    assert estimates == sorted(estimates)
    assert estimates[0] < estimates[-1] / 3  # "Hi" is far shorter than "Thank you."
    assert max(estimates) / _FRAME_RATE < 1.5  # all four stay under 1.5 s


def test_long_text_is_untouched_by_the_floor():
    """The floor is a short-utterance correction only: above the threshold the
    estimate is identical for every setting, so fixing it cannot regress a
    normal script."""
    natural = _estimate_tokens(_LONG_TEXT, low_threshold=2.0)
    seconds_default = _estimate_tokens(_LONG_TEXT, low_threshold=50)
    unbounded = _estimate_tokens(_LONG_TEXT, low_threshold=None)

    assert natural == pytest.approx(seconds_default)
    assert natural == pytest.approx(unbounded)
    assert natural / _FRAME_RATE > 5.0  # really is long-form
