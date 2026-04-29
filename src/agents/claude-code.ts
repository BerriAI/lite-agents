import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { AgentEntrypoint, AgentMessage } from "../agent-spec.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_CONFIG = join(__dirname, "../../mcp.json");
const SCREENSHOT_DIR = "/tmp/claude-screenshots";

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatToolInput(name: string, inp: Record<string, unknown>): string {
  if (name === "Bash") return ((inp.command as string) ?? "").slice(0, 120);
  if (["Read", "Write", "Edit", "NotebookEdit"].includes(name))
    return (inp.file_path as string) ?? (inp.notebook_path as string) ?? "";
  if (name === "Grep") return `${inp.pattern ?? ""} ${inp.path ?? ""}`;
  if (name === "Glob") return (inp.pattern as string) ?? "";
  return JSON.stringify(inp).slice(0, 80);
}

function isImagePath(s: string): boolean {
  return /\.(png|jpg|jpeg|gif|webp)$/.test(s.trim());
}

type McpConfig = Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;

function loadMcpServers(): McpConfig | undefined {
  if (!existsSync(MCP_CONFIG)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(MCP_CONFIG, "utf8")) as Record<string, unknown>;
    return (raw.mcpServers ?? raw) as McpConfig;
  } catch { return undefined; }
}

// ── SDK message → AgentMessage ────────────────────────────────────────────────

type ToolResultBlock = { type: string; tool_use_id?: string; content?: unknown };
type ContentBlock = { type: string; source?: { type?: string; data?: string }; text?: string };

function mapSdkMessage(msg: SDKMessage): AgentMessage[] {
  if (msg.type === "assistant") {
    const out: AgentMessage[] = [];
    for (const block of msg.message.content) {
      if (block.type === "tool_use") {
        out.push({
          type: "tool_call",
          id: block.id,
          name: block.name,
          summary: formatToolInput(block.name, block.input as Record<string, unknown>),
        });
      } else if (block.type === "text") {
        const raw = (block as { type: "text"; text: string }).text;
        if (!raw?.trim()) continue;
        const text = raw.replace(
          /\/tmp\/claude-screenshots\/([^)\s"']+)/g,
          (_: string, f: string) => `/screenshots/${f.split("/").pop()}`
        );
        out.push({ type: "text", text });
      }
    }
    return out;
  }

  if (msg.type === "user") {
    const content = msg.message.content;
    if (!Array.isArray(content)) return [];
    for (const block of content as ToolResultBlock[]) {
      if (block.type !== "tool_result") continue;
      let c = block.content ?? "";
      if (Array.isArray(c)) {
        for (const item of c as ContentBlock[]) {
          if (item.type === "image" && item.source?.type === "base64" && item.source.data) {
            const imgPath = join(SCREENSHOT_DIR, `mcp_${block.tool_use_id ?? "unknown"}.png`);
            mkdirSync(SCREENSHOT_DIR, { recursive: true });
            writeFileSync(imgPath, Buffer.from(item.source.data, "base64"));
            return [{ type: "image", path: imgPath, tool_use_id: block.tool_use_id }];
          }
        }
        c = (c as ContentBlock[]).filter((i) => i.type === "text").map((i) => i.text ?? "").join("\n");
      }
      const s = String(c);
      if (isImagePath(s.trim())) return [{ type: "image", path: s.trim(), tool_use_id: block.tool_use_id }];
      const m = s.match(/\[Screenshot[^\]]*\]\(([^)]+\.(?:png|jpg|jpeg|gif|webp))\)/);
      if (m) {
        const resolved = m[1].startsWith("/") ? m[1] : join(SCREENSHOT_DIR, m[1].split("/").pop()!);
        if (existsSync(resolved)) return [{ type: "image", path: resolved, tool_use_id: block.tool_use_id }];
      }
      return [{ type: "tool_result", id: block.tool_use_id, content: s }];
    }
    return [];
  }

  if (msg.type === "result" && msg.subtype === "success") {
    return [{
      type: "stats",
      duration_s: msg.duration_ms / 1000,
      output_tokens: msg.usage.output_tokens,
      cost: msg.total_cost_usd,
      session_id: msg.session_id,
    }];
  }

  return [];
}

// ── Agent entrypoint ──────────────────────────────────────────────────────────

export const claudeCodeAgent: AgentEntrypoint = async function*(prompt, { cwd, resumeId }) {
  const mcpServers = loadMcpServers();
  try {
    for await (const msg of query({
      prompt,
      options: {
        cwd,
        ...(resumeId ? { resume: resumeId } : {}),
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        ...(mcpServers ? { mcpServers } : {}),
      },
    })) {
      for (const event of mapSdkMessage(msg)) yield event;
    }
  } catch (e) {
    yield { type: "error", text: String(e) };
  }
};
