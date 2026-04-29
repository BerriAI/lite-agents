// This is the file you edit to swap agents. Nothing else in the codebase changes.
//
// Default: Claude Code via @anthropic-ai/claude-agent-sdk.
// To use a different agent, implement AgentEntrypoint from ./agent-spec.ts and export it as `agent`.
export { claudeCodeAgent as agent } from "./agents/claude-code.js";
