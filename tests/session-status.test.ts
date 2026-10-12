// Fixed zone so timestamps are deterministic; set before any Date is used.
process.env.TZ = "Europe/Athens";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import configureSessionStatus, {
  appendEntry,
  ensureExcluded,
  formatTimestamp,
  runError,
  serializeEntry,
  toSummary,
  turnEndEntry,
  turnStartEntry,
  validateReport,
  createEntry,
  parseDisplay,
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

  it("appends optional worktree metadata without changing v1 or old entries", () => {
    const entry = { ...createEntry("in_progress", "Working", "Fixing it."), worktree: ".worktrees/fix-import" };
    assert.deepEqual(JSON.parse(serializeEntry(entry)), entry);
    assert.ok(serializeEntry(entry).endsWith('"worktree":".worktrees/fix-import"}\n'));
    assert.equal("worktree" in JSON.parse(serializeEntry(createEntry("in_progress", "Working", "Fixing it."))), false);
  });

  it("collapses and truncates prompts into a summary", () => {
    assert.equal(toSummary("  Fix the\n\nimport   job "), "Fix the import job");
    const long = toSummary("a".repeat(150));
    assert.equal([...long].length, 100);
    assert.ok(long.endsWith("…"));
    assert.equal(toSummary("b".repeat(100)), "b".repeat(100));
  });
});

describe("append recovery", () => {
  const previous = serializeEntry(createEntry("in_progress", "Working", "Original task."));
  const cases: [string, string | undefined][] = [
    ["a missing file", undefined],
    ["an empty file", ""],
    ["newline-terminated history", previous],
    ["a complete record missing its newline", previous.trimEnd()],
    ["an interrupted JSON record", `${previous}{"v":1,"body":"interrupted`],
  ];

  for (const [name, initial] of cases) {
    it(`preserves ${name} and appends a recoverable record`, async () => {
      const root = await tempDir();
      const file = join(root, "status.jsonl");
      if (initial !== undefined) await writeFile(file, initial);
      const entry = { ...createEntry("needs_review", "Recovered", "Ready."), worktree: "." };
      await appendEntry({ root, file, relative: "status.jsonl" }, entry);
      const separator = initial && !initial.endsWith("\n") ? "\n" : "";
      const text = await readFile(file, "utf8");
      assert.equal(text, `${initial ?? ""}${separator}${serializeEntry(entry)}`);
      assert.deepEqual(parseDisplay(text), { worktree: ".", state: "needs_review", summary: "Recovered" });
      await appendEntry({ root, file, relative: "status.jsonl" }, entry);
      assert.equal(await readFile(file, "utf8"), text + serializeEntry(entry));
    });
  }
});

describe("validation", () => {
  const valid = { state: "needs_review", summary: "Ready", body: "Done.", worktree: "." };

  it("accepts the agent states and trims the summary", () => {
    for (const state of ["in_progress", "needs_input", "needs_review"]) {
    assert.deepEqual(validateReport({ ...valid, state, summary: "  Ready  " }), { ok: true, state, summary: "Ready", body: "Done.", worktree: "." });
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

  it("validates worktree path syntax and rejects omission", () => {
    assert.deepEqual(validateReport(valid), { ok: true, ...valid });
    for (const worktree of [undefined, "", "  ", null, 3, "/absolute/path", "a\nb", "a\0b"]) {
      assert.match((validateReport({ ...valid, worktree }) as { error: string }).error, /worktree is required/);
    }
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

  it("leaves harmless duplicate exclusions untouched", async () => {
    const path = join(await tempDir(), "exclude");
    const content = "*.log\n.lambda/\n.lambda/\n";
    await writeFile(path, content);
    assert.equal(await ensureExcluded(path), false);
    assert.equal(await readFile(path, "utf8"), content);
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

function uiContext(cwd: string, sessionId: string, styledTheme = false) {
  const statuses: (string | undefined)[] = [];
  const theme = styledTheme
    ? {
        bold: (text: string) => `<bold>${text}</bold>`,
        fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
      }
    : { bold: (text: string) => text, fg: (_color: string, text: string) => text };
  return {
    ...context(cwd, sessionId),
    mode: "tui",
    ui: {
      theme,
      setStatus(key: string, text: string | undefined) {
        assert.equal(key, "lambda-session");
        statuses.push(text);
      },
    },
    statuses,
  };
}

describe("session display", () => {
  it("folds reports separately from hook state and skips invalid/incomplete records", () => {
    const first = turnStartEntry(true, "Original task");
    const reported = { ...createEntry("needs_review", "Fix ready", "Done."), worktree: ".worktrees/fix" };
    const resumed = turnStartEntry(false, "Another task");
    const warning = turnEndEntry(undefined, undefined, true)!;
    const text = [first, reported, resumed, warning].map(serializeEntry).join("");
    assert.deepEqual(parseDisplay(text + '{"v":1'), { worktree: ".worktrees/fix", state: "warning", summary: "Fix ready" });
    for (const bad of ["broken", "null", '{"v":2}', JSON.stringify({ ...reported, worktree: 42 }), JSON.stringify({ ...reported, state: "done" })]) {
      assert.deepEqual(parseDisplay(serializeEntry(first) + bad + "\n" + serializeEntry(reported)), {
        worktree: ".worktrees/fix", state: "needs_review", summary: "Fix ready",
      });
    }
    assert.deepEqual(parseDisplay(serializeEntry(first)), { worktree: ".", state: "in_progress", summary: "Original task" });
    assert.deepEqual(parseDisplay(""), { worktree: "." });
  });

  it("updates the footer after writes and restores it on reload from a linked launch", async () => {
    const cwd = await repo();
    const linked = join(await tempDir(), "linked");
    git(cwd, "worktree", "add", "-q", "-b", "feature", linked);
    const worktree = relative(cwd, linked);
    const ctx = uiContext(cwd, "ui-reload");
    const ext = loadExtension();
    await ext.emit("session_start", { reason: "startup" }, ctx);
    assert.equal(ctx.statuses.at(-1), ".");
    assert.equal(existsSync(join(cwd, ".lambda")), false, "rendering must not create storage");
    await ext.emit("before_agent_start", { prompt: "Original task" }, ctx);
    await ext.emit("agent_start", {}, ctx);
    assert.equal(ctx.statuses.at(-1), ". · in_progress · Original task");
    await ext.report({ state: "needs_review", summary: "Fix ready", body: "Done.", worktree }, ctx);
    assert.equal(ctx.statuses.at(-1), `${worktree} · needs_review · Fix ready`);
    await ext.emit("agent_settled", { aborted: false }, ctx);
    await ext.emit("agent_start", {}, ctx);
    assert.equal(ctx.statuses.at(-1), `${worktree} · in_progress · Fix ready`);
    await ext.emit("agent_settled", { aborted: true }, ctx);
    assert.equal(ctx.statuses.at(-1), `${worktree} · warning · Fix ready`);

    const file = join(cwd, ".lambda/sessions/ui-reload.jsonl");
    const beforeReload = await readFile(file, "utf8");
    const resumed = loadExtension();
    const linkedCtx = uiContext(linked, "ui-reload");
    await resumed.emit("session_start", { reason: "reload" }, linkedCtx);
    assert.equal(linkedCtx.statuses.at(-1), `${worktree} · warning · Fix ready`);
    assert.equal(await readFile(file, "utf8"), beforeReload);
    await resumed.report({ state: "needs_input", summary: "Pick one", body: "1. A or B?", worktree: "." }, linkedCtx);
    assert.equal(linkedCtx.statuses.at(-1), ". · needs_input · Pick one");
    await assert.rejects(resumed.report({ state: "needs_review", summary: "Invalid", body: "Done.", worktree: "missing" }, linkedCtx));
    assert.equal(linkedCtx.statuses.at(-1), ". · needs_input · Pick one");
    await resumed.emit("session_shutdown", {}, linkedCtx);
    assert.equal(linkedCtx.statuses.at(-1), undefined);
  });

  it("restores a successful report appended after an interrupted tail", async () => {
    const cwd = await repo();
    const ctx = uiContext(cwd, "interrupted-tail");
    const ext = loadExtension();
    const first = await ext.report({ state: "in_progress", summary: "Working", body: "Task.", worktree: "." }, ctx);
    await appendFile(first.details.file, '{"v":1,"body":"interrupted');
    const before = await readFile(first.details.file, "utf8");
    await ext.report({ state: "needs_review", summary: "Recovered", body: "Done.", worktree: "." }, ctx);
    const text = await readFile(first.details.file, "utf8");
    assert.ok(text.startsWith(before + "\n"), "existing bytes remain untouched");
    assert.equal(ctx.statuses.at(-1), ". · needs_review · Recovered");
    const reloadedCtx = uiContext(cwd, "interrupted-tail");
    await loadExtension().emit("session_start", { reason: "reload" }, reloadedCtx);
    assert.equal(reloadedCtx.statuses.at(-1), ctx.statuses.at(-1));
  });

  it("clears a previous session's display on new/fork/resume and non-git launches", async () => {
    const cwd = await repo();
    const ext = loadExtension();
    const original = uiContext(cwd, "original");
    await ext.report({ state: "needs_review", summary: "Old task", body: "Done.", worktree: "." }, original);
    for (const reason of ["new", "fork", "resume"]) {
      const next = uiContext(cwd, `fresh-${reason}`);
      await ext.emit("session_start", { reason }, next);
      assert.deepEqual(next.statuses, ["."]);
    }
    const outside = uiContext(await tempDir(), "outside");
    await ext.emit("session_start", { reason: "resume" }, outside);
    assert.equal(outside.statuses.at(-1), ".");
    assert.equal(existsSync(join(outside.cwd, ".lambda")), false);
  });

  it("leaves active status unchanged on shutdown for dashboard stale detection", async () => {
    const cwd = await repo();
    const ctx = uiContext(cwd, "shutdown-stale");
    const ext = loadExtension();
    await ext.emit("before_agent_start", { prompt: "Long task" }, ctx);
    await ext.emit("agent_start", {}, ctx);
    const file = join(cwd, ".lambda/sessions/shutdown-stale.jsonl");
    const beforeShutdown = await readFile(file, "utf8");
    await ext.emit("session_shutdown", { reason: "quit" }, ctx);
    assert.equal(await readFile(file, "utf8"), beforeShutdown);
    assert.equal(parseDisplay(beforeShutdown).state, "in_progress");
    assert.equal(ctx.statuses.at(-1), undefined);
  });

  it("does not call terminal UI methods in non-TUI modes", async () => {
    const cwd = await repo();
    for (const mode of ["rpc", "json", "print"]) {
      const ext = loadExtension();
      const ctx = { ...context(cwd, `headless-${mode}`), mode };
      await ext.emit("session_start", { reason: "startup" }, ctx);
      await ext.emit("agent_start", {}, ctx);
      await ext.report({ state: "needs_review", summary: "Ready", body: "Done.", worktree: "." }, ctx);
      await ext.emit("agent_settled", { aborted: false }, ctx);
      await ext.emit("session_shutdown", {}, ctx);
    }
  });

  it("colors terminal states and bolds the worktree", async () => {
    const ctx = uiContext(await repo(), "styled-footer", true);
    const ext = loadExtension();
    await ext.report({ state: "in_progress", summary: "Working", body: "Continuing.", worktree: "." }, ctx);
    assert.equal(ctx.statuses.at(-1), "<bold>.</bold> · in_progress · Working");
    await ext.report({ state: "needs_input", summary: "Question", body: "Pick one.", worktree: "." }, ctx);
    assert.equal(ctx.statuses.at(-1), "<bold>.</bold> · <success>needs_input</success> · Question");
    await ext.report({ state: "needs_review", summary: "Ready", body: "Done.", worktree: "." }, ctx);
    assert.equal(ctx.statuses.at(-1), "<bold>.</bold> · <success>needs_review</success> · Ready");
    await ext.emit("agent_start", {}, ctx);
    await ext.emit("agent_settled", { aborted: true }, ctx);
    assert.equal(ctx.statuses.at(-1), "<bold>.</bold> · <warning>warning</warning> · Ready");
  });

  it("keeps terminal controls out of the footer", async () => {
    const ctx = uiContext(await repo(), "safe-title");
    await loadExtension().report({ state: "needs_review", summary: "Ready\u001b\u0007", body: "Done.", worktree: "." }, ctx);
    assert.equal(ctx.statuses.at(-1), ". · needs_review · Ready");
  });
});

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
    assert.ok(tool.description.includes("worktree: required: the Git worktree"));
    assert.equal(tool.name, "report_status");
    assert.ok(tool.description.startsWith("Report your status to the user's dashboard. You MUST call this"));
    assert.ok(tool.description.endsWith("Never claim a PR is merged."));
    assert.ok(tool.description.includes("worktree: required: the Git worktree"));
    assert.ok(tool.description.includes("Include it on every report."));
    assert.equal(tool.description.includes("Always include it on every report, even when unchanged"), false);
  });

  for (const which of ["main checkout", "linked worktree"]) {
    it(`appends one line per call in a ${which} and keeps git status clean`, async () => {
      const cwd = which === "main checkout" ? main : linked;
      const ext = loadExtension();
      const ctx = context(cwd, `s-${which.replace(" ", "-")}`);
      const first = await ext.report({ state: "in_progress", summary: "Halfway", body: "## Task\n\nDo it", worktree: which === "main checkout" ? "." : relative(main, linked) }, ctx);
      assert.equal(first.content[0].text, `Reported in_progress to .lambda/sessions/${ctx.sessionManager.getSessionId()}.jsonl`);
      await ext.report({ state: "needs_review", summary: "Done", body: "Look at a.ts", worktree: which === "main checkout" ? "." : relative(main, linked) }, ctx);
      assert.equal(first.details.file, join(main, ".lambda", "sessions", `${ctx.sessionManager.getSessionId()}.jsonl`));
      assert.equal(existsSync(join(linked, ".lambda")), false);
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

  it("keeps one file when a session resumes from a linked worktree", async () => {
    const sessionId = "cross-worktree-resume";
    const file = join(main, ".lambda", "sessions", `${sessionId}.jsonl`);
    const first = loadExtension();
    await first.emit("before_agent_start", { prompt: "Original task" }, context(main, sessionId));
    await first.emit("agent_start", {}, context(main, sessionId));
    await first.report({ state: "needs_review", summary: "Ready", body: "Done.", worktree: relative(main, linked) }, context(main, sessionId));
    await first.emit("agent_settled", { aborted: false }, context(main, sessionId));

    const resumed = loadExtension();
    await resumed.emit("before_agent_start", { prompt: "Next task" }, context(linked, sessionId));
    await resumed.emit("agent_start", {}, context(linked, sessionId));
    await resumed.emit("agent_settled", { aborted: false }, context(linked, sessionId));
    const entries = await lines(file);
    assert.deepEqual(entries.map((entry) => entry.state), ["in_progress", "needs_review", "in_progress", "warning"]);
    assert.equal(entries[2]!.summary, "Resumed, working");
    assert.deepEqual(entries.map((entry) => entry.worktree), [undefined, relative(main, linked), undefined, undefined]);
    assert.equal(entries.findLast((entry) => typeof entry.worktree === "string")!.worktree, relative(main, linked));
    assert.equal(existsSync(join(linked, ".lambda")), false);
  });

  it("keeps one association per session across omission and explicit reset", async () => {
    const ext = loadExtension();
    const ctx = context(main, "grouping");
    const path = relative(main, linked);
    const first = await ext.report({ state: "in_progress", summary: "Working", body: "Fixing it.", worktree: `${path}/./` }, ctx);
    assert.equal(first.details.worktree, path);
    await ext.report({ state: "needs_review", summary: "Ready", body: "Done.", worktree: "." }, ctx);
    const reported = await lines(first.details.file);
    assert.deepEqual(reported.map((entry) => entry.worktree), [path, "."]);
    await ext.report({ state: "in_progress", summary: "Back on it", body: "Continuing.", worktree: path }, ctx);
    assert.deepEqual((await lines(first.details.file)).map((entry) => entry.worktree), [path, ".", path]);
  });

  it("does not infer the association from a linked launch cwd", async () => {
    const result = await loadExtension().report({ state: "needs_review", summary: "Ready", body: "Done.", worktree: "." }, context(linked, "no-inference"));
    assert.equal(result.details.file, join(main, ".lambda", "sessions", "no-inference.jsonl"));
    assert.equal((await lines(result.details.file))[0]!.worktree, ".");
  });

  it("handles worktree names with spaces and symlink aliases", async () => {
    const cwd = await repo();
    await writeFile(join(cwd, ".git", "info", "exclude"), ".worktrees/\n");
    const worktree = join(cwd, ".worktrees", "fix imports");
    git(cwd, "worktree", "add", "-q", "-b", "fix-imports", worktree);
    const alias = join(await tempDir(), "alias");
    await symlink(worktree, alias);
    const ext = loadExtension();
    const result = await ext.report({ state: "needs_review", summary: "Ready", body: "Done.", worktree: relative(cwd, alias) }, context(worktree, "space-alias"));
    assert.equal((await lines(result.details.file))[0]!.worktree, ".worktrees/fix imports");
    assert.equal(result.details.file, join(cwd, ".lambda", "sessions", "space-alias.jsonl"));
    assert.equal(git(cwd, "status", "--porcelain"), "");
  });

  it("rejects missing paths, subdirectories, and unrelated repos without any writes", async () => {
    const cwd = await repo();
    const other = await repo();
    const subdir = join(cwd, ".git", "info");
    const exclude = join(cwd, ".git", "info", "exclude");
    const before = await readFile(exclude, "utf8");
    const ext = loadExtension();
    for (const worktree of ["missing", relative(cwd, subdir), relative(cwd, other), "/absolute", null, ""]) {
      await assert.rejects(ext.report({ state: "needs_review", summary: "Ready", body: "Done.", worktree }, context(cwd, "invalid-worktree")), /worktree/);
    }
    await assert.rejects(ext.report({ state: "needs_review", summary: "Ready", body: "Done." }, context(cwd, "invalid-worktree")), /worktree is required/);
    assert.equal(existsSync(join(cwd, ".lambda")), false);
    assert.equal(await readFile(exclude, "utf8"), before);
  });

  it("finds the main checkout with a separate git directory", async () => {
    const cwd = await tempDir();
    const gitDir = join(await tempDir(), "metadata");
    git(cwd, "init", "-q", "-b", "main", `--separate-git-dir=${gitDir}`);
    const result = await loadExtension().report({ state: "needs_review", summary: "Ready", body: "Done.", worktree: "." }, context(cwd, "separate-git"));
    assert.equal(result.details.file, join(cwd, ".lambda", "sessions", "separate-git.jsonl"));
    assert.equal(git(cwd, "status", "--porcelain"), "");
  });

  it("rejects linked worktrees of a bare repository instead of inventing a main checkout", async () => {
    const parent = await tempDir();
    const bare = join(parent, "bare.git");
    execFileSync("git", ["clone", "-q", "--bare", main, bare]);
    const worktree = join(parent, "linked");
    git(bare, "worktree", "add", "-q", "-b", "bare-linked", worktree);
    await assert.rejects(loadExtension().report({ state: "needs_review", summary: "Ready", body: "Done.", worktree: relative(bare, worktree) }, context(worktree, "bare")), /no main checkout/);
    assert.equal(existsSync(join(bare, ".lambda")), false);
    assert.equal(existsSync(join(worktree, ".lambda")), false);
  });

  it("writes two sessions in one worktree to two files", async () => {
    const ext = loadExtension();
    const a = await ext.report({ state: "needs_input", summary: "Q", body: "1. ?", worktree: "." }, context(main, "session-a"));
    const b = await ext.report({ state: "needs_input", summary: "Q", body: "1. ?", worktree: "." }, context(main, "session-b"));
    assert.notEqual(a.details.file, b.details.file);
    assert.equal((await lines(a.details.file)).length, 1);
    assert.equal((await lines(b.details.file)).length, 1);
  });

  it("returns a clear error and writes nothing for invalid input", async () => {
    const cwd = await repo();
    const ext = loadExtension();
    const ctx = context(cwd, "invalid");
    const tool = loadExtension().tool();
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ state: "warning", summary: "s", body: "b", worktree: "." }, /Invalid state/],
      [{ state: "in_progress", summary: " ", body: "b", worktree: "." }, /summary is empty/],
      [{ state: "in_progress", summary: "x".repeat(101), body: "b", worktree: "." }, /limit is 100/],
      [{ state: "in_progress", summary: "s", body: "" }, /body is empty/],
      [{ state: "in_progress", summary: "s", body: "b" }, /worktree is required/],
    ];
    for (const [params, error] of cases) await assert.rejects(tool.execute("call", params, undefined, undefined, ctx), error);
    assert.equal(existsSync(join(cwd, ".lambda")), false);
    assert.equal(await readFile(join(cwd, ".git", "info", "exclude"), "utf8").then((t) => t.includes(".lambda/")), false);
  });

  it("refuses to report outside a git repository", async () => {
    const cwd = await tempDir();
    await assert.rejects(
      loadExtension().report({ state: "in_progress", summary: "s", body: "b", worktree: "." }, context(cwd, "nogit")),
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
    await ext.report({ state: "needs_review", summary: "Ready", body: "Done.", worktree: "." }, ctx);
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
    await ext.report({ state: "needs_input", summary: "Pick one", body: "1. A or B?", worktree: "." }, ctx);
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
