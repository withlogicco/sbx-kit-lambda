// Fixed zone so timestamps are deterministic; set before any Date is used.
process.env.TZ = "Europe/Athens";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import configureSessionStatus, {
  ensureExcluded,
  formatTimestamp,
  runError,
  serializeEntry,
  toSummary,
  turnEndEntry,
  turnStartEntry,
  validateReport,
  createEntry,
} from "../files/home/.pi/agent/extensions/session-status.ts";

const scratch: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "session-status-"));
  scratch.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    encoding: "utf8",
  }).trim();
}

async function repo(): Promise<string> {
  const dir = await tempDir();
  git(dir, "init", "-q", "-b", "main");
  await writeFile(join(dir, "README.md"), "x\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

async function lines(file: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(file, "utf8");
  assert.ok(text.endsWith("\n"), "file is newline-terminated");
  return text.slice(0, -1).split("\n").map((line) => JSON.parse(line));
}

async function excludeCount(cwd: string): Promise<number> {
  const path = resolve(cwd, git(cwd, "rev-parse", "--git-path", "info/exclude"));
  return (await readFile(path, "utf8")).split("\n").filter((line) => line === ".lambda/").length;
}

after(async () => {
  await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("serialization", () => {
  it("formats local time with the offset", () => {
    assert.equal(formatTimestamp(new Date("2026-10-08T07:56:28Z")), "2026-10-08T10:56:28+03:00");
    assert.equal(formatTimestamp(new Date("2026-01-08T07:56:28Z")), "2026-01-08T09:56:28+02:00");
  });

  it("serializes one newline-terminated line in contract key order", () => {
    const entry = createEntry("needs_input", "Pick caching strategy", "Two options...\n\n1. A", new Date("2026-10-08T07:56:28Z"));
    const line = serializeEntry(entry);
    assert.equal(
      line,
      '{"v":1,"ts":"2026-10-08T10:56:28+03:00","state":"needs_input","summary":"Pick caching strategy","body":"Two options...\\n\\n1. A"}\n',
    );
    assert.equal(line.indexOf("\n"), line.length - 1);
    assert.deepEqual(JSON.parse(line), entry);
  });

  it("collapses and truncates prompts into a summary", () => {
    assert.equal(toSummary("  Fix the\n\nimport   job "), "Fix the import job");
    const long = toSummary("a".repeat(150));
    assert.equal([...long].length, 100);
    assert.ok(long.endsWith("…"));
    assert.equal(toSummary("b".repeat(100)), "b".repeat(100));
  });
});

describe("validation", () => {
  const valid = { state: "needs_review", summary: "Ready", body: "Done." };

  it("accepts the agent states and trims the summary", () => {
    for (const state of ["in_progress", "needs_input", "needs_review"]) {
      assert.deepEqual(validateReport({ ...valid, state, summary: "  Ready  " }), {
        ok: true,
        state,
        summary: "Ready",
        body: "Done.",
      });
    }
  });

  it("rejects unknown states, including warning", () => {
    for (const state of ["warning", "done", "", undefined, 3]) {
      const result = validateReport({ ...valid, state });
      assert.equal(result.ok, false);
      assert.match((result as { error: string }).error, /Invalid state.*in_progress, needs_input, needs_review/);
    }
  });

  it("rejects empty, multi-line, and over-long summaries", () => {
    assert.match((validateReport({ ...valid, summary: "   " }) as { error: string }).error, /summary is empty/);
    assert.match((validateReport({ ...valid, summary: "a\nb" }) as { error: string }).error, /single line/);
    assert.match(
      (validateReport({ ...valid, summary: "x".repeat(101) }) as { error: string }).error,
      /101 characters; the limit is 100/,
    );
    assert.equal(validateReport({ ...valid, summary: "x".repeat(100) }).ok, true);
    assert.equal(validateReport({ ...valid, summary: "🙂".repeat(100) }).ok, true);
  });

  it("rejects an empty body", () => {
    assert.match((validateReport({ ...valid, body: " \n " }) as { error: string }).error, /body is empty/);
  });
});

describe("info/exclude", () => {
  it("creates the file and adds the pattern once", async () => {
    const path = join(await tempDir(), "info", "exclude");
    assert.equal(await ensureExcluded(path), true);
    assert.equal(await ensureExcluded(path), false);
    assert.equal(await readFile(path, "utf8"), ".lambda/\n");
  });

  it("keeps existing content and fixes a missing final newline", async () => {
    const path = join(await tempDir(), "exclude");
    await writeFile(path, "# comment\n*.log");
    await ensureExcluded(path);
    assert.equal(await readFile(path, "utf8"), "# comment\n*.log\n.lambda/\n");
  });

  it("recognizes an existing entry", async () => {
    const path = join(await tempDir(), "exclude");
    await writeFile(path, "*.log\n.lambda/\n");
    assert.equal(await ensureExcluded(path), false);
    assert.equal(await readFile(path, "utf8"), "*.log\n.lambda/\n");
  });
});

describe("turn entries", () => {
  it("states the task on the first turn and stays minimal afterwards", () => {
    const first = turnStartEntry(true, "Refactor the import job\n\nKeep the API stable.");
    assert.equal(first.state, "in_progress");
    assert.equal(first.summary, "Refactor the import job Keep the API stable.");
    assert.equal(first.body, "## Task\n\nRefactor the import job\n\nKeep the API stable.");
    const later = turnStartEntry(false, "anything");
    assert.deepEqual([later.state, later.summary], ["in_progress", "Resumed, working"]);
  });

  it("warns unless a terminal state was declared, and always on errors", () => {
    assert.equal(turnEndEntry("needs_review", undefined, false), null);
    assert.equal(turnEndEntry("needs_input", undefined, false), null);
    assert.equal(turnEndEntry("in_progress", undefined, false)?.body, "The turn ended without a status report.");
    assert.equal(turnEndEntry(undefined, undefined, false)?.state, "warning");
    assert.match(turnEndEntry(undefined, undefined, true)!.summary, /aborted/);
    const failed = turnEndEntry("needs_review", "boom", false)!;
    assert.equal(failed.state, "warning");
    assert.match(failed.body, /boom/);
  });

  it("extracts the error a run ended on", () => {
    assert.equal(runError([{ role: "assistant", stopReason: "stop" }]), undefined);
    assert.equal(runError([{ role: "assistant", stopReason: "aborted" }]), undefined);
    assert.match(runError([{ role: "assistant", stopReason: "length" }])!, /output token limit/);
    assert.equal(
      runError([
        { role: "assistant", stopReason: "error", errorMessage: "first" },
        { role: "assistant", stopReason: "error", errorMessage: "Codex error: The usage limit has been reached" },
      ]),
      "Codex error: The usage limit has been reached",
    );
  });
});

type Handler = (event: any, ctx: any) => unknown;

/** Loads the extension against a minimal stand-in for Pi's ExtensionAPI. */
function loadExtension() {
  const handlers = new Map<string, Handler[]>();
  let tool: any;
  configureSessionStatus({
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool(definition: unknown) {
      tool = definition;
    },
  } as any);
  return {
    async emit(name: string, event: Record<string, unknown>, ctx: unknown) {
      for (const handler of handlers.get(name) ?? []) await handler({ type: name, ...event }, ctx);
    },
    report(params: Record<string, unknown>, ctx: unknown) {
      return tool.execute("call", params, undefined, undefined, ctx);
    },
    tool: () => tool,
  };
}

function context(cwd: string, sessionId: string) {
  return { cwd, sessionManager: { getSessionId: () => sessionId } };
}

describe("extension", () => {
  let main: string;
  let linked: string;

  before(async () => {
    main = await repo();
    linked = join(await tempDir(), "linked");
    git(main, "worktree", "add", "-q", "-b", "feature", linked);
  });

  it("registers report_status with the contract description", () => {
    const tool = loadExtension().tool();
    assert.equal(tool.name, "report_status");
    assert.ok(tool.description.startsWith("Report your status to the user's dashboard. You MUST call this"));
    assert.ok(tool.description.endsWith("Never claim a PR is merged."));
  });

  for (const which of ["main checkout", "linked worktree"]) {
    it(`appends one line per call in a ${which} and keeps git status clean`, async () => {
      const cwd = which === "main checkout" ? main : linked;
      const ext = loadExtension();
      const ctx = context(cwd, `s-${which.replace(" ", "-")}`);
      const first = await ext.report({ state: "in_progress", summary: "Halfway", body: "## Task\n\nDo it" }, ctx);
      assert.equal(first.content[0].text, `Reported in_progress to .lambda/sessions/${ctx.sessionManager.getSessionId()}.jsonl`);
      await ext.report({ state: "needs_review", summary: "Done", body: "Look at a.ts" }, ctx);
      const entries = await lines(first.details.file);
      assert.deepEqual(entries.map((entry) => entry.state), ["in_progress", "needs_review"]);
      assert.equal(entries[1]!.v, 1);
      assert.equal(await excludeCount(cwd), 1);
      assert.equal(git(cwd, "status", "--porcelain"), "");
    });
  }

  it("excludes .lambda/ once across both worktrees of a repository", async () => {
    assert.equal(await excludeCount(main), 1);
    assert.equal(await excludeCount(linked), 1);
  });

  it("writes two sessions in one worktree to two files", async () => {
    const ext = loadExtension();
    const a = await ext.report({ state: "needs_input", summary: "Q", body: "1. ?" }, context(main, "session-a"));
    const b = await ext.report({ state: "needs_input", summary: "Q", body: "1. ?" }, context(main, "session-b"));
    assert.notEqual(a.details.file, b.details.file);
    assert.equal((await lines(a.details.file)).length, 1);
    assert.equal((await lines(b.details.file)).length, 1);
  });

  it("returns a clear error and writes nothing for invalid input", async () => {
    const cwd = await repo();
    const ext = loadExtension();
    const ctx = context(cwd, "invalid");
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ state: "warning", summary: "s", body: "b" }, /Invalid state/],
      [{ state: "in_progress", summary: " ", body: "b" }, /summary is empty/],
      [{ state: "in_progress", summary: "x".repeat(101), body: "b" }, /limit is 100/],
      [{ state: "in_progress", summary: "s", body: "" }, /body is empty/],
    ];
    for (const [params, error] of cases) await assert.rejects(ext.report(params, ctx), error);
    assert.equal(existsSync(join(cwd, ".lambda")), false);
    assert.equal(await readFile(join(cwd, ".git", "info", "exclude"), "utf8").then((t) => t.includes(".lambda/")), false);
  });

  it("refuses to report outside a git repository", async () => {
    const cwd = await tempDir();
    await assert.rejects(
      loadExtension().report({ state: "in_progress", summary: "s", body: "b" }, context(cwd, "nogit")),
      /not inside a git worktree/,
    );
    assert.equal(existsSync(join(cwd, ".lambda")), false);
  });

  it("records a full turn lifecycle", async () => {
    const cwd = await repo();
    const ext = loadExtension();
    const ctx = context(cwd, "lifecycle");
    const file = join(cwd, ".lambda", "sessions", "lifecycle.jsonl");
    const assistant = (stopReason: string, errorMessage?: string) => ({ role: "assistant", stopReason, errorMessage });

    // Turn 1: declares needs_review, so no warning. agent_start repeats inside
    // one run on retries and must not add a second turn-start entry.
    await ext.emit("before_agent_start", { prompt: "Refactor the import job" }, ctx);
    await ext.emit("agent_start", {}, ctx);
    await ext.emit("agent_end", { messages: [assistant("error", "overloaded")] }, ctx);
    await ext.emit("agent_start", {}, ctx);
    await ext.report({ state: "needs_review", summary: "Ready", body: "Done." }, ctx);
    await ext.emit("agent_end", { messages: [assistant("stop")] }, ctx);
    await ext.emit("agent_settled", { aborted: false }, ctx);

    // Turn 2: forgets to report.
    await ext.emit("before_agent_start", { prompt: "Also add tests" }, ctx);
    await ext.emit("agent_start", {}, ctx);
    await ext.emit("agent_end", { messages: [assistant("stop")] }, ctx);
    await ext.emit("agent_settled", { aborted: false }, ctx);

    // Turn 3: hits a usage limit; the rate-limit handler's resume then starts
    // a run without before_agent_start.
    await ext.emit("before_agent_start", { prompt: "Continue" }, ctx);
    await ext.emit("agent_start", {}, ctx);
    await ext.emit(
      "agent_end",
      { messages: [assistant("error", "You have hit your ChatGPT usage limit (pro plan). Try again in ~37 min.")] },
      ctx,
    );
    await ext.emit("agent_settled", { aborted: false }, ctx);
    await ext.emit("agent_start", {}, ctx);
    await ext.report({ state: "needs_input", summary: "Pick one", body: "1. A or B?" }, ctx);
    await ext.emit("agent_end", { messages: [assistant("stop")] }, ctx);
    await ext.emit("agent_settled", { aborted: false }, ctx);

    const entries = await lines(file);
    assert.deepEqual(
      entries.map((entry) => [entry.state, entry.summary]),
      [
        ["in_progress", "Refactor the import job"],
        ["needs_review", "Ready"],
        ["in_progress", "Resumed, working"],
        ["warning", "Turn ended without a status report"],
        ["in_progress", "Resumed, working"],
        ["warning", toSummary("Turn ended on an error: You have hit your ChatGPT usage limit (pro plan). Try again in ~37 min.")],
        ["in_progress", "Resumed, working"],
        ["needs_input", "Pick one"],
      ],
    );
    assert.equal(entries[0]!.body, "## Task\n\nRefactor the import job");
    assert.match(String(entries[5]!.body), /usage limit \(pro plan\)/);
    assert.equal(git(cwd, "status", "--porcelain"), "");
  });

  it("skips hooks silently outside a git repository", async () => {
    const cwd = await tempDir();
    const ext = loadExtension();
    const ctx = context(cwd, "nogit-hooks");
    await ext.emit("before_agent_start", { prompt: "Hi" }, ctx);
    await ext.emit("agent_start", {}, ctx);
    await ext.emit("agent_settled", { aborted: false }, ctx);
    assert.equal(existsSync(join(cwd, ".lambda")), false);
  });
});
