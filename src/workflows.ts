const BASE = (process.env.LITELLM_PROXY_URL ?? "").replace(/\/$/, "");
const KEY = process.env.LITELLM_API_KEY ?? "";

export interface Workflow {
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

function toWorkflow(r: Record<string, unknown>): Workflow {
  return {
    id: r.run_id as string,
    status: r.status as string,
    workflowType: r.workflow_type as string,
    metadata: (r.metadata as Record<string, unknown>) ?? {},
    createdAt: new Date(r.created_at as string),
  };
}

export async function createWorkflow(
  workflowType: string,
  metadata?: Record<string, unknown>
): Promise<Workflow> {
  return toWorkflow(await req("POST", "/v1/workflows/runs", { workflow_type: workflowType, metadata }) as Record<string, unknown>);
}

export async function getWorkflow(id: string): Promise<Workflow | null> {
  try {
    return toWorkflow(await req("GET", `/v1/workflows/runs/${id}`) as Record<string, unknown>);
  } catch (e) {
    if ((e as Error).message.includes("404")) return null;
    throw e;
  }
}

export async function updateWorkflow(
  id: string,
  patch: { status?: string; metadata?: Record<string, unknown> }
): Promise<void> {
  await req("PATCH", `/v1/workflows/runs/${id}`, patch);
}

export async function listWorkflows(params?: {
  workflowType?: string;
  status?: string;
  limit?: number;
}): Promise<Workflow[]> {
  const qs = new URLSearchParams();
  if (params?.workflowType) qs.set("workflow_type", params.workflowType);
  if (params?.status) qs.set("status", params.status);
  if (params?.limit) qs.set("limit", String(params.limit));
  const data = await req("GET", `/v1/workflows/runs?${qs}`) as Record<string, unknown>;
  const items = Array.isArray(data) ? data : (data.runs as unknown[]) ?? [];
  return (items as Record<string, unknown>[]).map(toWorkflow);
}

export async function appendEvent(
  workflowId: string,
  eventType: string,
  stepName: string,
  data: Record<string, unknown> = {}
): Promise<void> {
  await req("POST", `/v1/workflows/runs/${workflowId}/events`, { event_type: eventType, step_name: stepName, data });
}

export async function appendMessage(
  workflowId: string,
  role: string,
  content: string,
  sessionId?: string | null
): Promise<void> {
  await req("POST", `/v1/workflows/runs/${workflowId}/messages`, {
    role,
    content,
    ...(sessionId ? { session_id: sessionId } : {}),
  });
}

export async function getEvents(workflowId: string): Promise<unknown[]> {
  const data = await req("GET", `/v1/workflows/runs/${workflowId}/events`) as Record<string, unknown>;
  return Array.isArray(data) ? data : (data.events as unknown[]) ?? [];
}

export async function getMessages(workflowId: string): Promise<unknown[]> {
  const data = await req("GET", `/v1/workflows/runs/${workflowId}/messages`) as Record<string, unknown>;
  return Array.isArray(data) ? data : (data.messages as unknown[]) ?? [];
}
