/**
 * The Claude provider's session handling.
 *
 * Pi's step model: one streamSimple call = one Pi step. Pi runs returned tool
 * calls itself and calls back with the results. Claude Code's turn model: the
 * child process runs until its answer is complete or a tool result is pending.
 *
 * A step ends early at the park boundary: Claude's message_stop right after
 * tool_use blocks for tools we offered. The parked handlers wait until the
 * next Pi step brings matching tool results; resolving them resumes the
 * in-flight Claude turn, and its finish lands in that next Pi stream.
 *
 * Anything else (edited history, tool-set change, dead process) restarts with
 * a fresh Claude session and a full-history checkpoint, so Pi's transcript
 * stays the source of truth.
 */
import {
  collapseSystemMessages,
  createAssistantMessageEventStream,
  getCurrentTools,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import { ClaudeProcess } from "./process.js";
import {
  catchUpBlocks,
  isOwnAssistant,
  toolResultPayload,
  userBlocks,
  type ClaudeBlock,
  type ToolPayload,
} from "./history.js";
import { makePending, type PendingTools } from "./tool-bridge.js";
import { baseOptions, processFingerprint, type LaunchRequest } from "./options.js";
import { StepConverter, type PhaseOutcome } from "./stream.js";
import { claudeInstructions } from "./system-prompt.js";

const IDLE_MS = 5 * 60_000;
const SIDE_KEY = "<side-call>";
const SERVER_NAME = "pi";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface StepRequest {
  /** Pi session id, when the call belongs to a session loop. */
  sessionId: string | undefined;
  model: Model<Api>;
  effort?: Effort;
  context: TranscriptContext;
  options?: SimpleStreamOptions;
  /** Pi's cwd, so Claude reads the same project. */
  cwd: string;
}

interface Entry {
  process?: ClaudeProcess;
  pending: PendingTools;
  fingerprint?: string;
  modelId?: string;
  effort?: Effort;
  /** True while Claude's turn waits for Pi's tool results. */
  parked: boolean;
  record: SyncRecord;
  /** Tool names this entry's process was launched with, fully prefixed. */
  offeredToolNames: Set<string>;
  /** A freshly started process still owes its system/init check. */
  awaitingInit: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
  /** Serializes steps on the same session. */
  turn: Promise<unknown>;
  throwaway: boolean;
}

interface SyncRecord {
  /** Position in context.messages consumed by earlier turns. */
  sentIndex: number;
  /** prefixHash() of messages[0, sentIndex) at the time they were sent. */
  prefixHash?: string;
  /** Tags of the assistant message we produced in the previous step. */
  lastReply?: string[];
  /** Claude's own session id, once the CLI reports one. */
  claudeSessionId?: string;
}

export interface Registry {
  /** Runs one Pi step; the returned stream is the result. */
  run: (request: StepRequest) => AssistantMessageEventStream;
  /** Stop every process; called from session_shutdown. */
  close: () => void;
}

export function makeRegistry(): Registry {
  const entries = new Map<string, Entry>();

  function entryFor(key: string, throwaway: boolean): Entry {
    let entry = entries.get(key);
    if (!entry) {
      entry = {
        pending: makePending(),
        parked: false,
        record: { sentIndex: 0 },
        offeredToolNames: new Set(),
        awaitingInit: false,
        turn: Promise.resolve(),
        throwaway,
      };
      entries.set(key, entry);
    }
    return entry;
  }

  async function stop(entry: Entry): Promise<void> {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
    entry.parked = false;
    const process = entry.process;
    entry.process = undefined;
    entry.fingerprint = undefined;
    if (!process) return;
    entry.pending.clear();
    await process.stop();
  }

  function release(entry: Entry): void {
    if (entry.throwaway) {
      void stop(entry);
      return;
    }
    // A turn parked for Pi tool results must not idle out: the next step can
    // take arbitrarily long (subagents, permission prompts).
    if (entry.parked) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = undefined;
      void stop(entry);
    }, IDLE_MS);
    entry.idleTimer.unref?.();
  }

  return {
    run(request) {
      const stream = createAssistantMessageEventStream();
      // Pi's compaction and branch summaries reuse the session id but ask for
      // no cache retention; they are one-off side calls, not chat turns.
      const side = request.sessionId === undefined || request.options?.cacheRetention === "none";
      const entry = entryFor(side ? SIDE_KEY : request.sessionId!, side);
      const previous = entry.turn.then(
        () => undefined,
        () => undefined,
      );
      const turn = (async () => {
        await previous;
        try {
          await runStep(stream, entry, request);
          release(entry);
        } catch (error) {
          await stop(entry);
          reportSetupFailure(stream, request, error);
        }
      })();
      entry.turn = turn;
      return stream;
    },
    close() {
      for (const [, entry] of [...entries]) void stop(entry);
      entries.clear();
    },
  };
}

/** Request-setup failure or unexpected crash: report a closed stream cleanly. */
function reportSetupFailure(stream: AssistantMessageEventStream, request: StepRequest, error: unknown): void {
  const aborted = request.options?.signal?.aborted === true;
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: request.model.api,
    provider: request.model.provider,
    model: request.model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: aborted ? "aborted" : "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
  stream.push({ type: "error", reason: aborted ? "aborted" : "error", error: message });
  stream.end();
}

// ------------------------------------------------------------------ planning

interface PhaseSlice {
  /** Tool results the parked handlers are waiting for, by Claude's tool_use id. */
  resolveIds: Map<string, ToolPayload>;
  /** Where the transcript was consumed up to after this step's delivery. */
  endIndex: number;
  /** Extra user content queued behind the parked continuation (usually none). */
  extraBlocks: ClaudeBlock[];
  /** Re-send everything into a brand-new session. */
  freshCheckpoint: boolean;
  /** Plain-flow user content for a fresh turn (no parking involved). */
  turnBlocks: ClaudeBlock[];
}

/**
 * Work out what this step delivers, in transcript order.
 *
 * Claude has consumed messages[0, sentIndex) (fingerprinted) plus our own
 * last reply at sentIndex. Happy paths then continue with tool results (a
 * parked turn) or with user messages (a new turn). Anything else, such as an
 * edited prefix, another model's reply, or a shorter history after
 * compaction or tree navigation, means Pi's history changed: rebuild a fresh
 * Claude session with a catch-up checkpoint. Mid-transcript system messages
 * are neutral; the prompt and tools come from them, not turn content.
 */
function classify(entry: Entry, messages: readonly Message[]): PhaseSlice {
  const slice: PhaseSlice = {
    resolveIds: new Map(),
    endIndex: entry.record.sentIndex,
    extraBlocks: [],
    freshCheckpoint: false,
    turnBlocks: [],
  };
  const rebuild = (): PhaseSlice => ({
    resolveIds: new Map(),
    extraBlocks: [],
    freshCheckpoint: true,
    turnBlocks: catchUpBlocks(messages),
    endIndex: messages.length,
  });

  // A session Claude has not seen yet: catch up on everything at once.
  if (entry.record.sentIndex === 0 && entry.record.lastReply === undefined) {
    return { ...rebuild(), freshCheckpoint: false };
  }
  if (
    entry.record.sentIndex > messages.length ||
    prefixHash(messages, entry.record.sentIndex) !== entry.record.prefixHash
  ) {
    return rebuild();
  }

  let index = entry.record.sentIndex;
  // Our previous reply is already in Claude's transcript; skip its echo.
  if (isOwnAssistant(messages[index], entry.record.lastReply)) index += 1;
  else if (entry.record.lastReply !== undefined && messages[index] !== undefined) return rebuild();

  if (entry.parked) {
    while (messages[index]?.role === "toolResult") {
      const result = messages[index] as Extract<Message, { role: "toolResult" }>;
      slice.resolveIds.set(result.toolCallId, toolResultPayload(result));
      index += 1;
    }
    while (messages[index]?.role === "user") {
      slice.extraBlocks.push(...userBlocks(messages[index] as Extract<Message, { role: "user" }>));
      index += 1;
    }
    // Parked but nothing matched (results missing, user aborted the tools).
    if (slice.resolveIds.size === 0 || index < messages.length) return rebuild();
    slice.endIndex = index;
    return slice;
  }

  // A regular turn carries only user messages.
  for (; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role === "system") continue;
    if (message.role !== "user") return rebuild();
    slice.turnBlocks.push(...userBlocks(message));
  }
  slice.endIndex = index;
  return slice;
}

/** Fingerprint of the visible history Claude has consumed. */
function prefixHash(messages: readonly Message[], end: number): string {
  const visible = messages.slice(0, end).filter((message) => message.role !== "system");
  return createHash("sha256")
    .update(JSON.stringify(visible.map((message) => [message.role, message.content])))
    .digest("hex");
}

// -------------------------------------------------------------------- running

/** One Pi step: prepare the process, deliver the payload, stream the answer. */
async function runStep(stream: AssistantMessageEventStream, entry: Entry, request: StepRequest): Promise<void> {
  const transcript = collapseSystemMessages(request.context);
  const systemPrompt = claudeInstructions(transcript.messages);
  const tools = getCurrentTools(transcript.messages);
  const effort = request.effort;
  const signal = request.options?.signal;
  const output = blankAssistant(request);
  const converter = new StepConverter(stream, output, toolPrefixSet(tools.map((tool) => tool.name)));

  const launch: LaunchRequest = {
    model: request.model.id,
    effort,
    systemPrompt,
    tools,
    persist: !entry.throwaway,
    cwd: request.cwd,
  };

  // Restart decisions come first, so classification sees the record the
  // process will actually continue from.
  if (!entry.process || entry.process.dead || entry.fingerprint !== processFingerprint(launch)) {
    // New, dead, or launched with another system prompt or tool set.
    await stopInternal(entry);
    entry.record = { sentIndex: 0 };
  }

  const seen = classify(entry, transcript.messages);
  if (process.env["LAMBDA_CLAUDE_AGENT_DEBUG"] === "1") {
    process.stderr.write(
      `[claude-agent] step session=${request.sessionId ?? "-"} throwaway=${entry.throwaway} parked=${entry.parked} ` +
        `messages=${transcript.messages.length} sent=${entry.record.sentIndex} resolve=${seen.resolveIds.size} ` +
        `turn=${seen.turnBlocks.length} fresh=${seen.freshCheckpoint} live=${!!entry.process && !entry.process.dead}\n`,
    );
  }
  if (seen.freshCheckpoint) {
    // History diverged under a live process: its transcript is stale.
    await stopInternal(entry);
    entry.record = { sentIndex: 0 };
  }

  if (!entry.process) {
    await startProcess(entry, launch);
  } else {
    // Model and effort can change on the running process.
    if (entry.modelId !== request.model.id) {
      await entry.process.session.setModel(request.model.id);
      entry.modelId = request.model.id;
    }
    if (entry.effort !== effort) {
      await entry.process.session.applyFlagSettings({ effortLevel: effort ?? null });
      entry.effort = effort;
    }
  }

  await entry.process!.ready; // includes the version check
  if (signal?.aborted) {
    converter.finishResult(undefined, true, true);
    return;
  }

  // Delivery: either resume the parked turn with tool results, or open a turn.
  if (seen.resolveIds.size > 0) {
    entry.pending.resolve(seen.resolveIds);
    entry.parked = false;
    if (seen.extraBlocks.length > 0) entry.process!.enqueueNext(seen.extraBlocks);
    entry.record.sentIndex = seen.endIndex;
    entry.record.prefixHash = prefixHash(transcript.messages, seen.endIndex);
  } else if (seen.turnBlocks.length === 0) {
    // Nothing new to deliver; keep the stream well-formed anyway.
    converter.finishResult(undefined, false, false);
    return;
  } else {
    entry.process!.enqueue(seen.turnBlocks);
    entry.record.sentIndex = seen.endIndex;
    entry.record.prefixHash = prefixHash(transcript.messages, seen.endIndex);
    entry.record.lastReply = undefined;
  }

  const firstPhase = entry.awaitingInit;
  entry.awaitingInit = false;
  const onAbort = () => {
    void entry.process?.interrupt();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const outcome = await phaseLoop(entry, converter, {
      firstPhase,
      needsTools: tools.length > 0,
      signal,
    });
    if (outcome.mode === "tools") {
      entry.parked = true;
      entry.record.lastReply = converter.replyTags();
      converter.finishTools();
      return;
    }
    entry.record.claudeSessionId ??= outcome.sessionId;
    entry.record.lastReply = converter.replyTags();
    converter.finishResult(outcome.result, outcome.aborted, signal?.aborted === true);
    if (output.stopReason === "error" || output.stopReason === "aborted") {
      // Pi has no per-provider retry switch: it retries by error text and
      // resends the same transcript. Claude Code already retried, and its
      // transcript holds the failed or interrupted turn (possibly still
      // parked on a tool call), so the next step rebuilds from Pi's history.
      await stopInternal(entry);
      entry.record = { sentIndex: 0 };
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

interface PhaseLoopOptions {
  firstPhase: boolean;
  needsTools: boolean;
  signal: AbortSignal | undefined;
}

/**
 * Consume the queued messages until the park boundary or the turn's result.
 * An abort interrupts the turn (see runStep); the CLI then ends it with an
 * `error_during_execution` result, which is the real final state, so partial
 * content streamed so far is kept and reported as aborted.
 */
async function phaseLoop(entry: Entry, converter: StepConverter, options: PhaseLoopOptions): Promise<PhaseOutcome> {
  const toolNames = () => entry.offeredToolNames;
  const outcome = await entry.process!.readPhase({
    emit: (message) => {
      if (message.type === "assistant" && message.parent_tool_use_id === null && !message.error) {
        for (const block of message.message.content) {
          if (block.type === "tool_use" && toolNames().has(block.name)) entry.pending.announce(block.id, block.name);
        }
      }
      converter.handle(message);
    },
    isOffered: (name) => toolNames().has(name),
    first: options.firstPhase,
    needsTools: options.needsTools,
    serverName: options.needsTools ? SERVER_NAME : undefined,
  });
  const aborted = options.signal?.aborted === true;
  if (outcome.mode === "tools" && !aborted)
    return { mode: "tools", sessionId: outcome.claudeSessionId, aborted: false };
  return { mode: "result", result: outcome.result, sessionId: outcome.claudeSessionId, aborted };
}

async function stopInternal(entry: Entry): Promise<void> {
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }
  entry.parked = false;
  const process = entry.process;
  entry.process = undefined;
  entry.fingerprint = undefined;
  if (!process) return;
  entry.pending.clear();
  await process.stop();
}

async function startProcess(entry: Entry, request: LaunchRequest): Promise<void> {
  const executable = resolveExecutable();
  const process = await ClaudeProcess.start(baseOptions(request, executable, entry.pending));
  entry.process = process;
  entry.fingerprint = processFingerprint(request);
  entry.modelId = request.model;
  entry.effort = request.effort;
  entry.offeredToolNames = toolPrefixSet(request.tools.map((tool) => tool.name));
  entry.awaitingInit = true;
  entry.record.claudeSessionId = undefined;
}

function resolveExecutable(): string {
  const override = process.env["LAMBDA_CLAUDE_PATH"];
  if (override) return override;
  const found = whichClaude();
  if (!found) throw new Error("Install Claude Code and sign in first: `claude auth login`.");
  return found;
}

/** Minimal PATH walk; avoids depending on the `which` package. */
function whichClaude(): string | undefined {
  const pathValue = process.env["PATH"] ?? "";
  for (const dir of pathValue.split(":")) {
    if (!dir) continue;
    const candidate = `${dir}/claude`;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { accessSync, constants } = require("node:fs") as typeof import("node:fs");
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

function blankAssistant(request: StepRequest): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: request.model.api,
    provider: request.model.provider,
    model: request.model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "pending",
    thinkingLevel: request.options?.reasoning,
    timestamp: Date.now(),
  };
}

function toolPrefixSet(names: readonly string[]): Set<string> {
  return new Set(names.map((name) => `mcp__${SERVER_NAME}__${name}`));
}
