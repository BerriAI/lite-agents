"""
Sub-agent-specific tools. Imported automatically by the discovery
machinery in app.py — registering tools here is a side-effect of
importing this module.
"""
from __future__ import annotations

import httpx

from .agent import agent


@agent.tool_plain
async def web_get(url: str) -> str:
    """Fetch a URL and return its body (truncated to 20k chars).

    Use for any web page, doc, README, blog post, or HTML resource.
    Pass the full URL including scheme.
    """
    async with httpx.AsyncClient(
        timeout=20, follow_redirects=True,
        headers={"user-agent": "agent-researcher/0.1"},
    ) as c:
        r = await c.get(url)
    r.raise_for_status()
    body = r.text
    return body if len(body) <= 20_000 else body[:20_000] + "\n…[truncated]"
