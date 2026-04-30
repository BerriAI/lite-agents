import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import type { AgentEntrypoint, AgentMessage } from "./agent-spec.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

if (!process.env.REPO_PATH) {
  throw new Error("REPO_PATH is required — set it to the git repo you want the agent to work in");
}
const REPO_PATH = process.env.REPO_PATH;
const SKILLS_DIR = join(__dirname, "../skills");

// AgentEvent extends AgentMessage with framework-internal signals
export type AgentEvent =
  | AgentMessage
  | { type: "status"; text: string }
  | { type: "_worktree"; path: string }

export function loadSkill(name: string): string {
  const p = join(SKILLS_DIR, `${name}.md`);
  try { return readFileSync(p, "utf8"); } catch { return ""; }
}

function worktreePath(taskId: string): string {
  return join(REPO_PATH, ".claude", "worktrees", `task-${taskId}`);
}

export async function provisionWorktree(taskId: string): Promise<string> {
  const wt = worktreePath(taskId);
  if (!existsSync(wt)) {
    await runCommand("git", ["worktree", "add", wt, "-b", `task-${taskId}`], REPO_PATH);
  }
  return wt;
}

function runCommand(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.on("close", (code: number | null) => {
      if (code !== 0) reject(new Error(`${cmd} failed: ${stderr}`));
      else resolve();
    });
  });
}

// ── Stage runners ─────────────────────────────────────────────────────────────

export async function* runGrill(
  agent: AgentEntrypoint,
  taskId: string,
  prompt: string,
  resumeId?: string | null
): AsyncGenerator<AgentEvent> {
  if (resumeId) {
    yield* agent(prompt, { cwd: worktreePath(taskId), taskId, resumeId });
    return;
  }

  yield { type: "status", text: "⚙ Provisioning worktree…" };
  let cwd: string;
  try { cwd = await provisionWorktree(taskId); }
  catch (e) { yield { type: "error", text: String(e) }; return; }
  yield { type: "status", text: `✓ Worktree: task-${taskId}` };
  yield { type: "_worktree", path: cwd };

  const grillPrompt = [
    "You are clarifying requirements before implementing a fix. Follow these steps exactly.\n",
    "## Step 1 — Read the codebase\n",
    "Search the codebase to understand the problem. Find the relevant files, functions, ",
    "and code paths involved. Use Grep and Read — do NOT skip this step.\n\n",
    "## Step 2 — State your understanding\n\n",
    'Write a short paragraph (3–5 sentences) starting with **"My understanding of the problem:"** that explains:\n',
    "- What you found in the code\n- What you think the root cause is\n- What a fix would likely involve\n\n",
    "Name the specific files and functions involved. ",
    "The user will confirm or correct your understanding before you proceed.\n\n",
    "## Step 3 — Reproducibility check\n\n",
    "Run ONE bash command to check credentials and services needed to reproduce:\n\n",
    "```bash\nenv | grep -iE 'api_key|token|secret|database_url|litellm' | sed 's/=.*/=<set>/' | sort\n```\n\n",
    "## Step 4 — Ask 2–3 focused questions\n\n",
    "Ask only things **the user knows** that you cannot determine from code or env.\n",
    "For each question provide your recommended answer in brackets.\n",
    "Present questions as a numbered list. Stop after the questions — do not plan, do not write code.\n\n",
    `## Issue\n\n${prompt}`,
  ].join("");

  yield* agent(grillPrompt, { cwd, taskId });
}

export async function* runPlan(
  agent: AgentEntrypoint,
  taskId: string,
  prompt: string,
  resumeId?: string | null
): AsyncGenerator<AgentEvent> {
  yield { type: "status", text: "⚙ Provisioning worktree…" };
  let cwd: string;
  try { cwd = await provisionWorktree(taskId); }
  catch (e) { yield { type: "error", text: String(e) }; return; }
  yield { type: "status", text: `✓ Worktree: task-${taskId}` };

  const skill = loadSkill("plan_repro");
  const planPrompt = skill ? `${skill}\n\n---\n\n${prompt}` : prompt;
  const finalPrompt = resumeId ? `Answers confirmed. Now proceed:\n\n${planPrompt}` : planPrompt;

  yield* agent(finalPrompt, { cwd, taskId, resumeId });
}

export async function* runImplement(
  agent: AgentEntrypoint,
  taskId: string,
  sessionId: string
): AsyncGenerator<AgentEvent> {
  const skill = loadSkill("implement");
  const prompt = skill || "Plan approved. Proceed with implementation.";
  yield* agent(prompt, { cwd: worktreePath(taskId), taskId, resumeId: sessionId });
}

export async function* runImplementFromPlan(
  agent: AgentEntrypoint,
  taskId: string,
  planText: string
): AsyncGenerator<AgentEvent> {
  yield { type: "status", text: "⚙ Provisioning worktree…" };
  let cwd: string;
  try { cwd = await provisionWorktree(taskId); }
  catch (e) { yield { type: "error", text: String(e) }; return; }
  yield { type: "status", text: `✓ Worktree: task-${taskId}` };
  yield { type: "_worktree", path: cwd };

  const skill = loadSkill("implement");
  const prompt = skill ? `${planText}\n\n---\n\n${skill}` : planText;

  yield* agent(prompt, { cwd, taskId });
}
