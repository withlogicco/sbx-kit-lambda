import { execFile } from "node:child_process";
import { mkdir, open, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * Session status reporting for the local dashboard.
 *
 * Each Pi session appends to `<main checkout>/.lambda/sessions/<session-id>.jsonl`.
 * Every agent report includes required `worktree` metadata relative to that
 * checkout (`.` means main). The dashboard uses the latest explicitly reported
 * worktree, defaulting to main; entries that omit it (the hooks) do not reset
 * the association. The file layout, entry format, and state names are a contract shared with
 * the dashboard, which lives in another repo: coordinate changes with it.
 * The last valid line is the session's current state; the file is append-only.
 *
 * A "turn" here is one Pi agent run (one prompt, or one rate-limit resume),
 * not Pi's per-model-request `turn_start`/`turn_end`:
 * - turn start: the first `agent_start` of a run. `agent_start` repeats inside
 *   a run on auto-retry and compaction continuations, so only the first counts.
 *   `before_agent_start` supplies the prompt, but it fires only for user
 *   prompts, not for the rate-limit handler's resume message.
 * - turn end: `agent_settled`, which fires once per run after every retry,
 *   compaction, and queued continuation. `agent_end` fires per inner loop and
 *   only records the error that the final one ended on.
 */

export const SESSIONS_DIR = ".lambda/sessions";
const EXCLUDE_PATTERN = ".lambda/";
const MAX_SUMMARY_LENGTH = 100;
const MAX_ERROR_LENGTH = 4000;

export const agentStates = ["in_progress", "needs_input", "needs_review"] as const;
export type AgentState = (typeof agentStates)[number];
export type State = AgentState | "warning";

export interface Entry {
  v: 1;
  ts: string;
  state: State;
  summary: string;
  body: string;
  worktree?: string;
}

// Parameter-specific reporting guidance belongs here, not in project instructions.
const TOOL_DESCRIPTION = `Report your status to the user's dashboard. You MUST call this as your LAST tool call before ending EVERY response to the user, including questions, explanations, plans, reviews, and code changes, even when no files were changed. Never finish a response without reporting. Use needs_input or needs_review at the end (in_progress only if you are genuinely continuing).

You MAY also call this mid-turn, but only for important progress during a long stretch of work where the turn's end is far off. Keep mid-turn entries minimal; do not report routine steps.

Choose state by what the user must do next:
- needs_input: you cannot continue without the user. Use it for open questions or a choice between approaches. Stop working after reporting.
- needs_review: you believe the task is complete and the user should review it.
- in_progress: you are continuing on your own; nothing is needed from the user.

summary: one line, max 100 characters, saying what the user needs to know at a glance ("Choose between Redis and in-process cache", "Import job refactor ready for review").

body: markdown for a user switching in from other work with no context. Be specific and brief.
- First report of the session: start with "## Task" and the original task as given.
- needs_input: number every question. For a choice, label options A, B, ... with one line of trade-offs each and state your recommendation.
- needs_review: what changed, how you verified it (tests run, results), what to look at first, and known gaps.
- in_progress: what you did this turn and what you will do next.

worktree: required: the Git worktree you are working in, relative to the main checkout (e.g. ".worktrees/fix-import", or "." for the main checkout). Include it on every report.

Do not paste diffs or long logs; reference file paths instead. Never claim a PR is merged.`;

/** ISO 8601 local time with a numeric offset, e.g. `2026-10-08T10:56:28+03:00`. */
export function formatTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** Length in characters (code points), so an emoji counts once. */
function charLength(text: string): number {
  return [...text].length;
}

/** Collapse text onto one line and cut it to the summary limit. */
export function toSummary(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  const chars = [...line];
  if (chars.length <= MAX_SUMMARY_LENGTH) return line;
  return `${chars.slice(0, MAX_SUMMARY_LENGTH - 1).join("").trimEnd()}…`;
}

export function createEntry(state: State, summary: string, body: string, now = new Date()): Entry {
  return { v: 1, ts: formatTimestamp(now), state, summary, body };
}

/** One complete JSONL line. JSON.stringify escapes every newline inside values. */
export function serializeEntry(entry: Entry): string {
  return `${JSON.stringify({ v: entry.v, ts: entry.ts, state: entry.state, summary: entry.summary, body: entry.body, worktree: entry.worktree })}\n`;
}

export type Validation =
  | { ok: true; state: AgentState; summary: string; body: string; worktree?: string }
  | { ok: false; error: string };

/** Validate agent input. `warning` is rejected: only the turn-end hook writes it. */
export function validateReport(input: { state?: unknown; summary?: unknown; body?: unknown; worktree?: unknown }): Validation {
  const { state, summary, body, worktree } = input;
  if (typeof state !== "string" || !(agentStates as readonly string[]).includes(state)) {
    return {
      ok: false,
      error: `Invalid state ${JSON.stringify(state)}. Use one of: ${agentStates.join(", ")}.`,
    };
  }
  if (typeof summary !== "string" || summary.trim().length === 0) {
    return { ok: false, error: "summary is empty. Give one line saying what the user needs to know." };
  }
  const trimmed = summary.trim();
  if (/[\r\n]/.test(trimmed)) {
    return { ok: false, error: "summary must be a single line. Move details into body." };
  }
  const length = charLength(trimmed);
  if (length > MAX_SUMMARY_LENGTH) {
    return {
      ok: false,
      error: `summary is ${length} characters; the limit is ${MAX_SUMMARY_LENGTH}. Shorten it and move details into body.`,
    };
  }
  if (typeof body !== "string" || body.trim().length === 0) {
    return { ok: false, error: "body is empty. Give markdown context for a user switching in from other work." };
  }
  if (typeof worktree !== "string" || !worktree.trim() || /[\r\n\0]/.test(worktree) || isAbsolute(worktree)) {
    return { ok: false, error: "worktree is required: use . for the main checkout or a path relative to it." };
  }
  return { ok: true, state: state as AgentState, summary: trimmed, body, worktree };
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile("git", ["-C", cwd, ...args], { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolvePromise(stdout.trim());
    });
  });
}

export async function worktreeRoot(cwd: string): Promise<string> {
  try {
    return await git(cwd, ["rev-parse", "--show-toplevel"]);
  } catch (error) {
    throw new Error(
      `Cannot report status: ${cwd} is not inside a git worktree (${(error as Error).message}).`,
    );
  }
}

/** Git lists the main checkout first, even when queried from a linked worktree. */
async function registeredWorktrees(cwd: string): Promise<string[]> {
  const listing = await git(cwd, ["worktree", "list", "--porcelain", "-z"]);
  const records = listing.split("\0\0").filter(Boolean).map((record) => record.split("\0"));
  if (records[0]?.includes("bare")) {
    throw new Error("Cannot report status: this repository has no main checkout (its primary repository is bare).");
  }
  const roots = records.map((fields) => fields.find((field) => field.startsWith("worktree "))!.slice(9));
  // With --separate-git-dir Git can list the metadata directory as main. If
  // querying main itself, its actual root is authoritative, not that path.
  const [gitDir, commonDir] = (await git(cwd, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"])).split("\n");
  if (gitDir === commonDir) roots[0] = await worktreeRoot(cwd);
  return roots;
}

/** Resolve storage independently of Pi's launch cwd or any reported worktree. */
export async function repositoryRoot(cwd: string): Promise<string> {
  await worktreeRoot(cwd);
  const [root] = await registeredWorktrees(cwd);
  if (!root) throw new Error("Cannot report status: Git did not list a main checkout.");
  // Do not recreate a missing/unmounted main checkout under a stale Git path.
  try {
    await worktreeRoot(root);
  } catch (error) {
    throw new Error(`Cannot report status: main checkout ${JSON.stringify(root)} is unavailable (${(error as Error).message}).`);
  }
  return root;
}

/** Validate a registered worktree root, then serialize a portable relative path. */
export async function normalizeWorktree(root: string, path: string): Promise<string> {
  let candidate: string;
  try {
    candidate = await realpath(resolve(root, path));
  } catch {
    throw new Error(`Cannot report status: worktree ${JSON.stringify(path)} is not accessible.`);
  }
  for (const registered of await registeredWorktrees(root)) {
    let canonical: string;
    try {
      canonical = await realpath(registered);
    } catch {
      continue;
    }
    if (canonical === candidate) return relative(root, registered).split(sep).join("/") || ".";
  }
  throw new Error(`Cannot report status: worktree ${JSON.stringify(path)} is not a registered worktree root of this repository.`);
}

/**
 * The exclude file shared by every worktree of the repository. `--git-path`
 * resolves to the common git dir from linked worktrees; its output may be
 * relative to `cwd`.
 */
export async function excludePath(cwd: string): Promise<string> {
  return resolve(cwd, await git(cwd, ["rev-parse", "--git-path", "info/exclude"]));
}

/** Add `.lambda/` unless present; concurrent duplicate exclusions are harmless. */
export async function ensureExcluded(path: string): Promise<boolean> {
  let content = "";
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (content.split(/\r?\n/).some((line) => line.trim() === EXCLUDE_PATTERN)) return false;
  await mkdir(dirname(path), { recursive: true });
  await appendLine(path, `${EXCLUDE_PATTERN}\n`);
  return true;
}

/** Preserve history and append one complete line, isolating any interrupted tail. */
async function appendLine(path: string, text: string): Promise<void> {
  const handle = await open(path, "a+", 0o644);
  try {
    const { size } = await handle.stat();
    let separator = "";
    if (size > 0) {
      const tail = Buffer.alloc(1);
      const { bytesRead } = await handle.read(tail, 0, 1, size - 1);
      if (bytesRead !== 1) throw new Error(`Cannot read final byte of ${path}`);
      if (tail[0] !== 0x0a) separator = "\n";
    }
    // Keep the damaged tail untouched; its boundary and the new line land in one append.
    const buffer = Buffer.from(`${separator}${text}`, "utf8");
    const { bytesWritten } = await handle.write(buffer, 0, buffer.length);
    if (bytesWritten !== buffer.length) throw new Error(`Short write to ${path}`);
  } finally {
    await handle.close();
  }
}

export interface Target {
  root: string;
  file: string;
  relative: string;
}

/** Resolve the session file and prepare `.lambda/sessions/` and the exclude entry. */
export async function prepareTarget(cwd: string, sessionId: string, worktree?: string): Promise<Target & { worktree?: string }> {
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId) || sessionId.startsWith(".")) {
    throw new Error(`Cannot report status: session id ${JSON.stringify(sessionId)} is not a safe file name.`);
  }
  const root = await repositoryRoot(cwd);
  // Validate metadata before any writes, including the exclude entry.
  const normalized = worktree === undefined ? undefined : await normalizeWorktree(root, worktree);
  const relative = `${SESSIONS_DIR}/${sessionId}.jsonl`;
  // Exclude before creating anything, so .lambda/ never shows as untracked.
  await ensureExcluded(await excludePath(root));
  await mkdir(join(root, SESSIONS_DIR), { recursive: true });
  return { root, file: join(root, relative), relative, ...(normalized === undefined ? {} : { worktree: normalized }) };
}

export async function appendEntry(target: Target, entry: Entry): Promise<void> {
  await appendLine(target.file, serializeEntry(entry));
}

/** Whether the session has written nothing yet. Checks size only; entries are never read. */
async function isFirstEntry(target: Target): Promise<boolean> {
  try {
    return (await stat(target.file)).size === 0;
  } catch {
    return true;
  }
}

/** Minimal slice of an agent message needed to tell how a run ended. */
interface EndMessage {
  role: string;
  stopReason?: string;
  errorMessage?: string;
  content?: unknown;
}

/** The error the final assistant message of a run ended on, if any. */
export function runError(messages: readonly EndMessage[]): string | undefined {
  const last = [...messages].reverse().find((message) => message.role === "assistant");
  if (!last) return undefined;
  if (last.stopReason === "length") return "The model hit its output token limit.";
  if (last.stopReason !== "error") return undefined;
  const parts: string[] = [];
  if (last.errorMessage) parts.push(last.errorMessage);
  if (Array.isArray(last.content)) {
    for (const block of last.content) {
      const text = (block as { type?: string; text?: unknown } | null)?.type === "text"
        ? (block as { text?: unknown }).text
        : undefined;
      if (typeof text === "string" && text.trim()) parts.push(text);
    }
  }
  return parts.join("\n").trim() || "The model request failed without an error message.";
}

/**
 * The turn-end entry, or null when none is due. The contract defines warning
 * as a turn that ended without a needs_input/needs_review declaration, or on
 * an error, so an error warns even after a declaration.
 */
export function turnEndEntry(
  lastAgentState: AgentState | undefined,
  error: string | undefined,
  aborted: boolean,
  now = new Date(),
): Entry | null {
  if (error !== undefined) {
    const reason = error.length > MAX_ERROR_LENGTH ? `${error.slice(0, MAX_ERROR_LENGTH)}…` : error;
    return createEntry(
      "warning",
      toSummary(`Turn ended on an error: ${reason}`),
      `The turn ended on an error.\n\n## Reason\n\n\`\`\`\n${reason}\n\`\`\``,
      now,
    );
  }
  if (lastAgentState === "needs_input" || lastAgentState === "needs_review") return null;
  if (aborted) {
    return createEntry(
      "warning",
      "Turn aborted without a status report",
      "The turn was aborted before a status report was made.",
      now,
    );
  }
  return createEntry("warning", "Turn ended without a status report", "The turn ended without a status report.", now);
}

/** The turn-start entry: the task on a session's first turn, minimal afterwards. */
export function turnStartEntry(first: boolean, prompt: string | undefined, now = new Date()): Entry {
  if (!first) return createEntry("in_progress", "Resumed, working", "Resumed, working.", now);
  const task = prompt?.trim();
  if (!task) return createEntry("in_progress", "Started, working", "## Task\n\n(started without a prompt)", now);
  return createEntry("in_progress", toSummary(task), `## Task\n\n${task}`, now);
}

export interface SessionDisplay {
  worktree: string;
  state?: State;
  summary?: string;
}

/** Hooks change state, but must not replace the last report's title/association. */
export function updateDisplay(display: SessionDisplay, entry: Entry): SessionDisplay {
  return {
    worktree: entry.worktree ?? display.worktree,
    state: entry.state,
    summary: entry.worktree !== undefined || !display.summary ? entry.summary : display.summary,
  };
}

/** Read-only reconstruction; ignore corrupt records and an interrupted final append. */
export function parseDisplay(text: string): SessionDisplay {
  let display: SessionDisplay = { worktree: "." };
  for (const line of text.split("\n").slice(0, -1)) {
    try {
      const entry = JSON.parse(line);
      if (!entry || entry.v !== 1 || typeof entry.ts !== "string" ||
        ![...agentStates, "warning"].includes(entry.state) ||
        typeof entry.summary !== "string" || !entry.summary.trim() || typeof entry.body !== "string" ||
        (entry.worktree !== undefined && (typeof entry.worktree !== "string" || !entry.worktree.trim()))) continue;
      display = updateDisplay(display, entry);
    } catch {
      // Bad lines must not hide the valid history before or after them.
    }
  }
  return display;
}

/** Status text is plain: do not let stored summaries inject terminal controls. */
function displayText(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
}

function renderDisplay(ctx: ExtensionContext, display: SessionDisplay): void {
  if (ctx.mode !== "tui") return;
  const theme = ctx.ui.theme;
  const worktree = theme.bold(displayText(display.worktree));
  const state = display.state === "needs_input" || display.state === "needs_review"
    ? theme.fg("success", display.state)
    : display.state === "warning"
      ? theme.fg("warning", display.state)
      : display.state;
  const summary = display.summary ? displayText(toSummary(display.summary)) : undefined;
  ctx.ui.setStatus("lambda-session", [worktree, state, summary].filter(Boolean).join(" · "));
}

const parameters = Type.Object({
  state: StringEnum(agentStates, { description: "What the user must do next" }),
  summary: Type.String({ description: "One line, max 100 characters" }),
  body: Type.String({ description: "Markdown for a user switching in with no context" }),
  worktree: Type.String({ description: "Required Git worktree path relative to the main checkout; . selects the main checkout" }),
});

export default function configureSessionStatus(pi: ExtensionAPI): void {
  // Serialize every append so hook and tool entries land in call order.
  let writes: Promise<unknown> = Promise.resolve();
  function enqueue<T>(action: () => Promise<T>): Promise<T> {
    const result = writes.then(action);
    writes = result.catch(() => undefined);
    return result;
  }

  let display: SessionDisplay = { worktree: "." };
  pi.on("session_start", async (_event, ctx) => {
    await enqueue(async () => {
      display = { worktree: "." };
      try {
        const root = await repositoryRoot(ctx.cwd);
        display = parseDisplay(await readFile(join(root, SESSIONS_DIR, `${ctx.sessionManager.getSessionId()}.jsonl`), "utf8"));
      } catch {
        // New sessions, unavailable main checkouts and non-git launches have no history.
      }
      renderDisplay(ctx, display);
    });
  });

  let pendingPrompt: string | undefined;
  let run: { cwd: string; sessionId: string; lastAgentState?: AgentState; error?: string } | undefined;

  /** Hooks must never break a turn: a non-git cwd simply means no dashboard. */
  async function hookWrite(cwd: string, sessionId: string, ctx: ExtensionContext, build: (target: Target) => Promise<Entry | null>) {
    await enqueue(async () => {
      try {
        const target = await prepareTarget(cwd, sessionId);
        const entry = await build(target);
        if (entry) {
          await appendEntry(target, entry);
          display = updateDisplay(display, entry);
          renderDisplay(ctx, display);
        }
      } catch {
        // Outside a git worktree, or the worktree is not writable.
      }
    });
  }

  pi.on("before_agent_start", (event) => {
    pendingPrompt = event.prompt;
  });

  pi.on("agent_start", async (_event, ctx: ExtensionContext) => {
    if (run) return;
    const prompt = pendingPrompt;
    pendingPrompt = undefined;
    run = { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() };
    await hookWrite(run.cwd, run.sessionId, ctx, async (target) => turnStartEntry(await isFirstEntry(target), prompt));
  });

  pi.on("agent_end", (event) => {
    // Retries and continuations end inner loops too; the last one decides.
    if (run) run.error = runError(event.messages as EndMessage[]);
  });

  pi.on("agent_settled", async (event, ctx) => {
    const ended = run;
    run = undefined;
    if (!ended) return;
    const entry = turnEndEntry(ended.lastAgentState, ended.error, event.aborted);
    if (entry) await hookWrite(ended.cwd, ended.sessionId, ctx, async () => entry);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    // Process exit leaves in_progress intact; the dashboard derives stale.
    run = undefined;
    pendingPrompt = undefined;
    display = { worktree: "." };
    if (ctx.mode === "tui") ctx.ui.setStatus("lambda-session", undefined);
  });

  pi.registerTool({
    name: "report_status",
    label: "Report Status",
    description: TOOL_DESCRIPTION,
    promptGuidelines: [
      "End every turn by calling report_status with needs_input or needs_review (or in_progress only if you are genuinely continuing).",
    ],
    parameters,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const report = validateReport(params);
      if (!report.ok) throw new Error(report.error);
      const sessionId = ctx.sessionManager.getSessionId();
      const target = await enqueue(async () => {
        const prepared = await prepareTarget(ctx.cwd, sessionId, report.worktree);
        const entry = createEntry(report.state, report.summary, report.body);
        if (prepared.worktree !== undefined) entry.worktree = prepared.worktree;
        await appendEntry(prepared, entry);
        display = updateDisplay(display, entry);
        renderDisplay(ctx, display);
        return prepared;
      });
      if (run) run.lastAgentState = report.state;
      return {
        content: [{ type: "text", text: `Reported ${report.state} to ${target.relative}` }],
        details: { state: report.state, file: target.file, ...(target.worktree === undefined ? {} : { worktree: target.worktree }) },
      };
    },
  });
}
