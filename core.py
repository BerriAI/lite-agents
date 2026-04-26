"""
Shared module: deps, env, model factory.

Anything imported by both app.py and subagents/* lives here. Keeps
sub-agents free of circular imports — they import from `core`, not
from `app`.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any

from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.litellm import LiteLLMProvider

LITELLM_BASE = os.environ["LITELLM_API_BASE"].rstrip("/")
LITELLM_KEY = os.environ["LITELLM_API_KEY"]
DEFAULT_MODEL = os.environ.get("LITELLM_MODEL", "claude-sonnet-4-6")

# Stable identifier for this agent. Prefixes every memory key on the
# LiteLLM proxy so multiple agents sharing a proxy don't collide on
# the same (tenant, user) pair. Pick a short lowercase id and keep it
# stable across deploys (e.g. "engineering", "helpdesk", "openclaw").
AGENT_ID = os.environ["AGENT_ID"]


@dataclass
class Deps:
    """Per-request context. Same shape across the agent and every sub-agent."""
    tenant: str
    user: str
    extras: dict[str, Any] = field(default_factory=dict)


def default_model(name: str | None = None) -> OpenAIChatModel:
    """Build a Pydantic AI model that routes through the LiteLLM proxy."""
    return OpenAIChatModel(
        name or DEFAULT_MODEL,
        provider=LiteLLMProvider(api_base=LITELLM_BASE, api_key=LITELLM_KEY),
    )


def litellm_auth() -> dict[str, str]:
    return {"authorization": f"Bearer {LITELLM_KEY}"}
