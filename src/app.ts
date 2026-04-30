import express, { Request, Response } from "express";
import multer from "multer";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { join, extname, dirname } from "path";
import { randomBytes } from "crypto";
import { fileURLToPath } from "url";

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

import { AgentEvent, runGrill, runPlan, runImplement, runImplementFromPlan } from "./core.js";
import { claudeCodeAgent as agent } from "./agents/claude-code.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = "/tmp/claude-screenshots";
const PORT = parseInt(process.env.PORT ?? "8001", 10);
const WORKFLOW_TYPE = "lite-agents";

mkdirSync(SCREENSHOT_DIR, { recursive: true });

// ── Domain types ──────────────────────────────────────────────────────────────

interface Task {
  id: string;
  title: string;
  state: string;
  createdAt: Date;
  worktree: string | null;
  plan: string | null;
  grillSessionId: string | null;
  sessionId: string | null;
  prUrl: string | null;
}

function workflowToTask(w: Workflow): Task {
  const m = w.metadata;
  return {
    id: w.id,
    title: (m.title as string) ?? "",
    state: (m.state as string) ?? "open",
    createdAt: w.createdAt,
    worktree: (m.worktree_path as string | null) ?? null,
    plan: (m.plan_text as string | null) ?? null,
    grillSessionId: (m.grill_session_id as string | null) ?? null,
    sessionId: (m.session_id as string | null) ?? null,
    prUrl: (m.pr_url as string | null) ?? null,
  };
}

function taskMeta(t: Task): Record<string, unknown> {
  return {
    state: t.state,
    title: t.title,
    worktree_path: t.worktree,
    plan_text: t.plan,
    grill_session_id: t.grillSessionId,
    session_id: t.sessionId,
    pr_url: t.prUrl,
  };
}

async function getTask(id: string): Promise<Task | null> {
  const w = await getWorkflow(id);
  return w ? workflowToTask(w) : null;
}

async function createTask(title: string): Promise<Task> {
  const w = await createWorkflow(WORKFLOW_TYPE, {
    state: "open", title: title.slice(0, 80),
    worktree_path: null, plan_text: null,
    grill_session_id: null, session_id: null, pr_url: null,
  });
  return workflowToTask(w);
}

async function saveTask(t: Task): Promise<void> {
  await updateWorkflow(t.id, { metadata: taskMeta(t) });
}

async function setState(t: Task, state: string): Promise<void> {
  t.state = state;
  const PAUSED = new Set(["grill_done", "plan_approved"]);
  const DONE = new Set(["pr_merged"]);
  await updateWorkflow(t.id, { metadata: taskMeta(t), ...(DONE.has(state) ? { status: "completed" } : {}) });
  if (PAUSED.has(state)) await appendEvent(t.id, "hook.waiting", state, { reason: state });
  else await appendEvent(t.id, "step.started", state, { stage: state });
}

async function allTasks(): Promise<Task[]> {
  const workflows = await listWorkflows({ workflowType: WORKFLOW_TYPE, limit: 100 });
  return workflows.map(workflowToTask).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

async function activeWorkflows(): Promise<Task[]> {
  const workflows = await listWorkflows({ workflowType: WORKFLOW_TYPE, status: "running,paused", limit: 100 });
  return workflows.map(workflowToTask);
}

// ── App setup ─────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

const upload = multer({
  storage: multer.diskStorage({
    destination: SCREENSHOT_DIR,
    filename: (_req, file, cb) => cb(null, `${randomBytes(6).toString("hex")}${extname(file.originalname) || ".png"}`),
  }),
});

function taskDict(t: Task): Record<string, unknown> {
  return { id: t.id, title: t.title, state: t.state, created_at: t.createdAt.toISOString(), has_session: Boolean(t.sessionId), pr_url: t.prUrl, plan: t.plan };
}

function sse(res: Response): (data: unknown) => void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  return (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ── Static + uploads ──────────────────────────────────────────────────────────

app.get("/", (_req, res) => { res.setHeader("Content-Type", "text/html"); res.send(readFileSync(join(__dirname, "../public/index.html"), "utf8")); });
app.get("/screenshots/:filename", (req, res) => { const p = join(SCREENSHOT_DIR, req.params.filename); if (!existsSync(p)) { res.status(404).end(); return; } res.sendFile(p); });
app.post("/upload", upload.single("file"), (req, res) => { if (!req.file) { res.status(400).json({ error: "no file" }); return; } res.json({ path: req.file.path, filename: req.file.filename }); });

// ── Workflow endpoints ────────────────────────────────────────────────────────

app.get("/tasks", async (_req, res) => { try { res.json((await allTasks()).map(taskDict)); } catch (e) { res.status(500).json({ error: (e as Error).message }); } });

app.get("/api/workflows", async (_req, res) => {
  try {
    const tasks = await allTasks();
    res.json(tasks.map((t) => ({ workflow_id: t.id, title: t.title, state: t.state, created_at: t.createdAt.toISOString(), has_session: Boolean(t.sessionId), worktree: t.worktree })));
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

app.get("/api/workflows/:workflowId", async (req, res) => { const w = await getWorkflow(req.params.workflowId); if (!w) { res.status(404).json({ error: "not found" }); return; } res.json(w); });
app.get("/api/workflows/:workflowId/events", async (req, res) => { try { res.json(await getEvents(req.params.workflowId)); } catch (e) { res.status(500).json({ error: (e as Error).message }); } });
app.get("/api/workflows/:workflowId/messages", async (req, res) => { try { res.json(await getMessages(req.params.workflowId)); } catch (e) { res.status(500).json({ error: (e as Error).message }); } });

// ── Chat stream ───────────────────────────────────────────────────────────────

const PLAN_BYPASS = ["i have a plan:", "i have a plan", "skip to implement", "/implement"];

app.post("/chat/stream", async (req: Request, res: Response) => {
  const { message, task_id }: { message: string; task_id?: string } = req.body;
  const send = sse(res);

  let task = task_id ? await getTask(task_id) : await createTask(message.slice(0, 80));
  if (!task) { res.status(404).json({ error: "task not found" }); return; }

  appendMessage(task.id, "user", message).catch(() => {});
  const msgLower = message.trim().toLowerCase();

  // Plan bypass
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
    for await (const ev of gen) {
      if (ev.type === "text") chunks.push(ev.text);
      if (ev.type === "stats" && onStats) onStats(ev);
      send(ev);
    }
    return chunks;
  }

  // Resume plan
  if (["planning", "plan_approved"].includes(task.state)) {
    send({ task: taskDict(task) });
    try {
      const resumeId = task.sessionId ?? task.grillSessionId;
      const chunks = await stream(runPlan(agent, task.id, message, resumeId), (ev) => {
        if (ev.type === "stats" && ev.session_id) { task!.sessionId = ev.session_id; saveTask(task!).catch(() => {}); }
      });
      if (chunks.length) appendMessage(task.id, "assistant", chunks.join(""), task.sessionId).catch(() => {});
      await setState(task, "plan_approved");
    } catch (e) { send({ type: "error", text: String(e) }); }
    send({ task: taskDict((await getTask(task.id))!), show_approve: true });
    res.write("data: [DONE]\n\n"); return res.end();
  }

  // Follow-up after implementation
  if (["implemented", "pr_up", "pr_merged"].includes(task.state)) {
    send({ task: taskDict(task) });
    try {
      const chunks = await stream(runPlan(agent, task.id, message, task.sessionId ?? task.grillSessionId), (ev) => {
        if (ev.type === "stats" && ev.session_id) { task!.sessionId = ev.session_id; saveTask(task!).catch(() => {}); }
      });
      if (chunks.length) appendMessage(task.id, "assistant", chunks.join(""), task.sessionId).catch(() => {});
    } catch (e) { send({ type: "error", text: String(e) }); }
    res.write("data: [DONE]\n\n"); return res.end();
  }

  // Grill stage
  if (task.state === "open") task.plan = message;
  const resumeId = ["grilling", "grill_done"].includes(task.state) ? task.grillSessionId : null;
  await setState(task, "grilling");
  send({ task: taskDict(task) });
  try {
    const chunks: string[] = [];
    for await (const ev of runGrill(agent, task.id, message, resumeId)) {
      if (ev.type === "stats" && ev.session_id) { task.grillSessionId = ev.session_id; saveTask(task).catch(() => {}); }
      if (ev.type === "_worktree") { task.worktree = ev.path; await saveTask(task); continue; }
      if (ev.type === "text") chunks.push(ev.text);
      send(ev);
    }
    if (chunks.length) appendMessage(task.id, "assistant", chunks.join(""), task.grillSessionId).catch(() => {});
    await setState(task, "grill_done");
  } catch (e) { send({ type: "error", text: String(e) }); }
  send({ task: taskDict((await getTask(task.id))!), show_grill_approve: true });
  res.write("data: [DONE]\n\n"); res.end();
});

// ── Grill approve ─────────────────────────────────────────────────────────────

app.post("/tasks/:taskId/grill-approve", async (req, res) => {
  const { taskId } = req.params;
  const { user_notes }: { user_notes?: string } = req.body ?? {};
  const send = sse(res);
  const t = await getTask(taskId);
  if (!t) { res.status(404).json({ error: "not found" }); return; }

  const issueText = user_notes ? `${t.plan ?? ""}\n\n### Additional context\n${user_notes}` : (t.plan ?? "");
  appendMessage(taskId, "user", user_notes ?? "(approved — proceed to plan)").catch(() => {});
  await setState(t, "planning");
  send({ task: taskDict(t) });
  try {
    for await (const ev of runPlan(agent, taskId, issueText, t.grillSessionId)) {
      if (ev.type === "stats" && ev.session_id) { t.sessionId = ev.session_id; await saveTask(t); }
      send(ev);
    }
    if (t.sessionId) appendMessage(taskId, "assistant", "", t.sessionId).catch(() => {});
    await setState(t, "plan_approved");
  } catch (e) { send({ type: "error", text: String(e) }); }
  send({ task: taskDict((await getTask(taskId))!), show_approve: true });
  res.write("data: [DONE]\n\n"); res.end();
});

// ── Approve & implement ───────────────────────────────────────────────────────

app.post("/tasks/:taskId/approve", async (req, res) => {
  const { taskId } = req.params;
  const send = sse(res);
  const t = await getTask(taskId);
  if (!t) { res.status(404).json({ error: "not found" }); return; }
  if (!t.sessionId && !t.plan) { res.status(400).json({ error: "no session or plan — complete planning first" }); return; }

  appendMessage(taskId, "user", "APPROVED — proceed with implementation").catch(() => {});
  await setState(t, "implemented");
  send({ task: taskDict(t) });
  try {
    const gen = t.sessionId ? runImplement(agent, taskId, t.sessionId) : runImplementFromPlan(agent, taskId, t.plan!);
    let implSessionId: string | null = null;
    const chunks: string[] = [];
    for await (const ev of gen) {
      if (ev.type === "_worktree") { t.worktree = ev.path; await saveTask(t); continue; }
      if (ev.type === "text") chunks.push(ev.text);
      if (ev.type === "stats" && ev.session_id) implSessionId = ev.session_id;
      send(ev);
    }
    if (chunks.length) appendMessage(taskId, "assistant", chunks.join(""), implSessionId).catch(() => {});
  } catch (e) { send({ type: "error", text: String(e) }); }
  send({ task: taskDict((await getTask(taskId))!) });
  res.write("data: [DONE]\n\n"); res.end();
});

// ── Start ─────────────────────────────────────────────────────────────────────

async function recoverActive(): Promise<void> {
  try {
    const active = await activeWorkflows();
    if (active.length === 0) console.log("[startup] no active workflows to recover");
    else active.forEach((t) => console.log(`[startup] recovered id=${t.id} state=${t.state}`));
  } catch (e) { console.warn("[startup] recovery failed:", (e as Error).message); }
}

recoverActive().then(() => {
  app.listen(PORT, () => console.log(`lite-agents listening on http://localhost:${PORT}`));
});
