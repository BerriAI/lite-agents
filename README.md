# shin-builder-js

JavaScript/Node.js port of [shin-builder](https://github.com/BerriAI/shin-builder).

AI agent that receives issues via web chat, plans a fix against the LiteLLM codebase, and waits for approval before implementing.

## Structure

```
├── src/
│   ├── app.js          # Express server + SSE streaming
│   ├── tasks.js        # WorkflowRunClient → LiteLLM proxy API
│   ├── core.js         # Claude CLI subprocess runner
│   ├── index.html      # Chat UI
│   └── workflows.html  # Workflow run viewer
├── skills/
│   ├── plan_repro.md   # ← edit to change plan behaviour
│   └── implement.md    # ← edit to change implement behaviour
├── mcp.json
└── package.json
```

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Clone LiteLLM repo

```bash
git clone https://github.com/BerriAI/litellm ~/github/litellm
```

### 3. Authenticate Claude Code

```bash
claude auth login
```

### 4. Set env vars

Copy `.env.example` to `.env` and fill in:

```
LITELLM_PROXY_URL=https://your-litellm-proxy.example.com
LITELLM_API_KEY=sk-...
LITELLM_REPO=/path/to/litellm   # optional, default: ~/github/litellm
PORT=8001                        # optional, default: 8001
```

## Run

```bash
node --env-file=.env src/app.js
```

Open http://localhost:8001 for the chat UI, http://localhost:8001/workflows to view runs.

## Env vars

| Variable | Required | Default |
|---|---|---|
| `LITELLM_PROXY_URL` | Yes | — |
| `LITELLM_API_KEY` | Yes | — |
| `LITELLM_REPO` | No | `~/github/litellm` |
| `CLAUDE_WORKDIR` | No | `~/claude-workspace` |
| `LITELLM_SANDBOX_DB_URL` | No | — |
| `PORT` | No | `8001` |
