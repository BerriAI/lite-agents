import express, { Request, Response } from "express";
import multer from "multer";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { join, extname, dirname } from "path";
import { randomBytes } from "crypto";
import { fileURLToPath } from "url";

import {
  TaskState,
  TaskStateValue,
  Task,
  createTask,
  getTask,
  setState,
  updateTask,
  advance,
  allTasks,
  appendMessage,
  listActiveTasks,
  getRunDetail,
  getRunEvents,
  getRunMessages,
} from "./tasks.js";

import {
  AgentEvent,
  runGrill,
  runPlan,
  runImplement,
  runImplementFromPlan,
} from "./core.js";
import { claudeCodeAgent } from "./agents/claude-code.js";

const agent = claudeCodeAgent;

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = "/tmp/claude-screenshots";
const PORT = parseInt(process.env.PORT ?? "8001", 10);

mkdirSync(SCREENSHOT_DIR, { recursive: true });

// ── Startup recovery ──────────────────────────────────────────────────────────

async function recoverActiveTasks(): Promise<void> {
  try {
    const active = await listActiveTasks();
    if (active.length === 0) {
      console.log("[startup] no active tasks to recover");
    } else {
      for (const t of active) {
        console.log(
          `[startup] recovered task id=${t.id} title=${JSON.stringify(t.title)} state=${t.state} grill_session=${t.grillSessionId} session=${t.sessionId}`
        );
      }
    }
  } catch (e) {
    console.warn("[startup] task recovery failed:", (e as Error).message);
  }
}

// ── App ───────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

const upload = multer({
  storage: multer.diskStorage({
    destination: SCREENSHOT_DIR,
    filename: (_req, file, cb) => {
      const ext = extname(file.originalname) || ".png";
      cb(null, `${randomBytes(6).toString("hex")}${ext}`);
    },
  }),
});

function taskDict(t: Task): Record<string, unknown> {
  return {
    id: t.id,
    title: t.title,
    state: t.state,
    created_at: t.createdAt.toISOString(),
    has_session: Boolean(t.sessionId),
    pr_url: t.prUrl,
    plan: t.plan,
  };
}

function sse(res: Response): (data: unknown) => void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  return (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ── Static pages ──────────────────────────────────────────────────────────────

app.get("/", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html");
  res.send(readFileSync(join(__dirname, "../public/index.html"), "utf8"));
});

// ── Task management ───────────────────────────────────────────────────────────

app.get("/tasks", async (_req: Request, res: Response) => {
  try {
    const tasks = await allTasks();
    res.json(tasks.map(taskDict));
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.post("/tasks/:taskId/advance", async (req: Request, res: Response) => {
  try {
    const t = await advance(req.params.taskId);
    res.json(taskDict(t));
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.get("/screenshots/:filename", (req: Request, res: Response) => {
  const p = join(SCREENSHOT_DIR, req.params.filename);
  if (!existsSync(p)) { res.status(404).end(); return; }
  res.sendFile(p);
});

app.post("/upload", upload.single("file"), (req: Request, res: Response) => {
  if (!req.file) { res.status(400).json({ error: "no file" }); return; }
  res.json({ path: req.file.path, filename: req.file.filename });
});

// ── Workflow proxy relay ──────────────────────────────────────────────────────

app.get("/api/runs", async (_req: Request, res: Response) => {
  try {
    const tasks = await allTasks();
    res.json(tasks.map((t) => ({
      run_id: t.id, title: t.title, state: t.state,
      created_at: t.createdAt.toISOString(), has_session: Boolean(t.sessionId), worktree: t.worktree,
    })));
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.get("/api/runs/:runId", async (req: Request, res: Response) => {
  const data = await getRunDetail(req.params.runId);
  if (!data) { res.status(404).json({ error: "not found" }); return; }
  res.json(data);
});

app.get("/api/runs/:runId/events", async (req: Request, res: Response) => {
  try { res.json(await getRunEvents(req.params.runId)); }
  catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

app.get("/api/runs/:runId/messages", async (req: Request, res: Response) => {
  try { res.json(await getRunMessages(req.params.runId)); }
  catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// ── Chat stream ───────────────────────────────────────────────────────────────

const PLAN_BYPASS_PREFIXES = ["i have a plan:", "i have a plan", "skip to implement", "/implement"];

interface ChatRequest { message: string; task_id?: string; }

app.post("/chat/stream", async (req: Request, res: Response) => {
  const { message, task_id }: ChatRequest = req.body;
  const send = sse(res);

  let task: Task | null;
  if (task_id) {
    task = await getTask(task_id);
    if (!task) { res.status(404).json({ error: "task not found" }); return; }
  } else {
    task = await createTask(message.slice(0, 80));
  }

  appendMessage(task.id, "user", message).catch(() => {});
  const state = task.state;
  const msgLower = message.trim().toLowerCase();

  // Plan bypass
  if (
    ([TaskState.OPEN, TaskState.GRILLING, TaskState.GRILL_DONE] as TaskStateValue[]).includes(state) &&
    PLAN_BYPASS_PREFIXES.some((p) => msgLower.startsWith(p))
  ) {
    let planBody = message;
    for (const p of PLAN_BYPASS_PREFIXES) {
      if (msgLower.startsWith(p)) { planBody = message.slice(p.length).replace(/^[\s:]+/, "") || message; break; }
    }
    task.plan = planBody;
    await setState(task.id, TaskState.PLAN_APPROVED);
    await updateTask(task);
    send({ task: taskDict(task) });
    send({ type: "text", text: "Plan received — ready to implement." });
    const updated = await getTask(task.id);
    send({ task: taskDict(updated!), show_approve: true });
    res.write("data: [DONE]\n\n");
    return res.end();
  }

  async function streamStage(gen: AsyncGenerator<AgentEvent>, onStats?: (ev: AgentEvent) => void): Promise<string[]> {
    const chunks: string[] = [];
    for await (const ev of gen) {
      if (ev.type === "text") chunks.push(ev.text);
      if (ev.type === "stats" && onStats) onStats(ev);
      send(ev);
    }
    return chunks;
  }

  // Resume plan
  if (([TaskState.PLANNING, TaskState.PLAN_APPROVED] as TaskStateValue[]).includes(state)) {
    send({ task: taskDict(task) });
    try {
      const resumeId = task.sessionId ?? task.grillSessionId;
      const chunks = await streamStage(runPlan(agent, task.id, message, resumeId), (ev) => {
        if (ev.type === "stats" && ev.session_id) { task!.sessionId = ev.session_id; updateTask(task!).catch(() => {}); }
      });
      if (chunks.length) appendMessage(task.id, "assistant", chunks.join(""), task.sessionId).catch(() => {});
      await setState(task.id, TaskState.PLAN_APPROVED);
    } catch (e) { send({ type: "error", text: String(e) }); }
    send({ task: taskDict((await getTask(task.id))!), show_approve: true });
    res.write("data: [DONE]\n\n");
    return res.end();
  }

  // Follow-up on implemented tasks
  if (([TaskState.IMPLEMENTED, TaskState.PR_UP, TaskState.PR_MERGED] as TaskStateValue[]).includes(state)) {
    send({ task: taskDict(task) });
    try {
      const resumeId = task.sessionId ?? task.grillSessionId;
      const chunks = await streamStage(runPlan(agent, task.id, message, resumeId), (ev) => {
        if (ev.type === "stats" && ev.session_id) { task!.sessionId = ev.session_id; updateTask(task!).catch(() => {}); }
      });
      if (chunks.length) appendMessage(task.id, "assistant", chunks.join(""), task.sessionId).catch(() => {});
    } catch (e) { send({ type: "error", text: String(e) }); }
    res.write("data: [DONE]\n\n");
    return res.end();
  }

  // OPEN / GRILLING / GRILL_DONE — grill stage
  if (state === TaskState.OPEN) task.plan = message;
  const resumeId = ([TaskState.GRILLING, TaskState.GRILL_DONE] as TaskStateValue[]).includes(state)
    ? task.grillSessionId : null;
  await setState(task.id, TaskState.GRILLING);

  send({ task: taskDict(task) });
  try {
    const chunks: string[] = [];
    for await (const ev of runGrill(agent, task.id, message, resumeId)) {
      if (ev.type === "stats" && ev.session_id) { task!.grillSessionId = ev.session_id; updateTask(task!).catch(() => {}); }
      if (ev.type === "_worktree") { task.worktree = ev.path; await updateTask(task); continue; }
      if (ev.type === "text") chunks.push(ev.text);
      send(ev);
    }
    if (chunks.length) appendMessage(task.id, "assistant", chunks.join(""), task.grillSessionId).catch(() => {});
    await setState(task.id, TaskState.GRILL_DONE);
  } catch (e) { send({ type: "error", text: String(e) }); }

  send({ task: taskDict((await getTask(task.id))!), show_grill_approve: true });
  res.write("data: [DONE]\n\n");
  res.end();
});

// ── Grill approve ─────────────────────────────────────────────────────────────

app.post("/tasks/:taskId/grill-approve", async (req: Request, res: Response) => {
  const { taskId } = req.params;
  const { user_notes }: { user_notes?: string } = req.body ?? {};
  const send = sse(res);

  const t = await getTask(taskId);
  if (!t) { res.status(404).json({ error: "task not found" }); return; }

  const issueText = user_notes
    ? `${t.plan ?? ""}\n\n### Additional context from user\n${user_notes}`
    : (t.plan ?? "");

  appendMessage(taskId, "user", user_notes ?? "(grill approved — proceed to plan)").catch(() => {});
  await setState(taskId, TaskState.PLANNING);
  send({ task: taskDict(t) });

  try {
    for await (const ev of runPlan(agent, taskId, issueText, t.grillSessionId)) {
      if (ev.type === "stats" && ev.session_id) { t.sessionId = ev.session_id; await updateTask(t); }
      send(ev);
    }
    if (t.sessionId) appendMessage(taskId, "assistant", "", t.sessionId).catch(() => {});
    await setState(taskId, TaskState.PLAN_APPROVED);
  } catch (e) { send({ type: "error", text: String(e) }); }

  send({ task: taskDict((await getTask(taskId))!), show_approve: true });
  res.write("data: [DONE]\n\n");
  res.end();
});

// ── Approve & implement ───────────────────────────────────────────────────────

app.post("/tasks/:taskId/approve", async (req: Request, res: Response) => {
  const { taskId } = req.params;
  const send = sse(res);

  const t = await getTask(taskId);
  if (!t) { res.status(404).json({ error: "task not found" }); return; }
  if (!t.sessionId && !t.plan) {
    res.status(400).json({ error: "no session_id or plan — complete planning first" });
    return;
  }

  appendMessage(taskId, "user", "APPROVED — proceed with implementation").catch(() => {});
  await setState(taskId, TaskState.IMPLEMENTED);
  send({ task: taskDict(t) });

  try {
    const stream = t.sessionId
      ? runImplement(agent, taskId, t.sessionId)
      : runImplementFromPlan(agent, taskId, t.plan!);

    let implSessionId: string | null = null;
    const chunks: string[] = [];
    for await (const ev of stream) {
      if (ev.type === "_worktree") { t.worktree = ev.path; await updateTask(t); continue; }
      if (ev.type === "text") chunks.push(ev.text);
      if (ev.type === "stats" && ev.session_id) implSessionId = ev.session_id;
      send(ev);
    }
    if (chunks.length) appendMessage(taskId, "assistant", chunks.join(""), implSessionId).catch(() => {});
  } catch (e) { send({ type: "error", text: String(e) }); }

  send({ task: taskDict((await getTask(taskId))!) });
  res.write("data: [DONE]\n\n");
  res.end();
});

// ── Start ─────────────────────────────────────────────────────────────────────

recoverActiveTasks().then(() => {
  app.listen(PORT, () => {
    console.log(`shin-builder-js listening on http://localhost:${PORT}`);
  });
});
