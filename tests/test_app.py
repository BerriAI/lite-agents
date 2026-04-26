"""Smoke tests. No live LLM. Verifies wiring only."""
from __future__ import annotations

import importlib
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("LITELLM_API_BASE", "http://0.0.0.0:4000")
os.environ.setdefault("LITELLM_API_KEY", "sk-test")
os.environ.setdefault("AGENT_ID", "test")


def _reload_app():
    # core reads env at import time; reload it first so monkeypatched
    # env vars (AGENT_ID etc.) propagate.
    if "core" in sys.modules:
        importlib.reload(sys.modules["core"])
    if "app" in sys.modules:
        return importlib.reload(sys.modules["app"])
    return importlib.import_module("app")


def test_routes() -> None:
    app = _reload_app()
    paths = {r.path for r in app.app.routes if hasattr(r, "path")}
    assert {"/", "/health", "/v1/models", "/v1/chat/completions"} <= paths


def test_primitives_registered() -> None:
    app = _reload_app()
    names = set(app.agent._function_toolset.tools.keys())
    assert {"remember", "forget", "fetch"} <= names


def test_subagent_discovered() -> None:
    app = _reload_app()
    names = set(app.agent._function_toolset.tools.keys())
    # The example sub-agent is exposed to the router as a tool.
    assert "researcher" in names


def test_to_history_round_trip() -> None:
    import pytest
    from fastapi import HTTPException

    app = _reload_app()
    prompt, history = app._to_history([
        app.Msg(role="user", content="hi"),
        app.Msg(role="assistant", content="hello"),
        app.Msg(role="user", content="what's up"),
    ])
    assert prompt == "what's up"
    assert len(history) == 2

    with pytest.raises(HTTPException):
        app._to_history([])

    with pytest.raises(HTTPException):
        app._to_history([app.Msg(role="assistant", content="x")])


def test_mcp_toolsets_from_env(monkeypatch) -> None:
    monkeypatch.setenv("MCP_SERVERS", "alpha, beta")
    app = _reload_app()
    ids = {t.id for t in app.agent.toolsets if hasattr(t, "id")}
    assert {"alpha", "beta"} <= ids


def test_memory_url(monkeypatch) -> None:
    monkeypatch.setenv("AGENT_ID", "myagent")
    app = _reload_app()
    assert app._mem_url("t", "u").endswith("/v1/memory/myagent:t:u")


def test_ui_open_without_creds(monkeypatch) -> None:
    from fastapi.testclient import TestClient

    monkeypatch.delenv("UI_USERNAME", raising=False)
    monkeypatch.delenv("UI_PASSWORD", raising=False)
    app = _reload_app()
    client = TestClient(app.app)
    assert client.get("/").status_code == 200


def test_ui_basic_auth_when_configured(monkeypatch) -> None:
    from fastapi.testclient import TestClient

    monkeypatch.setenv("UI_USERNAME", "admin")
    monkeypatch.setenv("UI_PASSWORD", "secret")
    app = _reload_app()
    client = TestClient(app.app)
    assert client.get("/").status_code == 401
    assert client.get("/", auth=("admin", "wrong")).status_code == 401
    assert client.get("/", auth=("admin", "secret")).status_code == 200


def test_api_open_without_any_auth(monkeypatch) -> None:
    from fastapi.testclient import TestClient

    monkeypatch.delenv("UI_USERNAME", raising=False)
    monkeypatch.delenv("UI_PASSWORD", raising=False)
    monkeypatch.delenv("AGENT_API_KEYS", raising=False)
    app = _reload_app()
    client = TestClient(app.app)
    # No auth required, but messages must validate.
    r = client.post("/v1/chat/completions", json={"messages": []})
    assert r.status_code == 400


def test_api_accepts_basic_when_ui_configured(monkeypatch) -> None:
    from fastapi.testclient import TestClient

    monkeypatch.setenv("UI_USERNAME", "admin")
    monkeypatch.setenv("UI_PASSWORD", "secret")
    monkeypatch.delenv("AGENT_API_KEYS", raising=False)
    app = _reload_app()
    client = TestClient(app.app)
    # Without auth: 401.
    r = client.post("/v1/chat/completions", json={"messages": []})
    assert r.status_code == 401
    # With basic: validation kicks in (400 = past auth gate).
    r = client.post(
        "/v1/chat/completions", json={"messages": []},
        auth=("admin", "secret"),
    )
    assert r.status_code == 400
