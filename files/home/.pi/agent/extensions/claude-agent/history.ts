/**
 * Pi transcript → Claude content blocks.
 *
 * Claude Code runs its own transcript, so earlier turns can't be replayed as
 * native messages; unseen history goes into one `<conversation-checkpoint>`
 * user message, with attachments kept as real blocks and tool traffic as
 * tagged JSON. Result delivery for parked calls goes the other way: real
 * tool_result payloads that resume Claude's own turn.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export type UserContent = SDKUserMessage["message"]["content"];
export type ClaudeBlock = Exclude<UserContent, string>[number];
export type ToolPayload = { content: CallToolResult["content"]; isError: boolean };

const CHECKPOINT_OPEN = "<conversation-checkpoint>";
const CHECKPOINT_CLOSE = "</conversation-checkpoint>";
const CHECKPOINT_NOTE =
  "The following is conversation history from Pi that you have not seen. " +
  "Treat it as prior conversation, not a new request. Continue with the user's messages after this checkpoint.";

/** Visible (non-system) messages become the checkpoint body. */
export function checkpointBlocks(messages: readonly Message[]): ClaudeBlock[] {
  const blocks: ClaudeBlock[] = [{ type: "text" as const, text: `${CHECKPOINT_OPEN}\n${CHECKPOINT_NOTE}\n` }];
  for (const message of messages) {
    if (message.role === "system") continue;
    blocks.push({ type: "text" as const, text: `<${message.role}>` });
    if (message.role === "user") {
      blocks.push(...userBlocks(message));
    } else if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "text" && part.text) blocks.push({ type: "text", text: part.text });
        else if (part.type === "thinking" && part.thinking) {
          // Never replay Claude's own thinking; the model regenerates it.
          blocks.push({ type: "text", text: `<thinking>\n${part.thinking.slice(-2000)}\n</thinking>` });
        } else if (part.type === "toolCall") {
          blocks.push({
            type: "text",
            text: `<tool-call>\n${JSON.stringify({ id: part.id, name: part.name, input: part.arguments })}\n</tool-call>`,
          });
        }
      }
    } else if (message.role === "toolResult") {
      blocks.push({ type: "text", text: toolResultText(message) });
    }
    blocks.push({ type: "text" as const, text: `</${message.role}>` });
  }
  blocks.push({ type: "text" as const, text: CHECKPOINT_CLOSE });
  return blocks;
}

/**
 * Content for a fresh Claude session joining an existing Pi conversation:
 * everything up to the trailing user messages goes into one checkpoint, and
 * those trailing messages are sent as the real turn (OpenCode's catch-up).
 * Without trailing user input (e.g. history ending in tool results), Claude is
 * asked to continue where the conversation left off.
 */
export function catchUpBlocks(messages: readonly Message[]): ClaudeBlock[] {
  const visible = messages.filter((message) => message.role !== "system");
  let start = visible.length;
  while (start > 0 && visible[start - 1]?.role === "user") start -= 1;
  const history = visible.slice(0, start);
  const trailing = visible.slice(start) as Extract<Message, { role: "user" }>[];
  const blocks: ClaudeBlock[] = history.length > 0 ? checkpointBlocks(history) : [];
  for (const message of trailing) blocks.push(...userBlocks(message));
  if (trailing.length === 0 && history.length > 0) {
    blocks.push({ type: "text", text: "Continue from where the conversation left off." });
  }
  return blocks;
}

/** The raw payload Pi hands back for a parked Claude tool call. */
export function toolResultPayload(result: ToolResultMessage): ToolPayload {
  const content: CallToolResult["content"] = [];
  for (const part of result.content) {
    if (part.type === "text") {
      content.push({ type: "text", text: part.text });
    } else if (part.type === "image") {
      content.push({ type: "image", data: part.data, mimeType: part.mimeType });
    }
  }
  return { content, isError: result.isError };
}

function toolResultText(result: ToolResultMessage): string {
  const body = result.content.map((part) => (part.type === "text" ? part.text : `[image:${part.mimeType}]`)).join("\n");
  return `<tool-result>\n${JSON.stringify({ id: result.toolCallId, name: result.toolName, output: body, isError: result.isError })}\n</tool-result>`;
}

export function userBlocks(message: Extract<Message, { role: "user" }>): ClaudeBlock[] {
  const blocks: ClaudeBlock[] = [];
  const parts: (TextContent | ImageContent)[] =
    typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
  for (const part of parts) {
    if (part.type === "image") blocks.push(imageBlock(part));
    else blocks.push({ type: "text", text: part.text });
  }
  return blocks;
}

function imageBlock(part: ImageContent): ClaudeBlock {
  return {
    type: "image",
    source: { type: "base64", media_type: part.mimeType, data: part.data },
  } as ClaudeBlock;
}

/**
 * Ordered identity tags of a Pi assistant message. Their exactness is what
 * marks Pi history as "already seen by Claude": an assistant message with
 * different tags means the history changed under us (model switch, edit,
 * tree navigation, compaction) and the whole conversation must be re-sent.
 */
export function assistantTags(content: AssistantMessage["content"]): string[] {
  return content.map((part) =>
    part.type === "text" ? `t:${part.text}` : part.type === "toolCall" ? `c:${part.id}` : `k:`,
  );
}

/** True when the message is exactly the assistant message these tags describe. */
export function isOwnAssistant(
  message: Message | undefined,
  tags: readonly string[] | undefined,
): message is Extract<Message, { role: "assistant" }> {
  if (!tags || !message || message.role !== "assistant") return false;
  const actual = assistantTags(message.content);
  return actual.length === tags.length && actual.every((tag, i) => tag === tags[i]);
}

export type { TextContent, ThinkingContent, ToolCall };
