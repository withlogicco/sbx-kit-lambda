/**
 * One long-lived `claude` child process wrapped as a queued message source.
 *
 * A single process serves a whole Pi session. A "phase" is one Pi step's
 * window: it ends either at the park boundary (message_stop after tool_use
 * blocks for the tools Pi offered) or when the SDK's result message arrives.
 */
import { ReadableStream } from "node:stream/web";
import type {
  McpServerStatus,
  Options as SdkOptions,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { load, versionError } from "./sdk.js";
import type { Query } from "@anthropic-ai/claude-agent-sdk";

const INIT_TIMEOUT_MS = 30_000;

/** Set LAMBDA_CLAUDE_AGENT_DEBUG=1 to trace SDK message types to stderr. */
const DEBUG = process.env["LAMBDA_CLAUDE_AGENT_DEBUG"] === "1";

function debugLog(message: SDKMessage): void {
  const detail =
    message.type === "stream_event"
      ? message.event.type
      : message.type === "system" || message.type === "result"
        ? (message as { subtype?: string }).subtype
        : "";
  const usage =
    message.type === "stream_event" &&
    (message.event.type === "message_delta" || message.event.type === "message_start")
      ? JSON.stringify(message.event.type === "message_delta" ? message.event.usage : message.event.message.usage)
      : message.type === "assistant"
        ? `id=${message.message.id} ${JSON.stringify(message.message.usage).slice(0, 160)}`
        : "";
  process.stderr.write(`[claude-agent] ${message.type} ${detail ?? ""} ${usage}\n`);
}

export interface ProbeResult {
  version: string | undefined;
}

type Wake = () => void;

export class ClaudeProcess {
  /** Assigned by start() before any caller continues. */
  ready!: Promise<void>;
  session: Query;

  private readonly controller: ReadableStreamDefaultController<SDKUserMessage>;
  private readonly queue: SDKMessage[] = [];
  private waiters: Wake[] = [];
  private ended = false;
  private failure: unknown;

  private constructor(session: ClaudeProcess["session"], controller: ReadableStreamDefaultController<SDKUserMessage>) {
    this.session = session;
    this.controller = controller;
    void this.pump();
  }

  static async start(options: SdkOptions): Promise<ClaudeProcess> {
    const { query } = await load();
    let controller!: ReadableStreamDefaultController<SDKUserMessage>;
    const input = new ReadableStream<SDKUserMessage>({
      start(c) {
        controller = c;
      },
    });
    const session = query({ prompt: input, options });
    const process = new ClaudeProcess(session, controller);
    process.ready = (async () => {
      const init = await withTimeout(
        session.initializationResult(),
        INIT_TIMEOUT_MS,
        "claude did not start within 30 seconds",
      );
      const problem = versionError(init.claude_code_version);
      if (problem) throw problem;
      process.probe = { version: init.claude_code_version };
    })();
    process.ready.catch(() => {});
    return process;
  }

  probe: ProbeResult = { version: undefined };

  /** Single reader of the SDK iterator; buffers messages for phase waiters. */
  private async pump(): Promise<void> {
    try {
      for await (const message of this.session as unknown as AsyncIterable<SDKMessage>) {
        if (DEBUG) debugLog(message);
        this.queue.push(message);
        this.wake();
      }
    } catch (error) {
      this.failure = error;
    } finally {
      this.ended = true;
      this.wake();
    }
  }

  /** True when the CLI exited or the input stream closed. */
  get dead(): boolean {
    return this.ended;
  }

  get failureError(): unknown {
    return this.failure;
  }

  /** Throws when the process died without an explanation the caller can use. */
  stoppedError(): Error {
    const failure = this.failure;
    return failure instanceof Error ? failure : new Error(`Claude Code stopped: ${String(failure)}`);
  }

  enqueue(content: SDKUserMessage["message"]["content"]): void {
    this.requireLive();
    this.controller.enqueue({
      type: "user",
      uuid: crypto.randomUUID(),
      message: { role: "user", content } as SDKUserMessage["message"],
      parent_tool_use_id: null,
    });
  }

  /** Queued message delivered after in-flight turns, so parked results land first. */
  enqueueNext(content: SDKUserMessage["message"]["content"]): void {
    this.requireLive();
    this.controller.enqueue({
      type: "user",
      uuid: crypto.randomUUID(),
      priority: "next",
      message: { role: "user", content } as SDKUserMessage["message"],
      parent_tool_use_id: null,
    });
  }

  private requireLive(): void {
    if (this.ended || this.failure) throw this.failure ?? new Error("Claude session has stopped");
  }

  async interrupt(): Promise<void> {
    if (this.ended) return;
    try {
      await this.session.interrupt();
    } catch {
      // Interrupting a dead process is fine.
    }
  }

  async stop(): Promise<void> {
    await this.interrupt();
    try {
      this.controller.close();
    } catch {
      // Already closed.
    }
  }

  /** Wait for the system/init that confirms the MCP tool server connected. */
  private async checkInit(needsTools: boolean, serverName: string | undefined): Promise<void> {
    const deadline = Date.now() + INIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const message = this.queue.shift();
      if (!message) {
        if (this.ended) throw this.failure ?? new Error("Claude stopped before initializing");
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
          this.waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
        continue;
      }
      if (message.type === "system" && message.subtype === "init") {
        if (needsTools && serverName && !serverConnected(message as SDKSystemMessage, serverName)) {
          throw new Error(`The ${serverName} tool server did not connect to Claude Code`);
        }
        return;
      }
      // Anything before init is session metadata; drop it.
    }
    throw new Error("claude did not initialize within 30 seconds");
  }

  /**
   * Consume queued messages for one phase, forwarding every one to `emit`.
   * Ends at a `result` message (mode "result") or at the park boundary: a
   * message_stop right after an offered tool_use block (mode "tools").
   */
  async readPhase(options: {
    emit: (message: SDKMessage) => void;
    isOffered: (name: string) => boolean;
    first: boolean;
    needsTools: boolean;
    serverName: string | undefined;
  }): Promise<{ mode: "tools" | "result"; result?: SDKResultMessage; claudeSessionId?: string }> {
    if (options.first) await this.checkInit(options.needsTools, options.serverName);
    let calledTools = false;
    let sawMessageStop = false;
    let claudeSessionId: string | undefined;
    while (true) {
      const message = this.queue.shift();
      if (!message) {
        if (this.ended) {
          throw this.failure ?? new Error("Claude Code stopped before finishing its reply");
        }
        await new Promise<void>((resolve) => this.waiters.push(resolve));
        continue;
      }
      options.emit(message);
      if (message.type === "assistant") {
        const assistant = message as SDKAssistantMessage;
        claudeSessionId ??= assistant.session_id;
        if (assistant.parent_tool_use_id === null) {
          for (const block of assistant.message.content) {
            if (block.type === "tool_use" && options.isOffered(block.name)) calledTools = true;
          }
        }
      }
      if (
        message.type === "stream_event" &&
        message.parent_tool_use_id === null &&
        message.event.type === "message_stop"
      ) {
        sawMessageStop = true;
      }
      if (message.type === "result") {
        const result = message as SDKResultMessage;
        claudeSessionId ??= result.session_id;
        return { mode: "result", result, claudeSessionId };
      }
      if (calledTools && sawMessageStop) return { mode: "tools", claudeSessionId };
    }
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }
}

function serverConnected(init: SDKSystemMessage, name: string): boolean {
  const servers = (init.mcp_servers ?? []) as readonly McpServerStatus[];
  return servers.some((server) => server.name === name && server.status === "connected");
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}
