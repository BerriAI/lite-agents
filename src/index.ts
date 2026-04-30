import express, { Request, Response } from "express";
import multer from "multer";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { join, extname, dirname } from "path";
import { randomBytes, } from "crypto";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

import {
  Workflow,
  createWorkflow,
  getWorkflow,
  updateWorkflow,
  listWorkflows,
  appendEvent,
  appendMessage,
  getEvents,
  getMessages,
} from "./workflows.js";
import type { AgentEntrypoint, AgentMessage } from "./agent-spec.js";
import { claudeCodeAgent as agent } from "./agents/claude-code.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = "/tmp/claude-screenshots";
const PORT = parseInt(process.env.PORT ?? "8001", 10);
const WORKFLOW_TYPE = "lite-agents";
const SKILLS_DIR = join(__dirname, "../skills");

if (!process.env.REPO_PATH) throw new Error("REPO_PATH is required");
const REPO_PATH = process.env.REPO_PATH;

mkdirSync(SCREENSHOT_DIR, { recursive: true });

// ── Agent event type ──────────────────────────────────────────────────────────

type AgentEvent =
  | AgentMessage
  | { type: "status"; text: string }
  | { type: "_worktree"; path: string }

// ── Worktree ──────────────────────────────────────────────────────────────────

function worktreePath(id: string): string {
  return join(REPO_PATH, ".claude", "worktrees", `task-${id}`);
}

function runCmd(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.on("close", (code) => code !== 0 ? reject(new Error(`${cmd} failed: ${stderr}`)) : resolve());
  });
}

async function provisionWorktree(id: string): Promise<string> {
  const wt = worktreePath(id);
  if (!existsSync(wt)) await runCmd("git", ["worktree", "add", wt, "-b", `task-${id}`], REPO_PATH);
  return wt;
}

function loadSkill(name: string): string {
  try { return readFileSync(join(SKILLS_DIR, `${name}.md`), "utf8"); } catch { return ""; }
}

// ── Stage runners ─────────────────────────────────────────────────────────────

async function* grill(agent: AgentEntrypoint, id: string, prompt: string, resumeId?: string | null): AsyncGenerator<AgentEvent> {
  if (resumeId) { yield* agent(prompt, { cwd: worktreePath(id), taskId: id, resumeId }); return; }
  yield { type: "status", text: "⚙ Provisioning worktree…" };
  let cwd: string;
  try { cwd = await provisionWorktree(id); } catch (e) { yield { type: "error", text: String(e) }; return; }
  yield { type: "status", text: `✓ Worktree: task-${id}` };
  yield { type: "_worktree", path: cwd };
  const grillPrompt = [
    "You are clarifying requirements before implementing a fix. Follow these steps exactly.\n",
    "## Step 1 — Read the codebase\nSearch the codebase to understand the problem. Find the relevant files, functions, and code paths involved. Use Grep and Read — do NOT skip this step.\n\n",
    "## Step 2 — State your understanding\n\nWrite a short paragraph (3–5 sentences) starting with **\"My understanding of the problem:\"** that explains:\n- What you found in the code\n- What you think the root cause is\n- What a fix would likely involve\n\nName the specific files and functions involved. The user will confirm or correct your understanding before you proceed.\n\n",
    "## Step 3 — Reproducibility check\n\nRun ONE bash command to check credentials and services needed to reproduce:\n\n```bash\nenv | grep -iE 'api_key|token|secret|database_url|litellm' | sed 's/=.*/=<set>/' | sort\n```\n\n",
    "## Step 4 — Ask 2–3 focused questions\n\nAsk only things **the user knows** that you cannot determine from code or env.\nFor each question provide your recommended answer in brackets.\nPresent questions as a numbered list. Stop after the questions — do not plan, do not write code.\n\n",
    `## Issue\n\n${prompt}`,
  ].join("");
  yield* agent(grillPrompt, { cwd, taskId: id });
}

async function* plan(agent: AgentEntrypoint, id: string, prompt: string, resumeId?: string | null): AsyncGenerator<AgentEvent> {
  yield { type: "status", text: "⚙ Provisioning worktree…" };
  let cwd: string;
  try { cwd = await provisionWorktree(id); } catch (e) { yield { type: "error", text: String(e) }; return; }
  yield { type: "status", text: `✓ Worktree: task-${id}` };
  const skill = loadSkill("plan_repro");
  const p = skill ? `${skill}\n\n---\n\n${prompt}` : prompt;
  yield* agent(resumeId ? `Answers confirmed. Now proceed:\n\n${p}` : p, { cwd, taskId: id, resumeId });
}

async function* implement(agent: AgentEntrypoint, id: string, sessionId: string): AsyncGenerator<AgentEvent> {
  const skill = loadSkill("implement");
  yield* agent(skill || "Plan approved. Proceed with implementation.", { cwd: worktreePath(id), taskId: id, resumeId: sessionId });
}

async function* implementFromPlan(agent: AgentEntrypoint, id: string, planText: string): AsyncGenerator<AgentEvent> {
  yield { type: "status", text: "⚙ Provisioning worktree…" };
  let cwd: string;
  try { cwd = await provisionWorktree(id); } catch (e) { yield { type: "error", text: String(e) }; return; }
  yield { type: "status", text: `✓ Worktree: task-${id}` };
  yield { type: "_worktree", path: cwd };
  const skill = loadSkill("implement");
  yield* agent(skill ? `${planText}\n\n---\n\n${skill}` : planText, { cwd, taskId: id });
}

// ── Domain types ──────────────────────────────────────────────────────────────

interface Task {
  id: string; title: string; state: string; createdAt: Date;
  worktree: string | null; plan: string | null;
  grillSessionId: string | null; sessionId: string | null; prUrl: string | null;
}

function toTask(w: Workflow): Task {
  const m = w.metadata;
  return {
    id: w.id, title: (m.title as string) ?? "", state: (m.state as string) ?? "open", createdAt: w.createdAt,
    worktree: (m.worktree_path as string | null) ?? null, plan: (m.plan_text as string | null) ?? null,
    grillSessionId: (m.grill_session_id as string | null) ?? null, sessionId: (m.session_id as string | null) ?? null,
    prUrl: (m.pr_url as string | null) ?? null,
  };
}

function toMeta(t: Task): Record<string, unknown> {
  return { state: t.state, title: t.title, worktree_path: t.worktree, plan_text: t.plan, grill_session_id: t.grillSessionId, session_id: t.sessionId, pr_url: t.prUrl };
}

async function getTask(id: string): Promise<Task | null> {
  const w = await getWorkflow(id); return w ? toTask(w) : null;
}

async function createTask(title: string): Promise<Task> {
  return toTask(await createWorkflow(WORKFLOW_TYPE, { state: "open", title: title.slice(0, 80), worktree_path: null, plan_text: null, grill_session_id: null, session_id: null, pr_url: null }));
}

async function save(t: Task): Promise<void> { await updateWorkflow(t.id, { metadata: toMeta(t) }); }

async function setState(t: Task, state: string): Promise<void> {
  t.state = state;
  await updateWorkflow(t.id, { metadata: toMeta(t), ...(state === "pr_merged" ? { status: "completed" } : {}) });
  const PAUSED = new Set(["grill_done", "plan_approved"]);
  if (PAUSED.has(state)) await appendEvent(t.id, "hook.waiting", state, { reason: state });
  else await appendEvent(t.id, "step.started", state, { stage: state });
}

async function allTasks(): Promise<Task[]> {
  return (await listWorkflows({ workflowType: WORKFLOW_TYPE, limit: 100 })).map(toTask).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

// ── Express ───────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

const upload = multer({ storage: multer.diskStorage({ destination: SCREENSHOT_DIR, filename: (_req, file, cb) => cb(null, `${randomBytes(6).toString("hex")}${extname(file.originalname) || ".png"}`) }) });

const taskDict = (t: Task): Record<string, unknown> => ({ id: t.id, title: t.title, state: t.state, created_at: t.createdAt.toISOString(), has_session: Boolean(t.sessionId), pr_url: t.prUrl, plan: t.plan });

function sse(res: Response): (data: unknown) => void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  return (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
}

app.get("/", (_req, res) => { res.setHeader("Content-Type", "text/html"); res.send(readFileSync(join(__dirname, "../public/index.html"), "utf8")); });
app.get("/screenshots/:filename", (req, res) => { const p = join(SCREENSHOT_DIR, req.params.filename); if (!existsSync(p)) { res.status(404).end(); return; } res.sendFile(p); });
app.post("/upload", upload.single("file"), (req, res) => { if (!req.file) { res.status(400).json({ error: "no file" }); return; } res.json({ path: req.file.path, filename: req.file.filename }); });

app.get("/tasks", async (_req, res) => { try { res.json((await allTasks()).map(taskDict)); } catch (e) { res.status(500).json({ error: (e as Error).message }); } });
app.get("/api/workflows", async (_req, res) => { try { res.json((await allTasks()).map((t) => ({ workflow_id: t.id, title: t.title, state: t.state, created_at: t.createdAt.toISOString(), worktree: t.worktree }))); } catch (e) { res.status(500).json({ error: (e as Error).message }); } });
app.get("/api/workflows/:id", async (req, res) => { const w = await getWorkflow(req.params.id); if (!w) { res.status(404).json({ error: "not found" }); return; } res.json(w); });
app.get("/api/workflows/:id/events", async (req, res) => { try { res.json(await getEvents(req.params.id)); } catch (e) { res.status(500).json({ error: (e as Error).message }); } });
app.get("/api/workflows/:id/messages", async (req, res) => { try { res.json(await getMessages(req.params.id)); } catch (e) { res.status(500).json({ error: (e as Error).message }); } });

const PLAN_BYPASS = ["i have a plan:", "i have a plan", "skip to implement", "/implement"];

app.post("/chat/stream", async (req: Request, res: Response) => {
  const { message, task_id }: { message: string; task_id?: string } = req.body;
  const send = sse(res);
  let task = task_id ? await getTask(task_id) : await createTask(message.slice(0, 80));
  if (!task) { res.status(404).json({ error: "not found" }); return; }
  appendMessage(task.id, "user", message).catch(() => {});
  const msgLower = message.trim().toLowerCase();

  if (["open", "grilling", "grill_done"].includes(task.state) && PLAN_BYPASS.some((p) => msgLower.startsWith(p))) {
    let planBody = message;
    for (const p of PLAN_BYPASS) { if (msgLower.startsWith(p)) { planBody = message.slice(p.length).replace(/^[\s:]+/, "") || message; break; } }
    task.plan = planBody;
    await setState(task, "plan_approved");
    send({ task: taskDict(task) });
    send({ type: "text", text: "Plan received — ready to implement." });
    send({ task: taskDict((await getTask(task.id))!), show_approve: true });
    res.write("data: [DONE]\n\n"); return res.end();
  }

  async function stream(gen: AsyncGenerator<AgentEvent>, onStats?: (ev: AgentEvent) => void): Promise<string[]> {
    const chunks: string[] = [];
    for await (const ev of gen) { if (ev.type === "text") chunks.push(ev.text); if (ev.type === "stats" && onStats) onStats(ev); send(ev); }
    return chunks;
  }

  if (["planning", "plan_approved"].includes(task.state)) {
    send({ task: taskDict(task) });
    try {
      const chunks = await stream(plan(agent, task.id, message, task.sessionId ?? task.grillSessionId), (ev) => { if (ev.type === "stats" && ev.session_id) { task!.sessionId = ev.session_id; save(task!).catch(() => {}); } });
      if (chunks.length) appendMessage(task.id, "assistant", chunks.join(""), task.sessionId).catch(() => {});
      await setState(task, "plan_approved");
    } catch (e) { send({ type: "error", text: String(e) }); }
    send({ task: taskDict((await getTask(task.id))!), show_approve: true });
    res.write("data: [DONE]\n\n"); return res.end();
  }

  if (["implemented", "pr_up", "pr_merged"].includes(task.state)) {
    send({ task: taskDict(task) });
    try {
      const chunks = await stream(plan(agent, task.id, message, task.sessionId ?? task.grillSessionId), (ev) => { if (ev.type === "stats" && ev.session_id) { task!.sessionId = ev.session_id; save(task!).catch(() => {}); } });
      if (chunks.length) appendMessage(task.id, "assistant", chunks.join(""), task.sessionId).catch(() => {});
    } catch (e) { send({ type: "error", text: String(e) }); }
    res.write("data: [DONE]\n\n"); return res.end();
  }

  if (task.state === "open") task.plan = message;
  const resumeId = ["grilling", "grill_done"].includes(task.state) ? task.grillSessionId : null;
  await setState(task, "grilling");
  send({ task: taskDict(task) });
  try {
    const chunks: string[] = [];
    for await (const ev of grill(agent, task.id, message, resumeId)) {
      if (ev.type === "stats" && ev.session_id) { task.grillSessionId = ev.session_id; save(task).catch(() => {}); }
      if (ev.type === "_worktree") { task.worktree = ev.path; await save(task); continue; }
      if (ev.type === "text") chunks.push(ev.text);
      send(ev);
    }
    if (chunks.length) appendMessage(task.id, "assistant", chunks.join(""), task.grillSessionId).catch(() => {});
    await setState(task, "grill_done");
  } catch (e) { send({ type: "error", text: String(e) }); }
  send({ task: taskDict((await getTask(task.id))!), show_grill_approve: true });
  res.write("data: [DONE]\n\n"); res.end();
});

app.post("/tasks/:id/grill-approve", async (req, res) => {
  const { user_notes }: { user_notes?: string } = req.body ?? {};
  const send = sse(res);
  const t = await getTask(req.params.id);
  if (!t) { res.status(404).json({ error: "not found" }); return; }
  const issueText = user_notes ? `${t.plan ?? ""}\n\n### Additional context\n${user_notes}` : (t.plan ?? "");
  appendMessage(t.id, "user", user_notes ?? "(approved — proceed to plan)").catch(() => {});
  await setState(t, "planning");
  send({ task: taskDict(t) });
  try {
    for await (const ev of plan(agent, t.id, issueText, t.grillSessionId)) {
      if (ev.type === "stats" && ev.session_id) { t.sessionId = ev.session_id; await save(t); }
      send(ev);
    }
    if (t.sessionId) appendMessage(t.id, "assistant", "", t.sessionId).catch(() => {});
    await setState(t, "plan_approved");
  } catch (e) { send({ type: "error", text: String(e) }); }
  send({ task: taskDict((await getTask(t.id))!), show_approve: true });
  res.write("data: [DONE]\n\n"); res.end();
});

app.post("/tasks/:id/approve", async (req, res) => {
  const send = sse(res);
  const t = await getTask(req.params.id);
  if (!t) { res.status(404).json({ error: "not found" }); return; }
  if (!t.sessionId && !t.plan) { res.status(400).json({ error: "no session or plan" }); return; }
  appendMessage(t.id, "user", "APPROVED — proceed with implementation").catch(() => {});
  await setState(t, "implemented");
  send({ task: taskDict(t) });
  try {
    const gen = t.sessionId ? implement(agent, t.id, t.sessionId) : implementFromPlan(agent, t.id, t.plan!);
    let implSessionId: string | null = null;
    const chunks: string[] = [];
    for await (const ev of gen) {
      if (ev.type === "_worktree") { t.worktree = ev.path; await save(t); continue; }
      if (ev.type === "text") chunks.push(ev.text);
      if (ev.type === "stats" && ev.session_id) implSessionId = ev.session_id;
      send(ev);
    }
    if (chunks.length) appendMessage(t.id, "assistant", chunks.join(""), implSessionId).catch(() => {});
  } catch (e) { send({ type: "error", text: String(e) }); }
  send({ task: taskDict((await getTask(t.id))!) });
  res.write("data: [DONE]\n\n"); res.end();
});

// ── Start ─────────────────────────────────────────────────────────────────────

async function recover(): Promise<void> {
  try {
    const active = await listWorkflows({ workflowType: WORKFLOW_TYPE, status: "running,paused", limit: 100 });
    if (active.length === 0) console.log("[startup] no active workflows");
    else active.forEach((w) => console.log(`[startup] recovered id=${w.id} state=${w.metadata.state}`));
  } catch (e) { console.warn("[startup] recovery failed:", (e as Error).message); }
}

recover().then(() => app.listen(PORT, () => console.log(`lite-agents on http://localhost:${PORT}`)));
