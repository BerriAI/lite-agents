# agent

Pydantic AI agent behind an OpenAI-compatible HTTP endpoint. All LLM
calls and persistent memory go through your LiteLLM proxy. The agent
itself holds no state — kill it, restart it, scale it horizontally;
the proxy is the spine.

```
agent/
├── app.py                  agent + tools + FastAPI — read top to bottom
├── core.py                 Deps + model factory (shared with sub-agents)
├── prompts/system.md       agent's system prompt
├── ui.html                 chat UI at /
├── subagents/              auto-discovered sub-agents
│   └── researcher/
│       ├── agent.py        exports DESCRIPTION + agent
│       ├── prompt.md
│       └── tools.py        (optional) sub-agent's own tools
├── tests/test_app.py
├── pyproject.toml
└── .env.example
```

## Run

```sh
cp .env.example .env       # set LITELLM_API_BASE + LITELLM_API_KEY + AGENT_ID
uv sync
uv run python app.py       # → http://localhost:8787
```

```sh
curl localhost:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"hi"}],"user":"alice"}'
```

Or any OpenAI client pointed at `http://localhost:8787/v1`.

## AGENT_ID

Required env var. It namespaces every memory key on the LiteLLM proxy
so multiple agents sharing one proxy don't collide on the same
`(tenant, user)` pair. Memory keys end up as
`<AGENT_ID>:<tenant>:<user>`.

Pick a short lowercase id (e.g. `engineering`, `helpdesk`,
`openclaw`) and keep it stable across deploys — changing it orphans
existing memory.

## The tools

Three layers, all surfaced to the model the same way — as Pydantic AI
tools with descriptions. The model picks one based on the description;
there's no special routing logic in your code.

**Primitives** — defined in `app.py`:

  - `fetch(url)` — HTTP GET, body truncated to 20k.
  - `remember(note)` / `forget()` — append/clear the user's memory blob.

**MCP tools** — set `MCP_SERVERS=foo,bar`; the agent connects to each
at `<proxy>/mcp/<id>` at startup. Whatever each server exposes is now
in the tool list. No code in the agent.

**Sub-agents** — folders under `subagents/`, auto-discovered.

## Adding a primitive tool

Add it to `app.py`:

```python
@agent.tool
async def lookup_user(ctx: RunContext[Deps], email: str) -> str:
    """Look up a user by email."""
    token = ctx.deps.extras["crm_token"]
    ...
```

`@agent.tool` for tools that need `ctx.deps`; `@agent.tool_plain` for
those that don't. The docstring is the contract — the model uses it
to decide when to call.

## Adding a sub-agent

Sub-agents are tools. The agent's loop sees them in the tool list with
their `DESCRIPTION` as the description; when it picks one, the wrapper
calls the sub-agent's `run()` and returns the output. There's nothing
to dispatch.

```sh
cp -r subagents/researcher subagents/pr_reviewer
$EDITOR subagents/pr_reviewer/agent.py     # update DESCRIPTION
$EDITOR subagents/pr_reviewer/prompt.md
$EDITOR subagents/pr_reviewer/tools.py     # optional
```

Each `subagents/<name>/agent.py` exposes:

  - `DESCRIPTION: str` — what the model sees in the tool list.
    This alone determines when it gets called. Write it like a contract.
  - `agent: Agent` — the Pydantic AI agent.
  - `NAME: str` *(optional)* — defaults to the folder name.

Folders prefixed with `_` or `.` are skipped — handy for templates or
WIP. `tools.py` is auto-imported if present.

## Memory

Two pieces:

  - Module-level functions in `app.py`: `memory_get`, `memory_put`,
    `memory_delete`. Thin HTTP calls to
    `<proxy>/v1/memory/<AGENT_ID>:<tenant>:<user>`.
  - Agent tools `remember` / `forget` that the model calls when the user
    says "remember that…".

A dynamic system-prompt hook (`_inject_memory`) re-injects the saved
blob on every turn — that's what makes saved notes actually useful.

Identity comes from the request: `tenant` from the `X-Agent-Tenant`
header (defaults to `"default"`), `user` from the OpenAI `user` field
or `X-Agent-User` header — or the basic-auth username when the UI is
authenticated.

## Scheduling

There's no separate tasks subsystem. If the agent needs to track
something for later — "ping me when CI on PR 1234 is green" — it just
writes a note via `remember`:

```
- WATCH: CI on github.com/foo/bar/pull/1234 — alert when green
```

The note is re-injected every turn. Whenever the agent runs next, it
sees the watchlist and can fetch / decide / report.

For "wake me up at 3am" semantics, point an external cron at the
agent that POSTs `{"messages":[{"role":"user","content":"check your
watchlist"}]}` on a schedule. The agent reads memory, evaluates each
watch, and replies (or invokes whatever delivery tool you've wired).

## Auth

Two independent gates:

  - **UI** (`/`): basic auth when `UI_USERNAME` + `UI_PASSWORD` set.
  - **API** (`/v1/chat/completions`): bearer when `AGENT_API_KEYS`
    set; basic-auth credentials are also accepted when UI auth is
    configured (so the UI's own calls work).

Set neither: the server is open. Don't ship that.

The basic-auth username flows into `Deps.user` when the request
doesn't otherwise specify one — memory scopes correctly per UI user
out of the box.

## Observability

Set `OTEL_EXPORTER_OTLP_ENDPOINT` and traces flow to any OTLP/HTTP
collector. Pydantic AI emits OTel-compatible spans natively.
`uv sync --extra otel` to install the SDK.

## Architecture notes

- The agent has no DB. Memory and MCP both live on the proxy.
- Errors raise. No `try/except` that swallows and returns an error
  string; those just delay the failure to a confusing place.
- Sub-agents are tools. There's no special routing layer — the model
  picks tools by description, and some tools happen to call out to
  smaller agents.
- The whole runtime is `app.py` (~280 lines) + `core.py` (~30). You
  can read the codebase in fifteen minutes.
