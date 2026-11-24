/**
 * Exposes Pi's tools to Claude as an MCP server named `pi`.
 *
 * Claude runs the call, our handler parks until the next Pi turn delivers the
 * Pi-computed tool result, and the parked Claude turn continues with it. The
 * PreToolUse hook is the only place the call id (Claude's tool_use_id) shows
 * up, and one id is remembered at a time, so tools must not run in parallel:
 * every definition advertises `readOnlyHint: false`, which Claude Code treats
 * as "serialize calls".
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import type { McpSdkServerConfigWithInstance, Options, SDKAssistantMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Tool } from "@earendil-works/pi-ai";
import crypto from "node:crypto";

const SERVER_NAME = "pi";

/** `mcp__pi__<name>` minus the prefix. */
export const TOOL_PREFIX = `mcp__${SERVER_NAME}__`;

interface Pending {
  /** Fully prefixed tool name, `mcp__pi__<name>`. */
  readonly name: string;
  readonly promise: Promise<CallToolResult>;
  resolve: (result: CallToolResult) => void;
  resolved: boolean;
}

export interface PendingTools {
  /**
   * Claude's assistant message announced a call. Slots must exist before Pi's
   * results arrive: with several calls in one message, Claude Code runs them
   * one at a time, so later calls reach PreToolUse only after the earlier
   * results were already delivered.
   */
  announce: (id: string, name: string) => void;
  /** PreToolUse: the next handler invocation belongs to this call id. */
  expect: (id: string, name: string) => void;
  /** The MCP handler parks here until resolve() hands it Pi's tool result. */
  call: (name: string) => Promise<CallToolResult>;
  /** Pi-side tool results from the next step, keyed by Pi's toolCallId == Claude's tool_use_id. */
  resolve: (results: ReadonlyMap<string, { content: CallToolResult["content"]; isError: boolean }>) => void;
  /** Resolve everything as cancelled; used when stopping a process. */
  clear: () => void;
}

export function makePending(): PendingTools {
  // Calls by Claude's tool_use_id. A slot lives from announcement until its
  // handler consumed the result, so resolution order and handler order are
  // independent.
  const calls = new Map<string, Pending>();
  let next: string | undefined;

  function slot(id: string, name: string): Pending {
    const saved = calls.get(id);
    if (saved) {
      if (saved.name !== name) throw new Error(`Mismatched Claude tool call ${id}: ${saved.name} vs ${name}`);
      return saved;
    }
    let resolve!: (result: CallToolResult) => void;
    const promise = new Promise<CallToolResult>((res) => (resolve = res));
    const pending: Pending = {
      name,
      promise,
      resolved: false,
      resolve: (result) => {
        pending.resolved = true;
        resolve(result);
      },
    };
    calls.set(id, pending);
    return pending;
  }

  return {
    announce(id, name) {
      slot(id, name);
    },
    expect(id, name) {
      slot(id, name);
      next = id;
    },
    async call(name) {
      const id = next;
      next = undefined;
      if (!id) {
        return {
          isError: true,
          content: [{ type: "text", text: "Pi received the tool call without its PreToolUse id." }],
        };
      }
      const pending = calls.get(id);
      if (!pending || pending.name !== name) {
        calls.delete(id);
        return { isError: true, content: [{ type: "text", text: `Pi could not match tool call ${id} (${name}).` }] };
      }
      try {
        return await pending.promise;
      } finally {
        calls.delete(id);
      }
    },
    resolve(results) {
      for (const [id, result] of results) {
        const pending = calls.get(id);
        // A result for a call Claude never announced (e.g. an unoffered tool).
        if (!pending || pending.resolved) continue;
        pending.resolve({ content: result.content, isError: result.isError });
      }
    },
    clear() {
      const cancelled: CallToolResult = { isError: true, content: [{ type: "text", text: "Cancelled by Pi." }] };
      for (const pending of calls.values()) if (!pending.resolved) pending.resolve(cancelled);
      calls.clear();
      next = undefined;
    },
  };
}

/** In-process MCP server deferring every call to `pending.call`. */
export function makeToolServer(tools: readonly Tool[], pending: PendingTools): McpSdkServerConfigWithInstance {
  const server = new Server({ name: SERVER_NAME, version: "1.0.0" }, { capabilities: { tools: {} } });
  const definitions: McpTool[] = tools.map((tool) => ({
    name: safeName(tool.name),
    description: tool.description,
    inputSchema: (tool.parameters ?? { type: "object", properties: {} }) as McpTool["inputSchema"],
    annotations: { readOnlyHint: false },
  }));
  const byName = new Map(definitions.map((tool) => [tool.name, tool]));
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    if (!byName.has(name))
      return { isError: true, content: [{ type: "text", text: `Unknown tool ${name}.` }] as CallToolResult["content"] };
    return pending.call(TOOL_PREFIX + name);
  });
  return {
    type: "sdk",
    name: SERVER_NAME,
    instance: server as unknown as McpSdkServerConfigWithInstance["instance"],
  };
}

/** Claude Code wants MCP-nesting-safe names to look like javascript identifiers. */
function safeName(name: string): string {
  return /^[a-zA-Z0-9_-]+$/.test(name) ? name : name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** The hook reports the call id the model assigned; the handler can't see it. */
export function toolHooks(pending: PendingTools): Options["hooks"] {
  const before = async (input: { hook_event_name: string; tool_use_id?: string; tool_name?: string }) => {
    if (input.hook_event_name === "PreToolUse") {
      pending.expect(input.tool_use_id ?? `unhooked-${crypto.randomUUID()}`, input.tool_name ?? "");
    }
    return {};
  };
  return { PreToolUse: [{ hooks: [before as never] }] };
}

type AssistantContentBlock = SDKAssistantMessage["message"]["content"][number];

/** Claude's assistant tool_use blocks, filtered to the tools we offered. */
export function offeredToolCalls(
  blocks: readonly AssistantContentBlock[],
  toolNames: ReadonlySet<string>,
): Extract<AssistantContentBlock, { type: "tool_use" }>[] {
  const calls: Extract<AssistantContentBlock, { type: "tool_use" }>[] = [];
  for (const block of blocks) {
    if (
      block.type === "tool_use" &&
      block.name.startsWith(TOOL_PREFIX) &&
      toolNames.has(block.name.slice(TOOL_PREFIX.length))
    ) {
      calls.push(block);
    }
  }
  return calls;
}
