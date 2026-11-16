"""Re-measure the pitch fixtures and confirm they are what __init__.py claims.

Run when a fixture looks suspect, or after any change to the tracker:

    python tests/fixtures/check_pitch_fixtures.py

Exits non-zero when a fixture no longer measures within 0.6 semitones of its
recorded register, so a tracker change that breaks the yardstick is caught
before it is mistaken for a change in behaviour.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
import torch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from services import audio_dsp as dsp  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fixtures import HIGH, LOW, MID, REF, TAKE_HIGH_HZ, TAKE_LOW_HZ, TAKE_MID_HZ, TAKE_REF_HZ, path  # noqa: E402,E501

EXPECTED = ((LOW, TAKE_LOW_HZ), (MID, TAKE_MID_HZ), (HIGH, TAKE_HIGH_HZ), (REF, TAKE_REF_HZ))


def main() -> int:
    failed = False
    for name, expected in EXPECTED:
        audio, rate = sf.read(path(name))
        clip = torch.from_numpy(np.asarray(audio, dtype=np.float32))
        if clip.dim() == 1:
            clip = clip.unsqueeze(0)
        measured = dsp.measure_pitch_hz(clip, rate)
        semitones = 12.0 * math.log2(measured / expected) if measured > 0 else float("nan")
        mark = "ok" if abs(semitones) < 0.6 else "MOVED"
        if abs(semitones) >= 0.6:
            failed = True
        print(f"  {name:>14s}: expected {expected:7.2f} Hz, measured {measured:7.2f} Hz "
              f"({semitones:+.2f} st) {mark}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
