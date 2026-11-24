/**
 * Claude Code options for a Pi session.
 *
 * Claude Code's own harness runs the subscription request; everything that
 * duplicates Pi (settings files, CLAUDE.md, skills, hooks, memory, compaction,
 * built-in tools, tool search, advisor, fallbacks) is disabled here.
 * Settings follow OpenCode's claude-agent provider, adjusted for Pi.
 */
import type { EffortLevel, Options } from "@anthropic-ai/claude-agent-sdk";
import type { Tool } from "@earendil-works/pi-ai";
import type { PendingTools } from "./tool-bridge.js";
import { makeToolServer, toolHooks } from "./tool-bridge.js";

/** Claude Code features duplicated by Pi; Pi's version wins. */
const ISOLATION_ENV: Record<string, string | undefined> = {
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  DISABLE_AUTO_COMPACT: "1",
  CLAUDE_CODE_ENABLE_AWAY_SUMMARY: "0",
  ENABLE_TOOL_SEARCH: "false",
  CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1",
  CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: "1",
  CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: "1",
  // Let Pi's own truncation apply.
  MAX_MCP_OUTPUT_TOKENS: "200000",
  // A shell-level override would bypass Pi's login or effort choice.
  CLAUDE_CODE_SIMPLE: undefined,
  CLAUDE_CODE_EFFORT_LEVEL: undefined,
  // Would cap every Pi tool call, failing subagents and long permission prompts.
  MCP_TOOL_TIMEOUT: undefined,
};

export interface LaunchRequest {
  /** Claude family alias or concrete id: sonnet, opus, fable, claude-… */
  model: string;
  effort?: EffortLevel;
  /** Pi's instructions for Claude (see system-prompt.ts), appended under the CLI preset. */
  systemPrompt: string;
  tools: readonly Tool[];
  /** True for chat sessions; false for throwaway side calls. */
  persist: boolean;
  cwd: string;
}

/** Changing any of these needs a fresh process; model/effort change live. */
export function processFingerprint(request: LaunchRequest): string {
  return JSON.stringify({
    systemPrompt: request.systemPrompt,
    tools: request.tools.map((tool) => [tool.name, tool.description, tool.parameters]),
    persist: request.persist,
    cwd: request.cwd,
  });
}

export function baseOptions(request: LaunchRequest, executable: string, pending?: PendingTools): Options {
  const hasTools = request.tools.length > 0;
  const options: Options = {
    pathToClaudeCodeExecutable: executable,
    // Claude Code's own prompt is the harness prompt; Pi adds only the user's
    // instructions on top (see system-prompt.ts).
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      // Instruction changes must apply when a process resumes the session.
      snapshot: false,
      append: request.systemPrompt,
    },
    tools: [],
    skills: [],
    settingSources: [],
    strictMcpConfig: true,
    thinking: { type: "adaptive", display: "summarized" },
    verbatimPrompts: true,
    // Without partial messages Pi only sees whole blocks, not live deltas.
    includePartialMessages: true,
    permissionMode: "dontAsk",
    allowedTools: hasTools ? ["mcp__pi__*"] : [],
    persistSession: request.persist,
    effort: request.effort,
    model: request.model,
    env: { ...process.env, ...ISOLATION_ENV, CLAUDE_AGENT_SDK_CLIENT_APP: "lambda" },
    cwd: request.cwd,
  };
  if (hasTools && pending) {
    options.mcpServers = { pi: makeToolServer(request.tools, pending) };
    options.hooks = toolHooks(pending);
  }
  if (!request.persist) {
    // Side calls keep hooks off entirely; they never host tool traffic.
    options.hooks = undefined;
  }
  return options;
}
