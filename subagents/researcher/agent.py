"""
Researcher sub-agent.

Routed to when the user asks an open-ended factual question that
benefits from looking at the web (definitions, comparisons, current
events, "how does X work").

Convention: every sub-agent module exposes:
    DESCRIPTION : str   - one-paragraph description for the router's tool list
    agent       : Agent - the Pydantic AI agent instance
    NAME        : str   - (optional) tool name; defaults to the folder name

Tools live in tools.py and are imported automatically at discovery.
"""
from __future__ import annotations

from pathlib import Path

from pydantic_ai import Agent

from core import Deps, default_model

DESCRIPTION = (
    "Open-ended research. Pass a question; the researcher fetches web "
    "pages and returns a concise answer with citations. Use for factual "
    "questions, comparisons, definitions, and current events."
)

agent: Agent[Deps, str] = Agent(
    default_model(),
    deps_type=Deps,
    output_type=str,
    system_prompt=(Path(__file__).parent / "prompt.md").read_text(),
)
