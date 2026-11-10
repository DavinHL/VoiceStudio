"""Add the Voice Changer recording keys to every locale.

Idempotent: re-running it leaves already-translated files untouched. English
copies for locales that have no translation yet keep the locale gate green.
"""

from __future__ import annotations

import json
from pathlib import Path

LOCALES = Path("electron/src/renderer/src/i18n/locales")

NEW = {
    "record": {
        "en": "Record a clip",
        "id": "Rekam klip",
    },
    "record_hint": {
        "en": "A take is queued and converted like any dropped file.",
        "id": "Hasil rekaman masuk ke antrean dan dikonversi seperti file lain.",
    },
}


def main() -> int:
    touched = 0
    for path in sorted(LOCALES.glob("*.json")):
        code = path.stem
        data = json.loads(path.read_text(encoding="utf-8"))
        namespace = data.get("voiceChanger")
        if namespace is None:
            print(f"skip {path.name}: no voiceChanger namespace")
            continue
        added = []
        for key, translations in NEW.items():
            if key in namespace:
                continue
            namespace[key] = translations.get(code, translations["en"])
            added.append(key)
        if not added:
            continue
        path.write_text(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n"
        )
        touched += 1
        print(f"{path.name}: added {', '.join(added)}")
    print(f"{touched} locale file(s) updated")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
