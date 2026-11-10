"""Add the Voice Changer review-and-pick i18n keys to every locale catalog.

Idempotent: re-running rewrites the same values instead of duplicating keys.
English is the source; Indonesian carries a real translation, and every other
locale starts from the English string (the parity gate only requires presence).

Usage:
    python scripts/add_voice_changer_pick_i18n.py [repo_root ...]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

LOCALES = (
    "ar",
    "de",
    "en",
    "es",
    "fr",
    "gl",
    "hi",
    "id",
    "it",
    "ja",
    "ko",
    "nl",
    "pl",
    "pt",
    "ru",
    "sv",
    "th",
    "tr",
    "uk",
    "vi",
    "zh-CN",
    "zh-TW",
)

ENGLISH = {
    "take_title": "Review your recording",
    "take_add": "Add to queue",
    "take_redo": "Record again",
    "take_discard": "Discard",
    "pick_voice_hint": "Pick the voice everything is converted into.",
    "selected_voice": "Converting into {{name}}",
    "no_matches": "No voice matches \u201c{{query}}\u201d.",
}

INDONESIAN = {
    "take_title": "Tinjau hasil rekaman",
    "take_add": "Tambahkan ke antrean",
    "take_redo": "Rekam ulang",
    "take_discard": "Buang",
    "pick_voice_hint": "Pilih suara tujuan untuk semua file yang dikonversi.",
    "selected_voice": "Dikonversi ke {{name}}",
    "no_matches": "Tidak ada suara yang cocok dengan \u201c{{query}}\u201d.",
}


def patch(path: Path) -> bool:
    data = json.loads(path.read_text(encoding="utf-8"))
    namespace = data.setdefault("voiceChanger", {})
    locale = path.stem
    values = INDONESIAN if locale == "id" else ENGLISH
    before = json.dumps(namespace, sort_keys=True, ensure_ascii=False)
    for key, value in values.items():
        namespace[key] = value
    after = json.dumps(namespace, sort_keys=True, ensure_ascii=False)
    if before == after:
        return False
    path.write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    return True


def main(argv: list[str]) -> int:
    roots = [Path(arg) for arg in argv[1:]] or [Path(__file__).resolve().parents[1]]
    changed = 0
    for root in roots:
        directory = root / "electron/src/renderer/src/i18n/locales"
        for locale in LOCALES:
            path = directory / f"{locale}.json"
            if not path.exists():
                print(f"missing locale: {path}", file=sys.stderr)
                return 1
            if patch(path):
                changed += 1
        print(f"{root}: {changed} locale file(s) updated")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
