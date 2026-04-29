/**
 * The public contract any agent must implement.
 * Swap the agent in app.ts — nothing else changes.
 */

export type AgentMessage =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; summary: string }
  | { type: "tool_result"; id: string | undefined; content: string }
  | { type: "image"; path: string; tool_use_id?: string }
  | { type: "stats"; duration_s: number; output_tokens: number; cost: number; session_id: string | null }
  | { type: "error"; text: string }

export interface AgentRunOptions {
  cwd: string
  taskId: string
  resumeId?: string | null
}

export type AgentEntrypoint = (
  prompt: string,
  opts: AgentRunOptions
) => AsyncGenerator<AgentMessage>
