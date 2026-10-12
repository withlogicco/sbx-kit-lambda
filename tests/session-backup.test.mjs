import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createJiti } from "jiti";

const sessionBackup = await createJiti(import.meta.url).import(
  "../files/home/.pi/agent/extensions/session-backup.ts",
  { default: true },
);

let temp;
let sessions;
let workspace;
let commands;
let notifications;
let context;
let previousAgentDir;

async function put(root, path, content = '{"type":"session","id":"test","cwd":"/project"}\n') {
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
}

async function run(name, args = "") {
  await commands.get(name).handler(args, context);
  return notifications.at(-1);
}

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "lambda-session-backup-test-"));
  sessions = join(temp, "agent", "sessions");
  workspace = join(temp, "workspace");
  await mkdir(sessions, { recursive: true });
  await mkdir(workspace);
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(temp, "agent");
  commands = new Map();
  notifications = [];
  context = {
    cwd: workspace,
    sessionManager: { getSessionDir: () => join(sessions, "--project-one--") },
    waitForIdle: async () => {},
    ui: { notify: (message, type) => notifications.push({ message, type }) },
  };
  sessionBackup({ registerCommand: (name, command) => commands.set(name, command) });
});

afterEach(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(temp, { recursive: true, force: true });
});

test("default backup preserves all project sessions byte-for-byte, not settings or credentials", async () => {
  const first = await put(sessions, "--project-one--/first.jsonl", "first branch\nsecond branch\n");
  await put(sessions, "--project-two--/second.jsonl", "second project\n");
  await put(sessions, "notes.txt", "not a session");
  await put(join(temp, "agent"), "auth.json", "secret");
  let idle = false;
  context.waitForIdle = async () => { idle = true; };
  const result = await run("backup");
  assert.equal(idle, true);
  assert.equal(result.type, "info");
  assert.match(result.message, /Backed up 2 Pi sessions/);
  const backup = join(workspace, ".lambda", "backup");
  assert.deepEqual(await readdir(backup), ["sessions"]);
  assert.deepEqual(await readdir(join(backup, "sessions")), ["--project-one--", "--project-two--"]);
  assert.deepEqual(await readFile(join(backup, "sessions", "--project-one--", "first.jsonl")), await readFile(first));
  assert.equal(await readFile(join(backup, "sessions", "--project-two--", "second.jsonl"), "utf8"), "second project\n");
});

test("restore merges all projects and never overwrites existing live sessions", async () => {
  await put(sessions, "--project-one--/first.jsonl", "saved\n");
  await put(sessions, "--project-two--/second.jsonl", "other\n");
  await run("backup");
  await rm(join(sessions, "--project-two--"), { recursive: true });
  await put(sessions, "--project-one--/first.jsonl", "new live history\n");
  await put(sessions, "--project-three--/new.jsonl", "new session\n");
  const result = await run("restore");
  assert.equal(result.type, "info");
  assert.match(result.message, /Restored 1 Pi sessions.*skipped 1 existing/);
  assert.equal(await readFile(join(sessions, "--project-one--", "first.jsonl"), "utf8"), "new live history\n");
  assert.equal(await readFile(join(sessions, "--project-two--", "second.jsonl"), "utf8"), "other\n");
  assert.equal(await readFile(join(sessions, "--project-three--", "new.jsonl"), "utf8"), "new session\n");
  assert.match((await run("restore")).message, /Restored 0 Pi sessions.*skipped 2 existing/);
});

test("repeated backup refreshes files and retains earlier archived sessions", async () => {
  await put(sessions, "--project-one--/first.jsonl", "before\n");
  await put(sessions, "--project-two--/old.jsonl", "retained\n");
  await run("backup");
  await put(sessions, "--project-one--/first.jsonl", "after\n");
  await rm(join(sessions, "--project-two--"), { recursive: true });
  assert.equal((await run("backup")).type, "info");
  const root = join(workspace, ".lambda", "backup", "sessions");
  assert.equal(await readFile(join(root, "--project-one--", "first.jsonl"), "utf8"), "after\n");
  assert.equal(await readFile(join(root, "--project-two--", "old.jsonl"), "utf8"), "retained\n");
  assert.deepEqual(await readdir(join(root, "--project-one--")), ["first.jsonl"]);
});

test("accepts relative, absolute, quoted, and unquoted paths with spaces", async () => {
  await put(sessions, "--project-one--/first.jsonl");
  for (const args of ["local archive", '"quoted archive"', "'single archive'", join(temp, "absolute archive")]) {
    const result = await run("backup", args);
    assert.equal(result.type, "info", result.message);
    assert.equal((await run("restore", args)).type, "info");
  }
  assert.equal((await run("backup", '"unclosed')).type, "error");
});

test("expands tilde paths without invoking a shell", async () => {
  await put(sessions, "--project-one--/first.jsonl");
  const homeBackup = await mkdtemp(join(homedir(), ".lambda-backup-test-"));
  try {
    const args = `~/${homeBackup.slice(homedir().length + 1)}`;
    assert.equal((await run("backup", args)).type, "info");
    assert.equal((await run("restore", args)).type, "info");
  } finally {
    await rm(homeBackup, { recursive: true, force: true });
  }
});

test("backs up the whole custom configured session store", async () => {
  const custom = join(temp, "custom-sessions");
  context.sessionManager.getSessionDir = () => custom;
  await put(custom, "first.jsonl", "custom\n");
  await put(custom, "second.jsonl", "another\n");
  assert.match((await run("backup")).message, /Backed up 2/);
  await rm(custom, { recursive: true });
  assert.match((await run("restore")).message, /Restored 2/);
  assert.equal(await readFile(join(custom, "first.jsonl"), "utf8"), "custom\n");
});

test("handles an empty store and a missing restore directory clearly", async () => {
  assert.equal((await run("restore")).type, "error");
  assert.match((await run("backup")).message, /Backed up 0/);
  assert.match((await run("restore")).message, /Restored 0/);
  await rm(sessions, { recursive: true });
  assert.equal((await run("backup")).type, "error");
});

test("rejects overlapping paths including aliases before writing", async () => {
  await put(sessions, "--project-one--/first.jsonl", "unchanged\n");
  const alias = join(temp, "alias");
  await symlink(sessions, alias);
  for (const path of [sessions, join(sessions, "nested"), dirname(sessions), alias, join(alias, "new")]) {
    for (const command of ["backup", "restore"]) {
      const result = await run(command, path);
      assert.equal(result.type, "error");
      assert.match(result.message, /must not overlap/);
    }
  }
  assert.equal(await readFile(join(sessions, "--project-one--", "first.jsonl"), "utf8"), "unchanged\n");
});

test("rejects source symlinks for backup and restore", async () => {
  const outside = await put(temp, "outside.jsonl", "outside\n");
  await symlink(outside, join(sessions, "linked.jsonl"));
  assert.equal((await run("backup")).type, "error");
  await rm(join(sessions, "linked.jsonl"));
  await put(sessions, "--project-one--/first.jsonl");
  await run("backup");
  await symlink(outside, join(workspace, ".lambda", "backup", "sessions", "linked.jsonl"));
  assert.equal((await run("restore")).type, "error");
});

test("rejects destination symlinks, directories, and non-directory backup paths", async () => {
  await put(sessions, "--project-one--/first.jsonl");
  await run("backup");
  await rm(join(sessions, "--project-one--"), { recursive: true });
  const outside = join(temp, "outside");
  await mkdir(outside);
  await symlink(outside, join(sessions, "--project-one--"));
  assert.equal((await run("restore")).type, "error");
  assert.deepEqual(await readdir(outside), []);
  await rm(join(sessions, "--project-one--"));
  await mkdir(join(sessions, "--project-one--", "first.jsonl"), { recursive: true });
  assert.equal((await run("restore")).type, "error");
  await put(workspace, "file", "not a directory");
  assert.equal((await run("backup", "file")).type, "error");
});

test("backup rejects archived file and store symlinks without touching their targets", async () => {
  await put(sessions, "--project-one--/first.jsonl");
  await run("backup");
  const archive = join(workspace, ".lambda", "backup", "sessions");
  const archivedFile = join(archive, "--project-one--", "first.jsonl");
  const outside = await put(temp, "outside.jsonl", "untouched\n");
  await rm(archivedFile);
  await symlink(outside, archivedFile);
  assert.equal((await run("backup")).type, "error");
  assert.equal(await readFile(outside, "utf8"), "untouched\n");
  await rm(archive, { recursive: true });
  await symlink(sessions, archive);
  assert.equal((await run("backup")).type, "error");
});

test("serializes commands and releases the busy flag after failures", async () => {
  let release;
  context.waitForIdle = () => new Promise((resolve) => { release = resolve; });
  const pending = run("backup");
  assert.equal((await run("restore")).type, "warning");
  release();
  await pending;
  context.waitForIdle = async () => { throw new Error("idle failure"); };
  assert.equal((await run("backup")).type, "error");
  context.waitForIdle = async () => {};
  assert.equal((await run("backup")).type, "info");
});
