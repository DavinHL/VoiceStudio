"""Add the Voice Changer "save needs a result" hint to every locale.

The Save control in a queue row is inert until that row has been converted;
this string is its tooltip so a disabled button never reads as broken.

Idempotent: locales that already carry the key are left untouched.
"""

import json
from pathlib import Path

LOCALES = Path(__file__).resolve().parents[1] / "electron/src/renderer/src/i18n/locales"

EN = "Convert this clip first — Save as appears when the result is ready."
ID = "Konversi klip ini dulu — tombol Save as muncul setelah hasilnya siap."


def main() -> None:
    changed = 0
    for path in sorted(LOCALES.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        namespace = data.get("voiceChanger")
        if namespace is None:
            continue
        if "save_needs_result" in namespace:
            continue
        namespace["save_needs_result"] = ID if path.stem == "id" else EN
        path.write_text(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
            newline="\n",
        )
        changed += 1
    print(f"{changed} locale file(s) updated")


if __name__ == "__main__":
    main()
