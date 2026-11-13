"""Cutting a reference clip, and filling transcripts for the whole library (#3925).

Two editor tools share one goal: give the engines a reference that describes the
voice. A long clip makes that hard — OmniVoice reads only its best 20 seconds
(``ref_strategy="best_window"``), so a clip that ends in a chorus clones the
chorus — and a missing transcript makes it slower, because every render
transcribes the clip again before synthesising.
"""

import io
import threading
import time
import wave

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


def wav_bytes(frames: int = 4000, rate: int = 16000) -> bytes:
    data = io.BytesIO()
    with wave.open(data, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(b"\x01\x00" * frames)
    return data.getvalue()


def stub_asr(monkeypatch, text: str = "auto transcript", seen: list | None = None):
    """Stand in for the installed ASR model, which is not present in tests.

    ``_auto_transcribe_reference`` imports ``transcribe_reference`` at call time,
    so patching the source module reaches both profile save and the bulk run.
    """

    def fake_transcribe(path):
        if seen is not None:
            seen.append(path)
        if callable(text):
            return text(path)
        return text

    monkeypatch.setattr("services.asr_backend.transcribe_reference", fake_transcribe)
    return fake_transcribe


@pytest.fixture
def env(tmp_path, monkeypatch):
    from api.routers import profiles
    from core import db

    # The bulk job lives in module state, so one test's run must not leak into
    # the next one's "idle" expectation.
    monkeypatch.setattr(profiles, "_bulk_transcribe_job", None)
    monkeypatch.setattr(profiles, "_bulk_transcribe_task", None)

    voices = tmp_path / "voices"
    monkeypatch.setattr(profiles, "VOICES_DIR", str(voices))
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "profiles.db"))
    db.init_db()

    # Saving a profile resolves a transcript when the ASR is installed (#2583).
    # Tests here are about *filling* a missing one, so the ASR is stubbed to
    # report no speech: fixture voices then start blank, and a test that wants
    # a transcript calls stub_asr() to replace this stub.
    stub_asr(monkeypatch, text="")
    events = []
    monkeypatch.setattr(profiles.event_bus, "emit", lambda *a: events.append(a))
    # Real duration probing needs ffmpeg; the cut itself is stubbed per test.
    # Patched at the source module because the router imports it lazily.
    import services.tts_backend as tts_backend

    monkeypatch.setattr(tts_backend, "reference_duration_s", lambda path: 30.0)
    app = FastAPI()
    app.include_router(profiles.router)
    client = TestClient(app, client=("127.0.0.1", 50000))
    created = client.post(
        "/profiles",
        data={"name": "Scarlet", "ref_text": "", "instruct": "female"},
        files={"ref_audio": ("voice.wav", wav_bytes(), "audio/wav")},
    ).json()
    return client, profiles, db, voices, created, events


@pytest.fixture
def stub_cut(monkeypatch):
    """Replace the ffmpeg cut with a marker so route logic is testable alone."""
    from api.routers import profiles

    calls = []

    async def fake_cut(source, dest, start_s, end_s):
        calls.append((source, dest, start_s, end_s))
        with open(dest, "wb") as out:
            out.write(wav_bytes())

    monkeypatch.setattr(profiles, "_cut_audio", fake_cut)

    async def decodable(_path):
        return True

    monkeypatch.setattr(profiles, "_is_decodable_audio", decodable)
    return calls


# ── Cutting the reference ───────────────────────────────────────────────


def test_cut_writes_a_new_versioned_file_and_clears_the_lock(env, stub_cut):
    client, profiles, db, voices, created, events = env
    pid = created["id"]
    old_name = created["ref_audio_path"]
    (voices / f"{pid}_locked.wav").write_bytes(wav_bytes())
    with db.db_conn() as conn:
        conn.execute(
            "UPDATE voice_profiles SET locked_audio_path=?, is_locked=1, seed=7, "
            "verified_own_voice=1, ref_text='old words' WHERE id=?",
            (f"{pid}_locked.wav", pid),
        )

    response = client.post(f"/profiles/{pid}/audio/trim", json={"start_s": 4.0, "end_s": 12.0})

    assert response.status_code == 200, response.text
    updated = response.json()
    # A new filename is the cache key every engine and chapter cache uses.
    assert updated["ref_audio_path"] != old_name
    assert updated["ref_audio_path"].startswith(f"{pid}-")
    assert updated["audio_url"] != created["audio_url"]
    # The cut is a different passage, so identity tied to the old clip drops.
    assert updated["locked_audio_path"] == "" and not updated["is_locked"]
    assert updated["seed"] is None
    assert not updated["verified_own_voice"]
    # A whole-clip transcript cannot describe a window of it.
    assert updated["ref_text"] == ""
    # ffmpeg writes the staging file; the router renames it into place after
    # the size and decodability checks pass.
    assert stub_cut == [(
        str(voices / old_name),
        f"{voices / updated['ref_audio_path']}.part",
        4.0,
        12.0,
    )]
    assert not list(voices.glob("*.part"))
    # Superseded, not deleted: a running render may still be reading it.
    assert (voices / old_name).exists()
    profiles.sweep_retired_voice_files(grace_s=0)
    assert not (voices / old_name).exists()
    assert events[-1] == ("profiles", {"action": "updated", "id": pid})


def test_cut_can_keep_the_transcript(env, stub_cut):
    client, _profiles, _db, _voices, created, _events = env
    response = client.post(
        f"/profiles/{created['id']}/audio/trim",
        json={"start_s": 0.0, "end_s": 8.0, "keep_transcript": True},
    )
    assert response.status_code == 200, response.text
    # The profile was created with an empty transcript, so there is nothing to
    # keep — the flag must not invent one, and must not run ASR either.
    assert response.json()["ref_text"] == ""


def test_cut_clamps_a_stale_range_to_the_real_clip(env, stub_cut):
    client, _profiles, _db, _voices, created, _events = env
    # The fixture reports a 30s clip; a waveform left over from a longer
    # recording must not ask for audio the file does not have.
    response = client.post(
        f"/profiles/{created['id']}/audio/trim", json={"start_s": 2.0, "end_s": 99.0},
    )
    assert response.status_code == 200, response.text
    assert stub_cut[0][3] == 30.0


def test_cut_shorter_than_half_a_second_is_refused(env, stub_cut):
    client, _profiles, _db, voices, created, _events = env
    before = sorted(p.name for p in voices.iterdir())
    response = client.post(
        f"/profiles/{created['id']}/audio/trim", json={"start_s": 3.0, "end_s": 3.2},
    )
    assert response.status_code == 422
    assert sorted(p.name for p in voices.iterdir()) == before


def test_cut_clamped_to_nothing_is_refused(env, stub_cut):
    client, _profiles, _db, voices, created, _events = env
    before = sorted(p.name for p in voices.iterdir())
    # Entirely past the end of a 30s clip, so the clamp leaves no window.
    response = client.post(
        f"/profiles/{created['id']}/audio/trim", json={"start_s": 45.0, "end_s": 60.0},
    )
    assert response.status_code == 422
    assert sorted(p.name for p in voices.iterdir()) == before


@pytest.mark.parametrize("payload", [{"start_s": -1.0, "end_s": 5.0}])
def test_cut_before_the_start_is_refused(env, stub_cut, payload):
    client, *_ = env
    assert client.post(f"/profiles/{env[4]['id']}/audio/trim", json=payload).status_code == 422


def test_cut_of_a_design_voice_is_refused(env, stub_cut):
    client, _profiles, db, _voices, created, _events = env
    with db.db_conn() as conn:
        conn.execute("UPDATE voice_profiles SET kind='design' WHERE id=?", (created["id"],))
    response = client.post(
        f"/profiles/{created['id']}/audio/trim", json={"start_s": 0.0, "end_s": 5.0},
    )
    assert response.status_code == 409


def test_cut_without_a_reference_is_404(env, stub_cut):
    client, _profiles, db, _voices, created, _events = env
    with db.db_conn() as conn:
        conn.execute("UPDATE voice_profiles SET ref_audio_path='' WHERE id=?", (created["id"],))
    response = client.post(
        f"/profiles/{created['id']}/audio/trim", json={"start_s": 0.0, "end_s": 5.0},
    )
    assert response.status_code == 404


def test_cut_of_a_missing_profile_is_404(env, stub_cut):
    client, *_ = env
    assert client.post(
        "/profiles/nope1234/audio/trim", json={"start_s": 0.0, "end_s": 5.0},
    ).status_code == 404


def test_failing_cut_leaves_the_profile_untouched(env, monkeypatch):
    from fastapi import HTTPException

    from api.routers import profiles

    async def failing_cut(source, dest, start_s, end_s):
        raise HTTPException(status_code=422, detail="That recording could not be cut.")

    monkeypatch.setattr(profiles, "_cut_audio", failing_cut)
    client, _profiles, _db, voices, created, _events = env
    before = sorted(p.name for p in voices.iterdir())

    response = client.post(
        f"/profiles/{created['id']}/audio/trim", json={"start_s": 0.0, "end_s": 5.0},
    )

    assert response.status_code == 422
    assert sorted(p.name for p in voices.iterdir()) == before
    assert client.get(f"/profiles/{created['id']}").json()["ref_audio_path"] == created[
        "ref_audio_path"
    ]


def test_cut_refuses_an_undecodable_result(env, monkeypatch):
    from api.routers import profiles

    async def fake_cut(source, dest, start_s, end_s):
        with open(dest, "wb") as out:
            out.write(wav_bytes())

    async def not_decodable(_path):
        return False

    monkeypatch.setattr(profiles, "_cut_audio", fake_cut)
    monkeypatch.setattr(profiles, "_is_decodable_audio", not_decodable)
    client, _profiles, _db, voices, created, _events = env
    before = sorted(p.name for p in voices.iterdir())

    response = client.post(
        f"/profiles/{created['id']}/audio/trim", json={"start_s": 0.0, "end_s": 5.0},
    )

    assert response.status_code == 422
    assert sorted(p.name for p in voices.iterdir()) == before


def test_cut_keeps_the_container_extension(env, stub_cut):
    client, _profiles, _db, voices, created, _events = env
    (voices / f"{created['id']}.mp3").write_bytes(wav_bytes())
    with __import__("core.db", fromlist=["db_conn"]).db_conn() as conn:
        conn.execute(
            "UPDATE voice_profiles SET ref_audio_path=? WHERE id=?",
            (f"{created['id']}.mp3", created["id"]),
        )
    response = client.post(
        f"/profiles/{created['id']}/audio/trim", json={"start_s": 0.0, "end_s": 5.0},
    )
    assert response.status_code == 200, response.text
    assert response.json()["ref_audio_path"].endswith(".mp3")


@pytest.mark.asyncio
async def test_cut_audio_names_the_container_for_a_staged_destination(monkeypatch, tmp_path):
    """ffmpeg cannot sniff a `*.part` name, so the format must be explicit.

    The cut is written to a staging file beside its target; without `-f` ffmpeg
    reads that suffix as unknown and refuses with "Unable to choose an output
    format", which made every real cut fail while the stubbed tests passed.
    """
    from api.routers import profiles
    from services import ffmpeg_utils

    seen = {}

    async def fake_run(cmd, timeout: float = 1800.0, capture: bool = True):
        seen["cmd"] = cmd
        return 0, b"", b""

    monkeypatch.setattr(ffmpeg_utils, "run_ffmpeg", fake_run)
    monkeypatch.setattr(ffmpeg_utils, "find_ffmpeg", lambda: "ffmpeg")

    dest = tmp_path / "clip-abc123.mp3.part"
    await profiles._cut_audio(str(tmp_path / "in.mp3"), str(dest), 1.0, 3.0)

    cmd = seen["cmd"]
    # The container is taken from the target suffix, not the .part staging name.
    assert cmd[cmd.index("-f"):cmd.index("-f") + 2] == ["-f", "mp3"], cmd
    assert ["-c:a", "libmp3lame", "-q:a", "2"] == cmd[cmd.index("-c:a"):cmd.index("-c:a") + 4]
    # `-ss`/`-t` must seek before the input, not decode and discard.
    assert cmd.index("-ss") < cmd.index("-i")
    assert cmd.index("-t") < cmd.index("-i")
    assert cmd[-1] == str(dest)


@pytest.mark.asyncio
async def test_cut_audio_marks_a_wav_target_as_wav(monkeypatch, tmp_path):
    from api.routers import profiles
    from services import ffmpeg_utils

    seen = {}

    async def fake_run(cmd, timeout: float = 1800.0, capture: bool = True):
        seen["cmd"] = cmd
        return 0, b"", b""

    monkeypatch.setattr(ffmpeg_utils, "run_ffmpeg", fake_run)
    monkeypatch.setattr(ffmpeg_utils, "find_ffmpeg", lambda: "ffmpeg")

    await profiles._cut_audio(
        str(tmp_path / "in.wav"), str(tmp_path / "out.wav.part"), 0.0, 2.0,
    )

    cmd = seen["cmd"]
    assert ["-c:a", "pcm_s16le"] == cmd[cmd.index("-c:a"):cmd.index("-c:a") + 2]
    assert cmd[cmd.index("-f"):cmd.index("-f") + 2] == ["-f", "wav"]


# ── Filling transcripts across the library ──────────────────────────────

def test_bulk_transcribe_fills_every_empty_transcript(env, monkeypatch):
    from api.routers import profiles

    client, _profiles, _db, _voices, created, events = env
    second = client.post(
        "/profiles",
        data={"name": "Pong", "ref_text": "", "instruct": "male"},
        files={"ref_audio": ("voice2.wav", wav_bytes(), "audio/wav")},
    ).json()
    seen = []

    def fake_transcribe(path):
        seen.append(path)
        return "hello there"

    monkeypatch.setattr("services.asr_backend.transcribe_reference", fake_transcribe)
    monkeypatch.setattr(profiles, "_transcribable_profiles", lambda: [
        (created["id"], "Scarlet", str(_voices / created["ref_audio_path"])),
        (second["id"], "Pong", str(_voices / second["ref_audio_path"])),
    ])

    started = client.post("/profiles/transcripts/auto").json()

    assert started["started"] is True and started["total"] == 2
    _wait_for_done(client)
    status = client.get("/profiles/transcripts/auto").json()
    assert status["status"] == "done" and status["done"] == 2 and status["failed"] == 0
    assert [entry["ref_text"] for entry in status["profiles"]] == ["hello there", "hello there"]
    assert len(seen) == 2
    assert client.get(f"/profiles/{created['id']}").json()["ref_text"] == "hello there"
    assert client.get(f"/profiles/{second['id']}").json()["ref_text"] == "hello there"


def test_bulk_transcribe_reports_an_empty_library(env, monkeypatch):
    from api.routers import profiles

    client, *_ = env
    monkeypatch.setattr(profiles, "_transcribable_profiles", lambda: [])

    started = client.post("/profiles/transcripts/auto").json()

    assert started["started"] is True and started["total"] == 0
    assert started["status"] == "done"
    assert client.get("/profiles/transcripts/auto").json()["profiles"] == []


def test_bulk_transcribe_survives_one_failing_clip(env, monkeypatch):
    from api.routers import profiles

    client, _profiles, _db, _voices, created, _events = env
    second = client.post(
        "/profiles",
        data={"name": "Pong", "ref_text": "", "instruct": "male"},
        files={"ref_audio": ("voice2.wav", wav_bytes(), "audio/wav")},
    ).json()
    # The saved clip is named after the profile id, not the uploaded filename.
    failing = str(_voices / second["ref_audio_path"])

    # Saving a profile transcribes the clip as it is stored, so the stub must
    # succeed there and fail only once the bulk run owns the job.
    def flaky_transcribe(path):
        if path == failing and profiles._bulk_transcribe_job is not None:
            raise RuntimeError("decoder exploded")
        return "ok words"

    monkeypatch.setattr("services.asr_backend.transcribe_reference", flaky_transcribe)
    monkeypatch.setattr(profiles, "_transcribable_profiles", lambda: [
        (created["id"], "Scarlet", str(_voices / created["ref_audio_path"])),
        (second["id"], "Pong", str(_voices / second["ref_audio_path"])),
    ])
    print("DBG failing =", failing)
    print("DBG created path =", str(_voices / created["ref_audio_path"]))
    print("DBG second ref_text =", second["ref_text"], "created ref_text =", created["ref_text"])

    client.post("/profiles/transcripts/auto")
    _wait_for_done(client)

    status = client.get("/profiles/transcripts/auto").json()
    assert status["done"] == 1 and status["failed"] == 1
    assert status["status"] == "done"
    # The good clip kept its transcript despite the other one failing.
    assert client.get(f"/profiles/{created['id']}").json()["ref_text"] == "ok words"
    assert client.get(f"/profiles/{second['id']}").json()["ref_text"] == ""


def test_bulk_transcribe_never_overwrites_a_transcript_typed_mid_run(env, monkeypatch):
    from api.routers import profiles

    client, _profiles, _db, _voices, created, _events = env
    monkeypatch.setattr(profiles, "_transcribable_profiles", lambda: [
        (created["id"], "Scarlet", str(_voices / created["ref_audio_path"])),
    ])

    def transcribe_then_edit(path):
        # The user corrects the transcript while this clip is in flight.
        client.put(f"/profiles/{created['id']}", json={"ref_text": "my own words"})
        return "machine words"

    monkeypatch.setattr("services.asr_backend.transcribe_reference", transcribe_then_edit)

    client.post("/profiles/transcripts/auto")
    _wait_for_done(client)

    status = client.get("/profiles/transcripts/auto").json()
    assert status["skipped"] == 1 and status["done"] == 0
    assert client.get(f"/profiles/{created['id']}").json()["ref_text"] == "my own words"


def test_bulk_transcribe_treats_silence_as_skipped(env, monkeypatch):
    from api.routers import profiles

    client, _profiles, _db, _voices, created, _events = env
    monkeypatch.setattr(profiles, "_transcribable_profiles", lambda: [
        (created["id"], "Scarlet", str(_voices / created["ref_audio_path"])),
    ])
    monkeypatch.setattr("services.asr_backend.transcribe_reference", lambda path: "")

    client.post("/profiles/transcripts/auto")
    _wait_for_done(client)

    status = client.get("/profiles/transcripts/auto").json()
    assert status["skipped"] == 1 and status["failed"] == 0
    assert status["profiles"][0]["status"] == "skipped"


def test_second_run_reports_the_one_in_flight(env, monkeypatch):
    from api.routers import profiles

    client, _profiles, _db, _voices, created, _events = env
    release = threading.Event()
    monkeypatch.setattr(profiles, "_transcribable_profiles", lambda: [
        (created["id"], "Scarlet", str(_voices / created["ref_audio_path"])),
    ])

    def slow_transcribe(path):
        release.wait(timeout=10)
        return "slow words"

    monkeypatch.setattr("services.asr_backend.transcribe_reference", slow_transcribe)

    first = client.post("/profiles/transcripts/auto").json()
    second = client.post("/profiles/transcripts/auto").json()

    assert first["started"] is True
    assert second["started"] is False and second["status"] == "running"
    release.set()
    _wait_for_done(client)


def test_cancelling_stops_the_run_but_keeps_finished_work(env, monkeypatch):
    from api.routers import profiles

    client, _profiles, _db, _voices, created, _events = env
    monkeypatch.setattr(profiles, "_transcribable_profiles", lambda: [
        (created["id"], "Scarlet", str(_voices / created["ref_audio_path"])),
    ])

    def slow_transcribe(path):
        time.sleep(0.4)
        return "slow words"

    monkeypatch.setattr("services.asr_backend.transcribe_reference", slow_transcribe)

    client.post("/profiles/transcripts/auto")
    cancelled = client.delete("/profiles/transcripts/auto").json()

    assert cancelled["cancelled"] is True
    _wait_for_done(client)
    assert client.get("/profiles/transcripts/auto").json()["status"] == "cancelled"


def test_auto_transcribe_endpoints_are_registered_before_the_id_route(env):
    client, _profiles, _db, _voices, _created, _events = env
    # A literal segment must never be swallowed by /profiles/{profile_id}.
    assert client.get("/profiles/transcripts/auto").status_code == 200


def test_idle_status_before_any_run(env):
    client, *_ = env
    status = client.get("/profiles/transcripts/auto").json()
    assert status["status"] == "idle" and status["total"] == 0


def test_transcribable_profiles_skips_covered_and_missing_clips(env, stub_cut):
    from api.routers import profiles

    client, _profiles, db, voices, created, _events = env
    covered = client.post(
        "/profiles",
        data={"name": "Covered", "ref_text": "already known", "instruct": ""},
        files={"ref_audio": ("covered.wav", wav_bytes(), "audio/wav")},
    ).json()

    pending = profiles._transcribable_profiles()

    ids = [row[0] for row in pending]
    assert created["id"] in ids
    assert covered["id"] not in ids  # already has a transcript
    # A row whose clip vanished is not offered to the ASR.
    with db.db_conn() as conn:
        conn.execute(
            "UPDATE voice_profiles SET ref_audio_path='missing.wav' WHERE id=?",
            (created["id"],),
        )
    assert created["id"] not in [row[0] for row in profiles._transcribable_profiles()]


def _wait_for_done(client, timeout: float = 10.0) -> None:
    """Poll until the bulk job leaves the running state."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if client.get("/profiles/transcripts/auto").json()["status"] != "running":
            return
        time.sleep(0.02)
    raise AssertionError("bulk transcription did not finish in time")
