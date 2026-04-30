# lite-agents

Run AI agents without managing infrastructure.

Kill the server mid-run. Restart. Pick up where you left off.

---

You get four things:

| | |
|---|---|
| **durable runs** | tasks survive restarts, resume after crashes |
| **sessions** | conversation history persisted per run |
| **memory** | each task gets its own git worktree — state never leaks between runs |
| **cron** | schedule agents on a recurring trigger |

Backed by LiteLLM gateway. It stores run state, conversation history, and the resume ID needed to pick up a crashed Claude session. No database to set up, no queue to run.

```
your agent  ──▶  LiteLLM gateway  ──▶  WorkflowRun / WorkflowEvent / WorkflowMessage
                 (stores everything)
```

---

## Get started

### 1. Scaffold

```bash
npx lite-agents init
cd my-agent
npm install
```

Or clone directly:

```bash
git clone https://github.com/BerriAI/lite-agents
cd lite-agents
npm install
```

### 2. Configure

```bash
cp .env.example .env
```

```env
LITELLM_PROXY_URL=http://localhost:4000
LITELLM_API_KEY=sk-...
REPO_PATH=/path/to/your/git/repo
PORT=8001
```

`REPO_PATH` is the git repo the agent checks out worktrees from.

### 3. Add skills

Skills are `.md` files injected into agent prompts. Drop them in `skills/` — they load automatically:

```
skills/
  grill_me.md      # how the agent clarifies requirements
  plan_repro.md    # how the agent plans a fix
  implement.md     # how the agent executes
```

Edit these to change agent behaviour without touching code.

### 4. Plug in your agent

`src/agent.ts` is the only file you touch to swap agent implementations:

```typescript
// src/agent.ts
export { claudeCodeAgent as agent } from "./agents/claude-code.js";
```

Default: Claude Code via `@anthropic-ai/claude-agent-sdk`.

To use your own agent, implement `AgentEntrypoint` from `src/agent-spec.ts`:

```typescript
import type { AgentEntrypoint } from "./agent-spec.js";

export const agent: AgentEntrypoint = async function*(prompt, { cwd, resumeId }) {
  // yield AgentMessage events as your agent works
  // resumeId is set when resuming an interrupted run
  yield { type: "text", text: "done" };
};
```

Any agent implementation works — PydanticAI, LangGraph, raw API calls, whatever.

### 5. Run

```bash
npm start
```

Open http://localhost:8001

---

## Env vars

| Var | Required | Default |
|-----|----------|---------|
| `LITELLM_PROXY_URL` | yes | — |
| `LITELLM_API_KEY` | yes | — |
| `REPO_PATH` | yes | — |
| `PORT` | no | `8001` |

## Requirements

- Node.js 20+
- LiteLLM proxy with workflow runs API enabled
- Claude Code CLI (for the default agent): `claude auth login`
