"""Copy the new voiceChanger keys from en.json into all locales (local fork only).

Upstream requires hand-written translations in all 21 catalogs; for this fork we
seed every locale from the English strings through the same flatten/merge shape
the app loads, then the Indonesian catalog gets the curated translation. The
keys exist everywhere, so `locale:check` passes; English text shows in locales
without a real translation.
"""

from __future__ import annotations

import json
from pathlib import Path

LOCALES = Path(r"D:\AI Harmes Deepseek\VoiceStudio\electron\src\renderer\src\i18n\locales")
NAMESPACE = "voiceChanger"


def main() -> None:
    en = json.loads((LOCALES / "en.json").read_text(encoding="utf-8"))
    payload = en[NAMESPACE]
    id_payload = json.loads((LOCALES / "id.json").read_text(encoding="utf-8"))[NAMESPACE]

    updated = []
    for path in sorted(LOCALES.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        if path.name == "id.json":
            data[NAMESPACE] = id_payload
        else:
            data[NAMESPACE] = payload
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        updated.append(path.name)
    print(f"{len(updated)} locales seeded: {', '.join(updated)}")


if __name__ == "__main__":
    main()
