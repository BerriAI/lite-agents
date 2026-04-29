# lite-agents

a thin TypeScript framework for running AI agents with durable task state.

chat → agent thinks → you approve → agent implements. task state survives restarts.

```
┌──────────┐     ┌──────────────────────────┐     ┌─────────────────┐
│  Chat UI │────▶│  grill → plan → implement │────▶│  LiteLLM proxy  │
│          │◀────│  human gate at each step  │◀────│  task state     │
└──────────┘     └──────────────────────────┘     │  run events     │
                                                   │  messages       │
                                                   └─────────────────┘
```

## Install

```bash
git clone https://github.com/BerriAI/lite-agents
cd lite-agents
npm install
```

## Run

```bash
LITELLM_PROXY_URL=http://localhost:4000 \
LITELLM_API_KEY=sk-... \
npm start
```

Open http://localhost:8001

## Customize

### 1. Swap the agent

Edit `src/agent.ts`. Default is Claude Code via `@anthropic-ai/claude-agent-sdk`:

```typescript
// src/agent.ts — edit this file to swap agents, nothing else changes
export { claudeCodeAgent as agent } from "./agents/claude-code.js";
```

Implement `AgentEntrypoint` from `src/agent-spec.ts` to plug in any framework:

```typescript
import type { AgentEntrypoint } from "./agent-spec.js";

export const agent: AgentEntrypoint = async function*(prompt, { cwd, resumeId }) {
  // yield AgentMessage events — text, tool_call, tool_result, stats, error
  yield { type: "text", text: "done" };
};
```

### 2. Add skills

Drop `.md` files into `skills/`. They are loaded by name and injected into prompts:

```
skills/
  grill_me.md      # injected during the grill (clarification) stage
  plan_repro.md    # injected during planning
  implement.md     # injected during implementation
```

## How it works

Three stages, each a human approval gate:

1. **Grill** — agent reads the issue, asks 2–3 focused clarifying questions
2. **Plan** — agent writes a repro + fix plan; you approve, correct, or skip
3. **Implement** — agent executes the plan in an isolated git worktree

State (task status, run events, conversation) persists in the LiteLLM proxy DB. Kill the server mid-run, restart, pick the task from the sidebar — Claude `--resume` ID is stored in the last event and recovery is automatic.

## Env vars

| Var | Default |
|-----|---------|
| `LITELLM_PROXY_URL` | required |
| `LITELLM_API_KEY` | required |
| `LITELLM_REPO` | `~/github/litellm` |
| `PORT` | `8001` |

## Requirements

- Node.js 20+
- Claude Code CLI authenticated: `claude auth login`
- LiteLLM proxy with workflow runs API (`POST /v1/workflows/runs`)
