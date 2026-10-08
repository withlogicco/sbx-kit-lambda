# Session status reporting

## Scope

Implement a Pi extension that lets Lambda report its working state to a local
dashboard. The dashboard is built separately in another repo; the two share only
the file contract below, which is fixed: do not change the layout, entry format
or state names.

First, save this whole prompt as
agents/plans/2026-10-08-session-status-reporting.md, following the format of the
existing plans there, and add a dated line to agents/CHANGELOG.md matching the
existing entries.

## Shared contract

Each agent session is one append-only JSONL file inside the worktree. The last
valid line is the session's current state; the whole file is its history.

```
<worktree root>/.lambda/sessions/<session-id>.jsonl
```

- .lambda/ is kept out of git by adding `.lambda/` to the repo's info/exclude
  (resolve it with `git rev-parse --git-path info/exclude`, which works from
  linked worktrees). The repo's .gitignore is never touched.
- <session-id> is the Pi session id, which stays consistent for the session's
  lifetime, including across resumes. A new session in the same worktree gets a
  new file.

Entry: one JSON object per line, UTF-8, newline-terminated:

```
{"v":1,"ts":"2026-10-08T10:56:28+03:00","state":"needs_input","summary":"Pick caching strategy for the import job","body":"Two options...\n\n1. ..."}
```

- v: integer, 1
- ts: ISO 8601 with timezone offset, time of the write
- state: one of in_progress, needs_input, needs_review, warning
- summary: one line, max 100 characters
- body: markdown

States:

- needs_input: blocked on questions or a choice; cannot continue. Set by the
  agent.
- needs_review: agent believes the work is done. Set by the agent.
- in_progress: working, nothing needed. Set by the agent and by the turn-start
  hook.
- warning: the turn ended without a needs_input/needs_review declaration, or
  ended on an error. Written ONLY by the turn-end hook, never by the agent.

(The dashboard also derives a fifth state, stale, from in_progress with no
update for 30 minutes. It is never written to a file. Not your concern.)

Rules: append only, never rewrite, truncate or reorder. Each write is one
complete line in a single append. The first entry of a session states the
original task in body. There is no merged/done state; PR status never comes from
the agent.

## What to build

Location: files/home/.pi/agent/extensions/session-status.ts, a self-contained
TypeScript module Pi auto-discovers. Follow AGENTS.md (two-space indent, no
installs outside install-tools.sh). Read the existing extensions
(rate-limit-handler.ts, native-subagents.ts, sbx-anthropic.ts) first to learn
this repo's ExtensionAPI patterns.

### 1. Tool: report_status(state, summary, body)

- state: enum in_progress | needs_input | needs_review; reject anything else.
- summary: trimmed; reject if empty or over 100 chars.
- body: markdown; reject if empty.
- Returns "Reported <state> to .lambda/sessions/<id>.jsonl" or a clear error the
  agent can fix and retry. On any error, write nothing.

Behavior:

1. Resolve the worktree root with `git rev-parse --show-toplevel` from the
   agent's working directory; outside a git repo, return an error.
2. Use the Pi session id as the file name. Find how the extension API exposes
   it. If it doesn't, STOP and tell me; do not invent a fallback.
3. Create .lambda/sessions/ if missing.
4. Ensure `.lambda/` is in info/exclude exactly once.
5. Build the entry with v:1 and current local time with offset, serialize to one
   line, append in a single write in append mode.
6. Never read, rewrite or delete existing entries.

Use this tool description verbatim:

```
Report your status to the user's dashboard. You MUST call this as the LAST action of every turn, with needs_input or needs_review (or in_progress only if you are genuinely continuing). You MAY also call it mid-turn, but only when you have important progress to report during a long stretch of work (a big research pass, a large code change) where the turn's end is far off. Keep mid-turn entries minimal; do not report routine steps.

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
Do not paste diffs or long logs; reference file paths instead. Never claim a PR is merged.
```

### 2. Turn-start hook

Appends an in_progress entry mechanically at the start of every turn, so the
session shows up the instant work begins and flips back to in_progress on
resume. First turn of a session: the incoming prompt as summary (truncated to
100 chars) and body. Later turns: summary "Resumed, working", minimal body.

### 3. Turn-end hook

If the agent's last write this turn was not needs_input or needs_review (it
forgot, or the turn died on an error such as out of tokens, a crash, or a
quota/usage limit), append a warning entry. If the turn ended on an error, put
the reason in body; otherwise body just says the turn ended without a status
report.

## Verify, don't assume

- The exact Pi events for turn start and turn end (rate-limit-handler.ts already
  uses agent_end). Tell me which you chose.
- Interplay with rate-limit-handler.ts: it detects usage limits on agent_end and
  auto-resumes. A rate-limited turn should produce a warning with the limit as
  the reason; the auto-resume should then produce the turn-start in_progress
  entry. Don't modify rate-limit-handler.ts unless necessary, and explain if you
  do.
- Whether Lambda has a system prompt in this repo where a one-line "always end
  your turn with report_status" belongs. If not, say so; the tool description
  alone is acceptable.

## Done means

- Turn-start hook appends one in_progress entry every turn (task on first turn,
  minimal on resumes).
- Calling the tool creates .lambda/sessions/<id>.jsonl and appends one valid
  line per call; multiple calls per turn work.
- .lambda/ appears once in info/exclude; git status stays clean in a main
  checkout and a linked worktree.
- Invalid state, empty/over-long summary, and empty body each return a clear
  error and write nothing.
- Two sessions in one worktree write to two different files.
- Turn-end hook writes warning (with reason on errors) whenever no terminal
  state was declared.
- Unit tests cover serialization, validation and info/exclude handling.
- `sbx kit validate .` passes; README.md documents the feature briefly.
- End with a short list of anything you couldn't do as written, and why.

## Relevant files

- `files/home/.pi/agent/extensions/session-status.ts`
- `tests/session-status.test.ts`, `tests/resolve.mjs`, `tests/package.json`,
  `tests/tsconfig.json`
- `README.md`, `AGENTS.md`, `agents/CHANGELOG.md`

## Decisions

- Session id: `ctx.sessionManager.getSessionId()`. Verified in Pi 1.1.0 that a
  session reopened from its file keeps the same id and keeps appending to the
  same status file.
- Turn start is the first `agent_start` of a Pi agent run; `before_agent_start`
  only captures the prompt. Pi's `turn_start`/`turn_end` fire per model request,
  and `agent_start` repeats inside one run on auto-retry and compaction
  continuations. The rate-limit resume (`sendMessage` with `triggerTurn`)
  starts a run without `before_agent_start`.
- Turn end is `agent_settled`, which fires once per run after all retries and
  continuations. `agent_end` only records the error the final inner loop ended
  on (`stopReason` `error`, or `length` for the output token limit).
- `rate-limit-handler.ts` is unchanged. It schedules its resume on `agent_end`;
  `agent_settled` then writes the warning carrying the provider's limit
  message, and the resume run writes `Resumed, working`.
- An error writes a warning even after a `needs_input`/`needs_review` report,
  because the contract defines warning as "ended without a declaration, or
  ended on an error". An abort without a declaration is a warning; an abort
  after one is not.
- First turn is detected by the status file being absent or empty (size only;
  entries are never read). A session resumed in a new process therefore gets
  `Resumed, working`, not the task again.
- The first-turn body is `## Task` followed by the prompt, matching the format
  the tool description asks the agent to use.
- Lambda has no system prompt file in this repo. `spec.yaml`
  `agentInstructions` reaches every agent in the sandbox, including native
  Codex and Claude, which lack the tool. The one-line reminder is the tool's
  `promptGuidelines`, which Pi adds to the system prompt only while
  `report_status` is active.
- Invalid `state` values are rejected first by Pi's schema validation (the
  parameter is a `StringEnum`) and again by `validateReport`, so an invalid
  state never writes anything.
- Hooks never fail a turn: outside a git worktree they write nothing.
- Tests live in a separate `tests/` package with Pi's real packages, so that
  the kit root stays free of Node tooling. `resolve.mjs` resolves the
  extension's bare imports from `tests/node_modules`.

## Verification

- `cd tests && npm test`: 22 tests covering serialization, validation,
  `info/exclude`, turn entries, a main checkout and a linked worktree with a
  clean `git status`, two sessions in one worktree, and the hook lifecycle.
- `npm run typecheck` against Pi 1.1.0's declarations.
- End to end through the Pi 1.1.0 SDK with the scripted `faux` provider and
  the real extension loader (with `rate-limit-handler.ts` loaded): first-turn
  task, a forgotten report, a usage-limit error, a `triggerTurn` resume, an
  invalid state, over-long summary and empty body, a linked-worktree session, a
  second session in the same worktree, and a resume from the session file.
- `sbx kit validate .` was not run: `sbx` is not available in that environment.
