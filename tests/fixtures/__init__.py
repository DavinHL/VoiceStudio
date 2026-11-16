"""Where the pitch fixtures came from, and why they are real audio.

The register tracker and its guards have to be tested against audio a voice
model actually produces. Synthetic tones cannot do it: a harmonic series built
from evenly-spaced partials is more periodic at a multiple of its period than at
the period itself, so a pitch detector correctly answers an octave (or a twelfth)
below the frequency you built it for. That is a property of the signal, not a
detector bug, and it makes such a signal useless as a yardstick — three separate
attempts to use one produced readings 12 to 19 semitones off.

So the fixtures are real takes, copied from `VoiceStudio/.devdata/outputs` and
never regenerated:

  take_low.wav   154.84 Hz   10fe2866    6.40 s
  take_mid.wav   184.62 Hz   c3af58ad    8.95 s   (the reference's own register)
  take_high.wav  260.87 Hz   ddcd3df4    4.18 s   (the defect being corrected)
  take_ref.wav   224.30 Hz   f30f1c8b    9.43 s   (used as a stand-in reference)

Each frequency is the median of the tracker's own voiced-frame readings, stable
to 0.2 semitones across window sizes and reproducible across runs. The clips are
24000 Hz mono float32, which is what the engine emits, and they are small enough
(200-450 kB) to keep in the tree.

To re-verify a fixture rather than trust this file:

    python tests/fixtures/check_pitch_fixtures.py
"""

from __future__ import annotations

from pathlib import Path

FIXTURES = Path(__file__).resolve().parent

#: The register each fixture was measured at, in Hz. Asserted by the tests.
TAKE_LOW_HZ = 154.84
TAKE_MID_HZ = 184.62
TAKE_HIGH_HZ = 260.87
TAKE_REF_HZ = 224.30


def path(name: str) -> str:
    """Absolute path of a fixture, as a string for the DSP entry points."""
    return str(FIXTURES / name)


LOW = "take_low.wav"
MID = "take_mid.wav"
HIGH = "take_high.wav"
REF = "take_ref.wav"
