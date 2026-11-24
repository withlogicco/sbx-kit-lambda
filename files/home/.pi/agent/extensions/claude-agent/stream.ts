/**
 * Claude SDK messages → Pi assistant-message events.
 *
 * One converter instance serves one Pi step. The Pi-side assistant message is
 * assembled in place while events stream, so Pi renders text, thinking
 * summaries, and tool calls exactly like it does for every other provider.
 */
import type { AssistantMessage, AssistantMessageEventStream, StopReason, ToolCall } from "@earendil-works/pi-ai";
import type { SDKAssistantMessage, SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

type SDKStreamEvent = Extract<SDKMessage, { type: "stream_event" }>["event"];
import { assistantTags } from "./history.js";

const TOOL_PREFIX = "mcp__pi__";

type AssistantBlock = AssistantMessage["content"][number];
type UsageBlock = {
  input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  output_tokens?: number;
  output_tokens_details?: { thinking_tokens?: number } | null;
};

/** What one phase (window of SDK messages) ended with. */
export interface PhaseOutcome {
  mode: "tools" | "result";
  result?: SDKResultMessage;
  /** Claude's own session id when an assistant/result carried one. */
  sessionId?: string;
  /** True when the request signal aborted. */
  aborted: boolean;
}

export class StepConverter {
  private readonly counters = new Map<
    string,
    { input: number; read: number; write: number; output: number; reasoning: number }
  >();
  /** Last API message id; its whole context size is Pi's prompt size. */
  private lastId: string | undefined;
  /** Complete assistant messages echo the streamed ones; track by API message id. */
  private readonly streamed = new Set<string>();
  /** SDK content_block index → Pi content index. */
  private readonly open = new Map<number, number>();
  /** Open tool calls' accumulated JSON, by SDK content_block index. */
  private readonly partialJson = new Map<number, string>();
  private messageId = "";
  /** Text of a synthetic API error message seen during this step. */
  private apiError: string | undefined;

  constructor(
    private readonly stream: AssistantMessageEventStream,
    private readonly output: AssistantMessage,
    private readonly toolNames: ReadonlySet<string>,
  ) {}

  // ------------------------------------------------------------------ wiring

  /** Every phase message lands here; subagent traffic is filtered out. */
  handle = (message: SDKMessage): void => {
    switch (message.type) {
      case "stream_event":
        if (message.parent_tool_use_id === null) this.streamEvent(message.event);
        return;
      case "assistant":
        if (message.parent_tool_use_id !== null) return;
        if (message.error) {
          // Synthetic API errors (auth, billing, overload) are diagnostics,
          // not answers; Claude Code still reports the turn as "success".
          this.apiError =
            message.message.content
              .map((block) => (block.type === "text" ? block.text : ""))
              .join("")
              .trim() || `Claude Code API error: ${message.error}`;
          return;
        }
        this.completeAssistant(message);
        return;
      case "user":
        // Claude Code's own tool_result echo (or its "no such tool" filler).
        return;
      case "result":
        // Whole-turn totals include earlier Pi steps; use per-message usage instead.
        return;
      default:
        return; // system, status, rate-limit and friends stay runtime-internal
    }
  };

  /** Ordered tags Pi will persist for this step; used for history sync. */
  replyTags(): string[] {
    return assistantTags(this.output.content);
  }

  finishTools(): void {
    this.applyUsage();
    this.output.stopReason = "toolUse";
    this.stream.push({ type: "done", reason: "toolUse", message: this.output });
    this.stream.end();
  }

  finishResult(result: SDKResultMessage | undefined, aborted: boolean, signalAborted: boolean): void {
    const info = result as (SDKResultMessage & { errors?: string[]; result?: string }) | undefined;
    const abortedFinal = aborted || signalAborted;
    if (!abortedFinal && this.apiError) {
      this.applyUsage();
      this.stream.push({ type: "error", reason: "error", error: withProblem(this.output, "error", this.apiError) });
      this.stream.end();
      return;
    }
    if (abortedFinal || !result || result.subtype.startsWith("error_")) {
      const reason = abortedFinal ? "aborted" : "error";
      this.applyUsage();
      this.stream.push({
        type: "error",
        reason,
        error: withProblem(
          this.output,
          reason,
          abortedFinal
            ? "Request was aborted"
            : (info?.errors?.join("; ") ?? info?.result ?? "Claude Code failed without a reason."),
        ),
      });
      this.stream.end();
      return;
    }
    this.applyUsage();
    const stopReason: StopReason = result.stop_reason === "max_output_tokens" ? "length" : "stop";
    this.output.stopReason = stopReason;
    this.stream.push({ type: "done", reason: stopReason, message: this.output });
    this.stream.end();
  }

  // ------------------------------------------------------------ big switch

  private streamEvent(event: SDKStreamEvent): void {
    switch (event.type) {
      case "message_start": {
        this.messageId = event.message.id;
        // The SDK emits each completed block as an assistant message before
        // message_stop; anything that started streaming is already rendered.
        this.streamed.add(event.message.id);
        this.usage(event.message.id, event.message.usage);
        this.output.responseModel ??= event.message.model;
        break;
      }
      case "content_block_start": {
        const block = event.content_block;
        if (block.type === "text") {
          this.openBlock(event.index, { type: "text", text: "" });
          if (block.text) this.appendText(event.index, block.text);
        } else if (block.type === "thinking") {
          this.openBlock(event.index, { type: "thinking", thinking: "", thinkingSignature: "" });
          if (block.thinking) this.appendThinking(event.index, block.thinking);
        } else if (block.type === "tool_use") {
          if (!this.toolNames.has(block.name)) break;
          this.openBlock(event.index, { type: "toolCall", id: block.id, name: unprefix(block.name), arguments: {} });
        }
        break;
      }
      case "content_block_delta": {
        const delta = event.delta;
        if (delta.type === "text_delta") this.appendText(event.index, delta.text);
        else if (delta.type === "thinking_delta" && delta.thinking) this.appendThinking(event.index, delta.thinking);
        else if (delta.type === "signature_delta") this.appendSignature(event.index, delta.signature);
        else if (delta.type === "input_json_delta") this.appendCallJson(event.index, delta.partial_json);
        break;
      }
      case "content_block_stop": {
        const index = this.open.get(event.index);
        if (index === undefined) break;
        this.open.delete(event.index);
        const part = this.output.content[index];
        if (!part) break;
        if (part.type === "toolCall") {
          const raw = this.partialJson.get(event.index);
          if (raw !== undefined) {
            try {
              part.arguments = JSON.parse(raw);
            } catch {
              part.arguments = {};
            }
          }
          this.partialJson.delete(event.index);
          this.stream.push({ type: "toolcall_end", contentIndex: index, toolCall: part, partial: this.output });
        } else {
          this.stream.push({
            type: part.type === "thinking" ? "thinking_end" : "text_end",
            contentIndex: index,
            content: part.type === "thinking" ? part.thinking : part.text,
            partial: this.output,
          });
        }
        break;
      }
      case "message_delta": {
        this.usage(this.messageId, event.usage);
        break;
      }
      default:
        break;
    }
  }

  // ------------------------------------------------------- streamed blocks

  private openBlock(sdkIndex: number, block: AssistantBlock): void {
    this.output.content.push(block);
    const index = this.output.content.length - 1;
    this.open.set(sdkIndex, index);
    if (block.type === "text") {
      this.stream.push({ type: "text_start", contentIndex: index, partial: this.output });
    } else if (block.type === "thinking") {
      this.stream.push({ type: "thinking_start", contentIndex: index, partial: this.output });
    } else {
      this.stream.push({ type: "toolcall_start", contentIndex: index, partial: this.output });
    }
  }

  private appendText(sdkIndex: number, text: string): void {
    const index = this.open.get(sdkIndex);
    const part = this.output.content[index ?? -1];
    if (index === undefined || !part || part.type !== "text") return;
    part.text += text;
    this.stream.push({ type: "text_delta", contentIndex: index, delta: text, partial: this.output });
  }

  private appendThinking(sdkIndex: number, thinking: string): void {
    const index = this.open.get(sdkIndex);
    const part = this.output.content[index ?? -1];
    if (index === undefined || !part || part.type !== "thinking") return;
    part.thinking += thinking;
    this.stream.push({ type: "thinking_delta", contentIndex: index, delta: thinking, partial: this.output });
  }

  private appendSignature(sdkIndex: number, signature: string): void {
    const index = this.open.get(sdkIndex);
    const part = this.output.content[index ?? -1];
    if (index === undefined || !part || part.type !== "thinking") return;
    part.thinkingSignature = (part.thinkingSignature ?? "") + signature;
  }

  private appendCallJson(sdkIndex: number, json: string): void {
    const index = this.open.get(sdkIndex);
    const part = this.output.content[index ?? -1];
    if (index === undefined || !part || part.type !== "toolCall") return;
    const acc = (this.partialJson.get(sdkIndex) ?? "") + json;
    this.partialJson.set(sdkIndex, acc);
    try {
      part.arguments = JSON.parse(acc);
    } catch {
      // Partial JSON is expected to be invalid mid-stream.
    }
    this.stream.push({ type: "toolcall_delta", contentIndex: index, delta: json, partial: this.output });
  }

  // --------------------------------------------------- complete messages

  /**
   * Whole assistant messages arrive alongside the streamed ones. Content that
   * already streamed is skipped; otherwise it is replayed as start/delta/end
   * triplets, the way a non-streaming provider would appear.
   */
  private completeAssistant(message: SDKAssistantMessage): void {
    this.usage(message.message.id, message.message.usage);
    // Several per-block echoes share one id, so the id is not marked here.
    if (!this.streamed.has(message.message.id)) {
      for (const block of message.message.content) this.replayBlock(block);
    }
  }

  private replayBlock(block: SDKAssistantMessage["message"]["content"][number]): void {
    if (block.type === "text" && block.text) {
      const index = this.addItem({ type: "text", text: block.text });
      this.emitStart(index, "text_start");
      this.stream.push({ type: "text_delta", contentIndex: index, delta: block.text, partial: this.output });
      this.stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: this.output });
    } else if (block.type === "thinking" && block.thinking) {
      const signature = (block as { signature?: string }).signature ?? "";
      const index = this.addItem({ type: "thinking", thinking: block.thinking, thinkingSignature: signature });
      this.emitStart(index, "thinking_start");
      this.stream.push({ type: "thinking_delta", contentIndex: index, delta: block.thinking, partial: this.output });
      this.stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: this.output });
    } else if (block.type === "tool_use" && this.toolNames.has(block.name)) {
      const call: ToolCall = {
        type: "toolCall",
        id: block.id,
        name: unprefix(block.name),
        arguments: (block.input ?? {}) as ToolCall["arguments"],
      };
      const index = this.addItem(call);
      this.emitStart(index, "toolcall_start");
      this.stream.push({ type: "toolcall_end", contentIndex: index, toolCall: call, partial: this.output });
    }
    // Unoffered tool calls and empty blocks are Claude Code-internal; skip.
  }

  private addItem(block: AssistantBlock): number {
    this.output.content.push(block);
    return this.output.content.length - 1;
  }

  private emitStart(index: number, kind: "text_start" | "thinking_start" | "toolcall_start"): void {
    this.stream.push({ type: kind, contentIndex: index, partial: this.output });
  }

  // ---------------------------------------------------------------- usage

  private usage(id: string, data: UsageBlock): void {
    const saved = this.counters.get(id) ?? { input: 0, read: 0, write: 0, output: 0, reasoning: 0 };
    if (!this.counters.has(id)) {
      this.counters.set(id, saved);
      this.lastId = id;
    }
    saved.input = Math.max(saved.input, data.input_tokens ?? 0);
    saved.read = Math.max(saved.read, data.cache_read_input_tokens ?? 0);
    saved.write = Math.max(saved.write, data.cache_creation_input_tokens ?? 0);
    saved.output = Math.max(saved.output, data.output_tokens ?? 0);
    saved.reasoning = Math.max(saved.reasoning, data.output_tokens_details?.thinking_tokens ?? 0);
  }

  private applyUsage(): void {
    let output = 0;
    let reasoning = 0;
    for (const counts of this.counters.values()) {
      output += counts.output;
      reasoning += counts.reasoning;
    }
    const last = this.lastId === undefined ? undefined : this.counters.get(this.lastId);
    const usage = this.output.usage;
    usage.output = output;
    if (reasoning > 0) usage.reasoning = reasoning;
    if (last) {
      // Prompt occupancy is the last API call's whole context, not the sum
      // of the repeated contexts that multi-call turns produce.
      usage.input = last.input;
      usage.cacheRead = last.read;
      usage.cacheWrite = last.write;
    }
    usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    // A subscription covers usage; the mock rate card stays at zero.
    usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  }
}

function withProblem(message: AssistantMessage, reason: "error" | "aborted", text: string): AssistantMessage {
  message.stopReason = reason;
  message.errorMessage = text;
  return message;
}

function unprefix(name: string): string {
  return name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name;
}
