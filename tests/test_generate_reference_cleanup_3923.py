"""The desktop /generate endpoint exposes reference cleanup (#3923).

`/v1/audio/speech` has accepted `preprocess_prompt` for a while
(test_openai_speech_extension_controls.py), but the endpoint the desktop Clone
page actually calls did not declare it — so the one control that decides
whether a breath inside a pause survives into the clone was unreachable from
the UI. Omitting it must stay distinguishable from False: the engine default
(True) applies when the field is absent, and False must reach the encoder,
because the encoded prompt differs per value (test_clone_prompt_cache.py).
"""
from __future__ import annotations

import importlib
import os

import pytest
import torch
from fastapi.testclient import TestClient

os.environ.setdefault("OMNIVOICE_MODEL", "test")
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")


@pytest.fixture()
def engine(monkeypatch):
    tts = importlib.import_module("services.tts_backend")

    class _Engine(tts.TTSBackend):
        id = "ref-cleanup-engine"
        display_name = "Reference cleanup engine (test)"
        gpu_compat = ("cpu",)
        calls: list = []

        @property
        def sample_rate(self) -> int:
            return 24000

        @property
        def supported_languages(self) -> list[str]:
            return ["multi"]

        @classmethod
        def is_available(cls):
            return True, "ready"

        def generate(self, text, **kw):
            type(self).calls.append(kw)
            return torch.zeros(1, 2400)

    _Engine.calls = []
    inst = _Engine()
    monkeypatch.setitem(tts._REGISTRY, _Engine.id, _Engine)
    monkeypatch.setattr(tts, "get_active_tts_backend", lambda: inst)
    monkeypatch.setattr(tts, "get_engine_instance_for", lambda _id: inst)
    from services import engine_routing

    async def _profile(*_a, **_k):
        return {
            "effective_device": "cpu",
            "min_vram_gb": 0.0,
            "runtime_hardware_family": "cpu",
            "runtime_vram_gb": None,
            "routing_status": "ok",
        }

    monkeypatch.setattr(engine_routing, "runtime_compute_profile_async", _profile)
    return _Engine


@pytest.fixture()
def client():
    from main import app

    return TestClient(app, client=("127.0.0.1", 50000))


def _generate(client, **extra):
    return client.post(
        "/generate",
        data={"text": "Hi.", "engine": "ref-cleanup-engine", **extra},
    )


def test_omitting_the_field_leaves_the_engine_default(client, engine):
    """A request that does not mention cleanup must not pin it either way."""
    assert _generate(client).status_code == 200
    assert "preprocess_prompt" not in engine.calls[-1]


def test_false_reaches_the_engine_instead_of_being_dropped(client, engine):
    """The whole point: False is a real choice, not a silently ignored one."""
    assert _generate(client, preprocess_prompt="false").status_code == 200
    assert engine.calls[-1]["preprocess_prompt"] is False


def test_true_stays_true(client, engine):
    """An explicit True matches the engine default and is sent as such."""
    assert _generate(client, preprocess_prompt="true").status_code == 200
    assert engine.calls[-1]["preprocess_prompt"] is True
