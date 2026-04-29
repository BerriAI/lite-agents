import fetch from "node-fetch";

const LITELLM_PROXY_URL = (process.env.LITELLM_PROXY_URL ?? "").replace(/\/$/, "");
const LITELLM_API_KEY = process.env.LITELLM_API_KEY ?? "";
const WORKFLOW_TYPE = "shin-builder";

export const TaskState = {
  OPEN: "open",
  GRILLING: "grilling",
  GRILL_DONE: "grill_done",
  PLANNING: "planning",
  PLAN_APPROVED: "plan_approved",
  IMPLEMENTED: "implemented",
  PR_UP: "pr_up",
  PR_MERGED: "pr_merged",
} as const;

export type TaskStateValue = (typeof TaskState)[keyof typeof TaskState];

export interface Task {
  id: string;
  title: string;
  state: TaskStateValue;
  createdAt: Date;
  worktree: string | null;
  plan: string | null;
  grillSessionId: string | null;
  sessionId: string | null;
  prUrl: string | null;
}

const STATE_ORDER: TaskStateValue[] = Object.values(TaskState);
const TERMINAL_STATES = new Set<TaskStateValue>([TaskState.PR_MERGED]);
const PAUSED_STATES = new Set<TaskStateValue>([TaskState.GRILL_DONE, TaskState.PLAN_APPROVED]);

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${LITELLM_API_KEY}`,
    "Content-Type": "application/json",
  };
}

async function apiRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  const url = `${LITELLM_PROXY_URL}${path}`;
  const opts: Parameters<typeof fetch>[1] = { method, headers: authHeaders() };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

function runToTask(run: Record<string, unknown>): Task {
  const meta = (run.metadata as Record<string, unknown>) ?? {};
  return {
    id: run.run_id as string,
    title: (meta.title as string) ?? "",
    state: ((meta.state as TaskStateValue) ?? TaskState.OPEN),
    createdAt: new Date(run.created_at as string),
    worktree: (meta.worktree_path as string | null) ?? null,
    plan: (meta.plan_text as string | null) ?? null,
    grillSessionId: (meta.grill_session_id as string | null) ?? null,
    sessionId: (meta.session_id as string | null) ?? null,
    prUrl: (meta.pr_url as string | null) ?? null,
  };
}

function taskMetadata(task: Task): Record<string, unknown> {
  return {
    state: task.state,
    title: task.title,
    worktree_path: task.worktree,
    plan_text: task.plan,
    grill_session_id: task.grillSessionId,
    session_id: task.sessionId,
    pr_url: task.prUrl,
  };
}

async function patchRun(
  runId: string,
  { status, metadata }: { status?: string; metadata?: unknown } = {}
): Promise<void> {
  const body: Record<string, unknown> = {};
  if (status) body.status = status;
  if (metadata !== undefined) body.metadata = metadata;
  if (Object.keys(body).length) {
    await apiRequest("PATCH", `/v1/workflows/runs/${runId}`, body);
  }
}

async function postEvent(runId: string, eventType: string, data: Record<string, unknown> = {}): Promise<void> {
  await apiRequest("POST", `/v1/workflows/runs/${runId}/events`, {
    event_type: eventType,
    step_name: eventType,
    data,
  });
}

export async function createTask(title: string): Promise<Task> {
  const meta = {
    state: TaskState.OPEN,
    title: title.slice(0, 80),
    worktree_path: null,
    plan_text: null,
    grill_session_id: null,
    session_id: null,
    pr_url: null,
  };
  const run = await apiRequest("POST", "/v1/workflows/runs", {
    workflow_type: WORKFLOW_TYPE,
    metadata: meta,
  });
  return runToTask(run as Record<string, unknown>);
}

export async function getTask(taskId: string): Promise<Task | null> {
  try {
    const run = await apiRequest("GET", `/v1/workflows/runs/${taskId}`);
    return runToTask(run as Record<string, unknown>);
  } catch (e) {
    if ((e as Error).message.includes("404")) return null;
    throw e;
  }
}

export async function setState(taskId: string, state: TaskStateValue): Promise<Task> {
  const task = await getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  task.state = state;
  await patchRun(taskId, { metadata: taskMetadata(task) });
  if (TERMINAL_STATES.has(state)) {
    await patchRun(taskId, { status: "completed" });
  } else if (PAUSED_STATES.has(state)) {
    await postEvent(taskId, "hook.waiting", { reason: state });
  } else {
    await postEvent(taskId, "step.started", { stage: state });
  }
  return task;
}

export async function updateTask(task: Task): Promise<void> {
  await patchRun(task.id, { metadata: taskMetadata(task) });
}

export async function advance(taskId: string): Promise<Task> {
  const task = await getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  const idx = STATE_ORDER.indexOf(task.state);
  if (idx < STATE_ORDER.length - 1) {
    return setState(taskId, STATE_ORDER[idx + 1]);
  }
  return task;
}

export async function allTasks(): Promise<Task[]> {
  const data = await apiRequest(
    "GET",
    `/v1/workflows/runs?workflow_type=${WORKFLOW_TYPE}&limit=100`
  ) as Record<string, unknown>;
  const runs = (Array.isArray(data) ? data : (data.runs as unknown[])) ?? [];
  return (runs as Record<string, unknown>[])
    .map(runToTask)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

export async function appendMessage(
  taskId: string,
  role: string,
  content: string,
  sessionId?: string | null
): Promise<void> {
  const body: Record<string, string> = { role, content };
  if (sessionId) body.session_id = sessionId;
  await apiRequest("POST", `/v1/workflows/runs/${taskId}/messages`, body);
}

export async function listActiveTasks(): Promise<Task[]> {
  const data = await apiRequest(
    "GET",
    `/v1/workflows/runs?workflow_type=${WORKFLOW_TYPE}&status=running,paused&limit=100`
  ) as Record<string, unknown>;
  const runs = (Array.isArray(data) ? data : (data.runs as unknown[])) ?? [];
  return (runs as Record<string, unknown>[]).map(runToTask);
}

export async function getRunDetail(runId: string): Promise<Record<string, unknown> | null> {
  try {
    return await apiRequest("GET", `/v1/workflows/runs/${runId}`) as Record<string, unknown>;
  } catch (e) {
    if ((e as Error).message.includes("404")) return null;
    throw e;
  }
}

export async function getRunEvents(runId: string): Promise<unknown[]> {
  const data = await apiRequest("GET", `/v1/workflows/runs/${runId}/events`) as Record<string, unknown>;
  return Array.isArray(data) ? data : (data.events as unknown[]) ?? [];
}

export async function getRunMessages(runId: string): Promise<unknown[]> {
  const data = await apiRequest("GET", `/v1/workflows/runs/${runId}/messages`) as Record<string, unknown>;
  return Array.isArray(data) ? data : (data.messages as unknown[]) ?? [];
}
