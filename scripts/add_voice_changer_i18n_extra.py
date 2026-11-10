"""Add the voiceChanger keys introduced by the audit fixes to every locale.

`scripts/add_voice_changer_i18n_all.py` seeds the namespace from en.json; this
script only tops up keys added later, so re-running it is safe.
"""

from __future__ import annotations

import json
from pathlib import Path

LOCALES = Path(r"D:\AI Harmes Deepseek\VoiceStudio\electron\src\renderer\src\i18n\locales")
NAMESPACE = "voiceChanger"

ADDED = {
    "en": {
        "save_all": "Save all {{count}}",
        "saved_all": "Saved {{count}} take(s)",
        "settings_locked": "Voice, language and pacing are locked while the queue runs. Stop the run to change them.",
    },
    "id": {
        "save_all": "Simpan semua {{count}}",
        "saved_all": "{{count}} hasil tersimpan",
        "settings_locked": "Suara, bahasa, dan tempo terkunci selama antrean berjalan. Hentikan dulu untuk mengubahnya.",
    },
}


def main() -> None:
    for path in sorted(LOCALES.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        payload = data.setdefault(NAMESPACE, {})
        added = ADDED.get(path.stem, ADDED["en"])
        for key, value in added.items():
            payload[key] = value
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{len(ADDED['en'])} keys added to {len(list(LOCALES.glob('*.json')))} locales")


if __name__ == "__main__":
    main()
