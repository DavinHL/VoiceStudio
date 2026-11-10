import json
from pathlib import Path

BASE = Path(r"D:\AI Harmes Deepseek\VoiceStudio\electron\src\renderer\src\i18n\locales")

EN = {
    "title": "Voice changer",
    "subtitle": "Drop audio or video clips, pick a saved voice, and get the same recordings back in that voice.",
    "queue_count": "{{count}} clips",
    "target_voice": "Target voice",
    "pick_voice": "Search voices",
    "no_voices": "No saved voices with a reference yet.",
    "create_voice": "Create one in Clone",
    "keep_delivery": "Keep my delivery",
    "keep_delivery_hint": "Convert the recording itself so your timing, rhythm and intonation stay intact (speech-to-speech).",
    "keep_delivery_unavailable": "No installed engine converts speech to speech. Install CosyVoice 3 or turn this off to re-speak the transcript instead.",
    "source_language": "Spoken language of the clips",
    "match_duration": "Match the source length",
    "match_duration_hint": "Stretch the converted take so it lands near each clip's original duration.",
    "cloning_required": "The active engine can't clone voices. Pick a cloning engine in Models.",
    "add_files": "Add audio or video files",
    "drop_files": "Drop audio or video here, or click to choose",
    "drop_hint": "MP3, WAV, M4A, FLAC, OGG, MP4, MOV, MKV, WEBM — many files at once",
    "convert_all": "Convert {{count}} clip(s)",
    "converting": "Converting… {{done}}/{{total}}",
    "stop": "Stop",
    "save_all": "Save all {{count}}",
    "clear": "Clear list",
    "empty": "No clips yet. Add audio or video to start.",
    "remove": "Remove from list",
    "item_converting": "Converting this clip…",
    "item_done": "{{seconds}}s · heard: “{{text}}”",
}

ID = {
    "title": "Voice changer",
    "subtitle": "Jatuhkan klip audio atau video, pilih suara tersimpan, lalu dapatkan rekaman yang sama dengan suara itu.",
    "queue_count": "{{count}} klip",
    "target_voice": "Suara target",
    "pick_voice": "Cari suara",
    "no_voices": "Belum ada suara tersimpan yang punya referensi.",
    "create_voice": "Buat di Clone",
    "keep_delivery": "Pertahankan gaya bicara saya",
    "keep_delivery_hint": "Rekaman itu sendiri yang dikonversi, jadi tempo, ritme, dan intonasi Anda tetap utuh (speech-to-speech).",
    "keep_delivery_unavailable": "Belum ada engine yang bisa speech-to-speech. Pasang CosyVoice 3 atau matikan opsi ini agar teksnya diucapkan ulang.",
    "source_language": "Bahasa yang diucapkan di klip",
    "match_duration": "Samakan panjang dengan sumber",
    "match_duration_hint": "Hasil konversi diregangkan agar mendekati durasi klip aslinya.",
    "cloning_required": "Engine aktif tidak mendukung kloning suara. Pilih engine kloning di Models.",
    "add_files": "Tambah file audio atau video",
    "drop_files": "Jatuhkan audio atau video di sini, atau klik untuk memilih",
    "drop_hint": "MP3, WAV, M4A, FLAC, OGG, MP4, MOV, MKV, WEBM — banyak file sekaligus",
    "convert_all": "Konversi {{count}} klip",
    "converting": "Mengonversi… {{done}}/{{total}}",
    "stop": "Hentikan",
    "save_all": "Simpan semua {{count}}",
    "clear": "Kosongkan daftar",
    "empty": "Belum ada klip. Tambahkan audio atau video untuk mulai.",
    "remove": "Hapus dari daftar",
    "item_converting": "Sedang mengonversi klip ini…",
    "item_done": "{{seconds}} dtk · terdengar: “{{text}}”",
}

for name, payload in (("en.json", EN), ("id.json", ID)):
    path = BASE / name
    data = json.loads(path.read_text(encoding="utf-8"))
    data["voiceChanger"] = payload
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("updated", name, "keys:", len(data))
