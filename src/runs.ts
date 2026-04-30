import fetch from "node-fetch";

const BASE = (process.env.LITELLM_PROXY_URL ?? "").replace(/\/$/, "");
const KEY = process.env.LITELLM_API_KEY ?? "";

export interface WorkflowRun {
  id: string;
  status: string;
  workflowType: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

function headers(): Record<string, string> {
  return { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
}

async function req(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: headers(),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${await res.text().catch(() => "")}`);
  return res.json();
}

function toRun(r: Record<string, unknown>): WorkflowRun {
  return {
    id: r.run_id as string,
    status: r.status as string,
    workflowType: r.workflow_type as string,
    metadata: (r.metadata as Record<string, unknown>) ?? {},
    createdAt: new Date(r.created_at as string),
  };
}

export async function createRun(
  workflowType: string,
  metadata?: Record<string, unknown>
): Promise<WorkflowRun> {
  return toRun(await req("POST", "/v1/workflows/runs", { workflow_type: workflowType, metadata }) as Record<string, unknown>);
}

export async function getRun(id: string): Promise<WorkflowRun | null> {
  try {
    return toRun(await req("GET", `/v1/workflows/runs/${id}`) as Record<string, unknown>);
  } catch (e) {
    if ((e as Error).message.includes("404")) return null;
    throw e;
  }
}

export async function updateRun(
  id: string,
  patch: { status?: string; metadata?: Record<string, unknown> }
): Promise<void> {
  await req("PATCH", `/v1/workflows/runs/${id}`, patch);
}

export async function listRuns(params?: {
  workflowType?: string;
  status?: string;
  limit?: number;
}): Promise<WorkflowRun[]> {
  const qs = new URLSearchParams();
  if (params?.workflowType) qs.set("workflow_type", params.workflowType);
  if (params?.status) qs.set("status", params.status);
  if (params?.limit) qs.set("limit", String(params.limit));
  const data = await req("GET", `/v1/workflows/runs?${qs}`) as Record<string, unknown>;
  const runs = Array.isArray(data) ? data : (data.runs as unknown[]) ?? [];
  return (runs as Record<string, unknown>[]).map(toRun);
}

export async function appendEvent(
  runId: string,
  eventType: string,
  stepName: string,
  data: Record<string, unknown> = {}
): Promise<void> {
  await req("POST", `/v1/workflows/runs/${runId}/events`, { event_type: eventType, step_name: stepName, data });
}

export async function appendMessage(
  runId: string,
  role: string,
  content: string,
  sessionId?: string | null
): Promise<void> {
  await req("POST", `/v1/workflows/runs/${runId}/messages`, {
    role,
    content,
    ...(sessionId ? { session_id: sessionId } : {}),
  });
}

export async function getRunEvents(runId: string): Promise<unknown[]> {
  const data = await req("GET", `/v1/workflows/runs/${runId}/events`) as Record<string, unknown>;
  return Array.isArray(data) ? data : (data.events as unknown[]) ?? [];
}

export async function getRunMessages(runId: string): Promise<unknown[]> {
  const data = await req("GET", `/v1/workflows/runs/${runId}/messages`) as Record<string, unknown>;
  return Array.isArray(data) ? data : (data.messages as unknown[]) ?? [];
}
