# agent

A minimal production template for self-hosted chat agents — with support for 100+ LLMs, UI, memory, task scheduling, and MCPs via LiteLLM Proxy. The agent is deployed behind a `/v1/chat/completions` endpoint.

The repo is meant to be forked and adapted.

```
agent/
├── app.py                  agent + tools + FastAPI — read top to bottom
├── core.py                 Deps + model factory (shared with sub-agents)
├── tasks.py                optional: Postgres-backed deferred tasks
├── prompts/system.md       agent's system prompt
├── ui.html                 chat UI at /
├── subagents/              auto-discovered sub-agents
│   └── researcher/
│       ├── agent.py        exports DESCRIPTION + agent
│       ├── prompt.md
│       └── tools.py        (optional) sub-agent's own tools
├── migrations/
│   └── 001_tasks.sql       run once before enabling tasks
├── tests/test_app.py
├── docker-compose.yml      `docker compose up` — agent + Postgres
├── Dockerfile
├── pyproject.toml
└── .env.example
```

## Quickstart with docker-compose

```sh
cp .env.example .env       # set LITELLM_API_BASE + LITELLM_API_KEY + AGENT_ID
docker compose up --build  # → http://localhost:8787
```

`docker-compose.yml` brings up Postgres alongside the agent, mounts
`migrations/` into the postgres init dir so the schema is applied on
first boot, and wires `ENABLE_TASKS=1` so the deferred-tasks tools
light up.

## Quickstart without docker

```sh
cp .env.example .env       # set LITELLM_API_BASE + LITELLM_API_KEY + AGENT_ID
uv sync
uv run python app.py       # → http://localhost:8787

# Optional: enable deferred tasks
psql "$DATABASE_URL" -f migrations/001_tasks.sql
echo 'ENABLE_TASKS=1' >> .env
uv run python app.py
```

## Talking to it

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
  - `schedule(title, check_prompt, minutes)` /
    `list_tasks()` / `cancel(id)` — only when `ENABLE_TASKS=1`.

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

## Deferred tasks

A row in `tasks` per "ping me when X" the agent is tracking. Every
60s, `tasks._tick` claims due rows with `FOR UPDATE SKIP LOCKED`,
runs `check_agent` (a small specialist that returns
`{done, reason, message}`), and on `done=True` atomically flips
`pending → fired` and invokes `tasks.delivery`. The DB does the
coordination — N replicas of the agent can run the same dispatcher
without double-firing.

Default `delivery` just logs. To push to Slack / email / a webhook,
set the callback before the FastAPI lifespan starts:

```python
import tasks

async def deliver(task: dict, message: str) -> None:
    await slack.chat_postMessage(channel=task["channel"], text=message)

tasks.delivery = deliver
```

Tools wired when `ENABLE_TASKS=1`:

  - `schedule(title, check_prompt, minutes)` — create a task.
  - `list_tasks()` — pending tasks for the current user.
  - `cancel(task_id)` — abort.

Schema in `migrations/001_tasks.sql`. With docker-compose it's applied
automatically on first boot.

## Auth

Two independent gates:

  - **UI** (`/`): basic auth when `UI_USERNAME` + `UI_PASSWORD` set.
  - **API** (`/v1/chat/completions`): bearer when `AGENT_API_KEYS`
    set; basic-auth credentials are also accepted when UI auth is
    configured (so the UI's own calls work).

Set neither: the server is open. Don't ship that.

The basic-auth username flows into `Deps.user` when the request
doesn't otherwise specify one — memory and tasks scope correctly per
UI user out of the box.

## Observability

Set `OTEL_EXPORTER_OTLP_ENDPOINT` and traces flow to any OTLP/HTTP
collector. Pydantic AI emits OTel-compatible spans natively.
`uv sync --extra otel` to install the SDK.

## Architecture notes

- LLM and memory live on the LiteLLM proxy.
- The agent has its own Postgres only when tasks are enabled — it's
  the right place because multi-replica claim-and-fire needs atomic
  reads/writes (`FOR UPDATE SKIP LOCKED`) that the proxy isn't shaped
  to provide.
- Errors raise. No `try/except` that swallows and returns an error
  string; those just delay the failure to a confusing place.
- Sub-agents are tools. There's no special routing layer — the model
  picks tools by description, and some tools happen to call out to
  smaller agents.
- The whole runtime is `app.py` (~320 lines) + `core.py` (~30) +
  optional `tasks.py` (~250). You can read the codebase in fifteen
  minutes.
