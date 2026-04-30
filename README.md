# lite-agents

run AI agents without managing infrastructure.

you get:

- **durable workflows** — tasks survive restarts, resume mid-run after crashes
- **sessions** — conversation history persisted per run, Claude `--resume` IDs stored automatically
- **memory** — agent reads/writes to an isolated git worktree per task; state never leaks between runs
- **cron** — schedule agents on a recurring trigger via LiteLLM proxy

backed by LiteLLM proxy. no database to set up, no queue to run, no state management to write.

---

## Get started

### 1. Fork the repo

```bash
git clone https://github.com/BerriAI/lite-agents
cd lite-agents
npm install
```

### 2. Add skills

Skills are `.md` files injected into agent prompts. Drop them in `skills/` — they load automatically:

```
skills/
  grill_me.md      # how the agent clarifies requirements
  plan_repro.md    # how the agent plans a fix
  implement.md     # how the agent executes
```

Edit these to change agent behaviour without touching code.

### 3. Plug in your agent

Edit `src/agent.ts` — this is the only file you touch to swap agent frameworks:

```typescript
// src/agent.ts
export { claudeCodeAgent as agent } from "./agents/claude-code.js";
```

To use your own agent, implement `AgentEntrypoint` from `src/agent-spec.ts`:

```typescript
import type { AgentEntrypoint } from "./agent-spec.js";

export const agent: AgentEntrypoint = async function*(prompt, { cwd, resumeId }) {
  // yield AgentMessage events as your agent works
  // resumeId is set when resuming an interrupted run
  yield { type: "text", text: "done" };
};
```

Any agent framework works — Claude Agent SDK, PydanticAI, LangGraph, raw API calls.

### 4. Run

```bash
LITELLM_PROXY_URL=http://localhost:4000 \
LITELLM_API_KEY=sk-... \
npm start
```

Open http://localhost:8001

---

## How it works

Three stages, each a human approval gate:

```
describe issue
      │
      ▼
  ┌───────┐   clarifying     ┌──────┐
  │ Grill │ ──questions──▶   │ You  │
  │       │ ◀──approve/fix── │      │
  └───────┘                  └──────┘
      │ approved
      ▼
  ┌──────┐    plan ready     ┌──────┐
  │ Plan │ ──────────────▶   │ You  │
  │      │ ◀───approve────── │      │
  └──────┘                   └──────┘
      │ approved
      ▼
  ┌──────────┐
  │ Implement│ ──▶ git worktree ──▶ PR
  └──────────┘
```

All state is stored in LiteLLM proxy DB (`WorkflowRun`, `WorkflowEvent`, `WorkflowMessage`). Kill the server, restart, pick any task from the sidebar — runs continue from where they left off.

---

## Env vars

| Var | Default |
|-----|---------|
| `LITELLM_PROXY_URL` | required |
| `LITELLM_API_KEY` | required |
| `LITELLM_REPO` | `~/github/litellm` |
| `PORT` | `8001` |

## Requirements

- Node.js 20+
- Claude Code CLI: `claude auth login`
- LiteLLM proxy with workflow runs API
