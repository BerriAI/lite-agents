"""
Agent server. Read top to bottom — that's the whole runtime.

Pattern: a router `agent` at the top, sub-agents auto-discovered from
subagents/*/agent.py and exposed as tools, a small base of primitive
tools (fetch, remember, forget, +scheduling if enabled). The router
decides when to dispatch to a specialist and when to handle a request
itself.

Layout:
    core.py             Deps + model factory (shared with sub-agents)
    app.py              this file: agent, tools, FastAPI server
    subagents/<name>/   one folder per sub-agent (auto-discovered)
        agent.py        exports DESCRIPTION + agent
        prompt.md       sub-agent system prompt
        tools.py        (optional) sub-agent-specific tools
    tasks.py            (optional) deferred tasks
    prompts/system.md   router system prompt
    ui.html             chat UI at /

  Run:    uv run python app.py

Add a sub-agent: `cp -r subagents/researcher subagents/<your_name>`
                  and edit DESCRIPTION + prompt.md.
"""
from __future__ import annotations

import base64
import importlib
import json
import logging
import os
import secrets
import sys
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator

import httpx
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, StreamingResponse
from pydantic import BaseModel
from pydantic_ai import Agent, RunContext, Tool
from pydantic_ai.mcp import MCPServerStreamableHTTP
from pydantic_ai.messages import (
    ModelRequest, ModelResponse, TextPart, UserPromptPart,
)

load_dotenv()
logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("app")

HERE = Path(__file__).parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from core import (  # noqa: E402
    AGENT_ID, Deps, LITELLM_BASE, default_model, litellm_auth,
)

UI_USER = os.environ.get("UI_USERNAME") or None
UI_PASS = os.environ.get("UI_PASSWORD") or None

# OpenTelemetry: no-op if OTEL_EXPORTER_OTLP_ENDPOINT is unset.
if os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT"):
    from opentelemetry import trace
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    provider = TracerProvider(resource=Resource.create({
        "service.name": os.environ.get("OTEL_SERVICE_NAME", "agent"),
    }))
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    trace.set_tracer_provider(provider)
    HTTPXClientInstrumentor().instrument()


# ---------------------------------------------------------------------------
# Memory: persistent per-user blob, stored on the LiteLLM proxy.
# ---------------------------------------------------------------------------


def _mem_url(tenant: str, user: str) -> str:
    return f"{LITELLM_BASE}/v1/memory/{AGENT_ID}:{tenant}:{user}"


async def memory_get(tenant: str, user: str) -> str:
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get(_mem_url(tenant, user), headers=litellm_auth())
    if r.status_code == 404:
        return ""
    r.raise_for_status()
    return (r.json().get("value") or "").strip()


async def memory_put(tenant: str, user: str, value: str) -> None:
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.put(
            _mem_url(tenant, user), headers=litellm_auth(),
            json={"value": value},
        )
    r.raise_for_status()


async def memory_delete(tenant: str, user: str) -> None:
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.delete(_mem_url(tenant, user), headers=litellm_auth())
    if r.status_code != 404:
        r.raise_for_status()


# ---------------------------------------------------------------------------
# MCP toolsets: servers fronted by the LiteLLM proxy at /mcp/<id>.
# ---------------------------------------------------------------------------


def _mcp_toolsets() -> list[MCPServerStreamableHTTP]:
    ids = [s.strip() for s in os.environ.get("MCP_SERVERS", "").split(",")
           if s.strip()]
    return [
        MCPServerStreamableHTTP(
            url=f"{LITELLM_BASE}/mcp/{sid}", id=sid, headers=litellm_auth(),
        )
        for sid in ids
    ]


# ---------------------------------------------------------------------------
# Sub-agent discovery: every subagents/<name>/agent.py exposing
# `DESCRIPTION` and `agent` becomes a tool on the router.
# Folders prefixed `_` or `.` are skipped — useful for templates / WIP.
# ---------------------------------------------------------------------------


def _discover_subagents() -> list[Tool]:
    base = HERE / "subagents"
    if not base.exists():
        return []
    out: list[Tool] = []
    for d in sorted(base.iterdir()):
        if not d.is_dir() or d.name.startswith(("_", "."))\
                or d.name == "__pycache__":
            continue
        if not (d / "agent.py").exists():
            continue
        mod = importlib.import_module(f"subagents.{d.name}.agent")
        # Side-effect import: tools.py registers tools on the sub-agent.
        if (d / "tools.py").exists():
            importlib.import_module(f"subagents.{d.name}.tools")
        sub: Agent = mod.agent
        name: str = getattr(mod, "NAME", d.name)
        description: str = mod.DESCRIPTION
        out.append(_subagent_tool(name, description, sub))
        log.info("subagent registered: %s", name)
    return out


def _subagent_tool(name: str, description: str, sub: Agent) -> Tool:
    """Wrap a sub-agent so the router can call it like any other tool."""
    async def _route(ctx: RunContext[Deps], request: str) -> str:
        r = await sub.run(request, deps=ctx.deps, usage=ctx.usage)
        return str(r.output)
    _route.__name__ = name
    return Tool(_route, name=name, description=description)


# ---------------------------------------------------------------------------
# The router agent.
# ---------------------------------------------------------------------------


agent: Agent[Deps, str] = Agent(
    default_model(),
    deps_type=Deps,
    system_prompt=(HERE / "prompts" / "system.md").read_text(),
    toolsets=_mcp_toolsets(),
    tools=_discover_subagents(),
)


@agent.system_prompt
async def _inject_memory(ctx: RunContext[Deps]) -> str:
    blob = await memory_get(ctx.deps.tenant, ctx.deps.user)
    return f"User memory:\n{blob}" if blob else ""


# ---------------------------------------------------------------------------
# Primitive tools.
# ---------------------------------------------------------------------------


@agent.tool
async def remember(ctx: RunContext[Deps], note: str) -> str:
    """Save a long-lived note about this user. Re-injected every turn."""
    blob = await memory_get(ctx.deps.tenant, ctx.deps.user)
    new = f"{blob}\n- {note}".strip() if blob else f"- {note}"
    await memory_put(ctx.deps.tenant, ctx.deps.user, new)
    return f"saved: {note}"


@agent.tool
async def forget(ctx: RunContext[Deps]) -> str:
    """Clear all saved notes about this user."""
    await memory_delete(ctx.deps.tenant, ctx.deps.user)
    return "cleared"


@agent.tool_plain
async def fetch(url: str) -> str:
    """Fetch a URL and return its body (truncated to 20k chars)."""
    async with httpx.AsyncClient(
        timeout=20, follow_redirects=True,
        headers={"user-agent": "agent/0.1"},
    ) as c:
        r = await c.get(url)
    r.raise_for_status()
    body = r.text
    return body if len(body) <= 20_000 else body[:20_000] + "\n…[truncated]"


# Deferred-task wiring. ENABLE_TASKS=1 (plus DATABASE_URL + the
# migration applied) exposes three tools backed by a Postgres-backed
# dispatcher. The DB is the agent's own — atomic claim-and-fire across
# replicas via FOR UPDATE SKIP LOCKED.
if os.environ.get("ENABLE_TASKS") == "1":
    import tasks as _tasks

    @agent.tool
    async def schedule(
        ctx: RunContext[Deps], title: str, check_prompt: str,
        minutes: int = 60,
    ) -> str:
        """Schedule a task that fires once when its condition is met."""
        tid = await _tasks.create(
            tenant=ctx.deps.tenant, user=ctx.deps.user,
            channel=ctx.deps.extras.get("channel", "http"),
            title=title, check_prompt=check_prompt, minutes=minutes,
        )
        return f"scheduled `{tid}`: {title}"

    @agent.tool
    async def list_tasks(ctx: RunContext[Deps]) -> str:
        """List the user's pending scheduled tasks."""
        rows = await _tasks.list_for(ctx.deps.tenant, ctx.deps.user)
        if not rows:
            return "no pending tasks"
        return "\n".join(
            f"- `{r['id']}` {r['title']} "
            f"(next: {r['next_run_at']:%Y-%m-%d %H:%M} UTC)"
            for r in rows
        )

    @agent.tool
    async def cancel(ctx: RunContext[Deps], task_id: str) -> str:
        """Cancel a pending task by id."""
        ok = await _tasks.cancel(task_id, ctx.deps.tenant, ctx.deps.user)
        return "cancelled" if ok else "no matching pending task"


# ---------------------------------------------------------------------------
# Auth.
# ---------------------------------------------------------------------------


def _allowed_keys() -> set[str]:
    raw = os.environ.get("AGENT_API_KEYS", "")
    return {k.strip() for k in raw.split(",") if k.strip()}


def _basic_user(request: Request) -> str | None:
    """Return the authenticated UI username if basic auth header matches."""
    if not (UI_USER and UI_PASS):
        return None
    h = request.headers.get("authorization", "")
    if not h.lower().startswith("basic "):
        return None
    try:
        user, _, pw = base64.b64decode(h[6:]).decode().partition(":")
    except Exception:  # noqa: BLE001
        return None
    if (secrets.compare_digest(user, UI_USER)
            and secrets.compare_digest(pw, UI_PASS)):
        return user
    return None


def _bearer_ok(request: Request) -> bool:
    keys = _allowed_keys()
    if not keys:
        return False
    h = request.headers.get("authorization", "")
    return h.lower().startswith("bearer ") and h[7:].strip() in keys


def require_ui_auth(request: Request) -> None:
    """Gate for / (the chat UI). Basic auth only, when configured."""
    if not (UI_USER and UI_PASS):
        return
    if _basic_user(request):
        return
    raise HTTPException(
        401, "auth required",
        headers={"www-authenticate": 'Basic realm="agent"'},
    )


def require_api_auth(request: Request) -> None:
    """Gate for /v1/chat/completions. Bearer or basic accepted."""
    bearer_configured = bool(_allowed_keys())
    ui_configured = bool(UI_USER and UI_PASS)
    if not bearer_configured and not ui_configured:
        return
    if bearer_configured and _bearer_ok(request):
        return
    if ui_configured and _basic_user(request):
        return
    raise HTTPException(401, "auth required")


# ---------------------------------------------------------------------------
# HTTP: OpenAI-compatible /v1/chat/completions + tiny web UI.
# ---------------------------------------------------------------------------


class Msg(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: list[Msg]
    stream: bool = False
    user: str | None = None
    model_config = {"extra": "allow"}


def _to_history(
    msgs: list[Msg],
) -> tuple[str, list[ModelRequest | ModelResponse]]:
    if not msgs or msgs[-1].role != "user":
        raise HTTPException(400, "last message must be from user")
    history: list[ModelRequest | ModelResponse] = []
    for m in msgs[:-1]:
        if m.role == "user":
            history.append(ModelRequest(parts=[UserPromptPart(content=m.content)]))
        elif m.role == "assistant":
            history.append(ModelResponse(parts=[TextPart(content=m.content)]))
    return msgs[-1].content, history


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    scheduler = None
    if os.environ.get("ENABLE_TASKS") == "1":
        scheduler = _tasks.start(agent)
    try:
        yield
    finally:
        if scheduler is not None:
            scheduler.shutdown(wait=False)
        if os.environ.get("ENABLE_TASKS") == "1":
            await _tasks.close_pool()


app = FastAPI(lifespan=lifespan)

if os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT"):
    from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
    FastAPIInstrumentor.instrument_app(app)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/v1/models")
async def models() -> dict[str, Any]:
    return {"object": "list", "data": [
        {"id": "agent", "object": "model", "owned_by": "you"},
    ]}


@app.post("/v1/chat/completions",
          dependencies=[Depends(require_api_auth)])
async def chat(req: ChatRequest, request: Request) -> Any:
    prompt, history = _to_history(req.messages)
    deps = Deps(
        tenant=request.headers.get("x-agent-tenant", "default"),
        user=(req.user
              or request.headers.get("x-agent-user")
              or _basic_user(request)
              or "anon"),
    )
    if req.stream:
        return StreamingResponse(
            _stream(prompt, history, deps),
            media_type="text/event-stream",
        )
    result = await agent.run(prompt, deps=deps, message_history=history)
    return _completion((result.output or "").strip())


async def _stream(
    prompt: str, history: list[Any], deps: Deps,
) -> AsyncIterator[bytes]:
    cid = f"chatcmpl-{uuid.uuid4().hex}"
    yield _chunk(cid, {"role": "assistant"})
    async with agent.run_stream(
        prompt, deps=deps, message_history=history,
    ) as s:
        async for delta in s.stream_text(delta=True):
            if delta:
                yield _chunk(cid, {"content": delta})
    yield _chunk(cid, {}, finish="stop")
    yield b"data: [DONE]\n\n"


def _chunk(
    cid: str, delta: dict[str, Any], finish: str | None = None,
) -> bytes:
    payload = {
        "id": cid, "object": "chat.completion.chunk",
        "created": int(time.time()), "model": "agent",
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    }
    return f"data: {json.dumps(payload)}\n\n".encode()


def _completion(text: str) -> dict[str, Any]:
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": "agent",
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": text},
            "finish_reason": "stop",
        }],
    }


@app.get("/", response_class=HTMLResponse,
         dependencies=[Depends(require_ui_auth)])
async def index() -> str:
    return (HERE / "ui.html").read_text()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app:app",
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "8787")),
    )
