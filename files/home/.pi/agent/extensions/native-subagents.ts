import { spawn } from "node:child_process";
import { mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_OUTPUT_BYTES = 50 * 1024;
const roles = ["plan", "review", "code"] as const;
const modelAliases = ["sol", "terra", "luna", "opus", "sonnet"] as const;
type Role = (typeof roles)[number];
type Backend = "codex" | "claude";
type ModelAlias = (typeof modelAliases)[number];
type Effort = "high" | "ultra";

interface ModelSelection {
  alias?: ModelAlias;
  model: string;
  effort: Effort | string;
}

interface RunResult {
  backend: Backend;
  role: Role;
  executable: string;
  model: string;
  effort: string;
  output: string;
  stderr: string;
  exitCode: number;
  logFile: string;
  authRequired: boolean;
}

let codeRun: Promise<void> = Promise.resolve();

function truncate(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_BYTES) return text;
  let result = text.slice(0, MAX_OUTPUT_BYTES);
  while (Buffer.byteLength(result, "utf8") > MAX_OUTPUT_BYTES) result = result.slice(0, -1);
  return `${result}\n\n[Output truncated; full event log is retained outside Pi context.]`;
}

async function executableFor(backend: Backend): Promise<string> {
  const configured = backend === "codex" ? process.env.LAMBDA_CODEX_EXECUTABLE : process.env.LAMBDA_CLAUDE_EXECUTABLE;
  if (configured) return configured;
  // Lambda runs as its own `lambda` binary, so `codex` and `claude` are the
  // real upstream CLIs rather than wrappers around Pi.
  return backend === "codex" ? "codex" : "claude";
}

const modelSelections: Record<Backend, Partial<Record<ModelAlias, ModelSelection>>> = {
  codex: {
    sol: { alias: "sol", model: "gpt-5.6-sol", effort: "high" },
    terra: { alias: "terra", model: "gpt-5.6-terra", effort: "ultra" },
    luna: { alias: "luna", model: "gpt-5.6-luna", effort: "high" },
  },
  claude: {
    opus: { alias: "opus", model: "opus", effort: "high" },
    sonnet: { alias: "sonnet", model: "sonnet", effort: "high" },
  },
};

const defaultModelAlias: Record<Backend, ModelAlias> = { codex: "sol", claude: "opus" };

function aliasesFor(backend: Backend): ModelAlias[] {
  return Object.keys(modelSelections[backend]) as ModelAlias[];
}

function selectionFor(backend: Backend, role: Role, requestedAlias?: ModelAlias): ModelSelection {
  const configuredModel = process.env[`LAMBDA_${backend.toUpperCase()}_${role.toUpperCase()}_MODEL`];
  const configuredEffort = process.env[`LAMBDA_${backend.toUpperCase()}_${role.toUpperCase()}_EFFORT`];
  const fallback = modelSelections[backend][defaultModelAlias[backend]]!;

  if (requestedAlias) {
    const requested = modelSelections[backend][requestedAlias];
    if (!requested) throw new Error(`Model alias ${requestedAlias} is not available for ${backend}. Use: ${aliasesFor(backend).join(", ")}.`);
    return requested;
  }

  if (!configuredModel) return configuredEffort ? { ...fallback, effort: configuredEffort } : fallback;
  const known = aliasesFor(backend)
    .map((alias) => modelSelections[backend][alias]!)
    .find((selection) => selection.alias === configuredModel || selection.model === configuredModel);
  return {
    alias: known?.alias,
    model: known?.model ?? configuredModel,
    effort: configuredEffort ?? known?.effort ?? fallback.effort,
  };
}

function roleInstructions(role: Role): string {
  switch (role) {
    case "plan":
      return "Inspect only; do not modify files. Return a concise plan with scope, files, implementation steps, verification, and open decisions.";
    case "review":
      return "Inspect only; do not modify files. Review for correctness, security, regressions, and missing tests. Report findings by severity with file locations; say explicitly when there are no findings.";
    case "code":
      return "Implement the task in the workspace. Run relevant tests. Return a concise summary of changes, files changed, tests run, and remaining issues.";
  }
}

function promptFor(role: Role, task: string): string {
  return [
    "You are a delegated coding subagent running inside an externally sandboxed SBX environment.",
    "The delegating model has already decided to invoke you after the user's request. Obey the task immediately; do not second-guess the delegation.",
    roleInstructions(role),
    "Work directly in the current workspace. Do not ask for permissions or wait for approval.",
    "Task:",
    task,
  ].join("\n\n");
}

function invocation(backend: Backend, executable: string, selection: ModelSelection, cwd: string): { command: string; args: string[] } {
  if (backend === "codex") {
    return {
      command: executable,
      args: [
        "exec", "--json", "--ephemeral", "--skip-git-repo-check",
        "--dangerously-bypass-approvals-and-sandbox", "--model", selection.model,
        "--config", `model_reasoning_effort="${selection.effort}"`, "--cd", cwd, "-",
      ],
    };
  }
  return {
    command: executable,
    args: [
      "-p", "--model", selection.model, "--effort", selection.effort,
      "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions",
    ],
  };
}

function textFromEvent(event: unknown): string[] {
  if (!event || typeof event !== "object") return [];
  const value = event as Record<string, unknown>;
  const type = typeof value.type === "string" ? value.type : "";
  const item = value.item as Record<string, unknown> | undefined;
  const message = value.message as Record<string, unknown> | undefined;
  const content = (item?.content ?? message?.content ?? value.content) as unknown;
  const directText = item?.text ?? message?.text ?? value.text;
  const isAssistant = type.includes("assistant") || type === "item.completed" || item?.type === "agent_message";
  if (!isAssistant) return [];

  if (typeof directText === "string") return [directText];
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (typeof part === "string") return [part];
    if (!part || typeof part !== "object") return [];
    const text = (part as Record<string, unknown>).text;
    return typeof text === "string" ? [text] : [];
  });
}

function isAuthFailure(backend: Backend, output: string): boolean {
  if (backend !== "claude") return false;
  return /(?:not authenticated|not logged in|authentication (?:required|failed)|please (?:log ?in|sign in)|please run \/login|run .*auth login)/i.test(output);
}

async function runNativeAgent(
  backend: Backend,
  role: Role,
  task: string,
  cwd: string,
  selection: ModelSelection,
  signal: AbortSignal | undefined,
  onProgress: (text: string) => void,
): Promise<RunResult> {
  const executable = await executableFor(backend);
  const runDirectory = join(tmpdir(), "lambda-subagents");
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  const logFile = join(runDirectory, `${Date.now()}-${backend}-${role}.jsonl`);
  const { command, args } = invocation(backend, executable, selection, cwd);
  const output: string[] = [];
  let stderr = "";
  let buffer = "";

  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    const abort = () => child.kill("SIGTERM");
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });

    const receive = (line: string) => {
      if (!line.trim()) return;
      void appendFile(logFile, `${line}\n`, { encoding: "utf8", mode: 0o600 });
      try {
        const text = textFromEvent(JSON.parse(line));
        if (text.length > 0) {
          output.push(...text);
          onProgress(truncate(output.join("\n")));
        }
      } catch {
        // Native tools may emit a non-JSON diagnostic; stderr retains it when available.
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) receive(line);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      stderr += `${error.message}\n`;
      resolve(127);
    });
    child.on("close", (code) => {
      if (buffer) receive(buffer);
      signal?.removeEventListener("abort", abort);
      resolve(code ?? 1);
    });
    child.stdin.end(promptFor(role, task));
  });

  const combined = `${output.join("\n")}\n${stderr}`;
  return {
    backend,
    role,
    executable,
    model: selection.model,
    effort: selection.effort,
    output: truncate(output.join("\n").trim() || stderr.trim() || "(no final output)"),
    stderr,
    exitCode,
    logFile,
    authRequired: isAuthFailure(backend, combined),
  };
}

async function withCodeLock<T>(role: Role, action: () => Promise<T>): Promise<T> {
  if (role !== "code") return action();
  const previous = codeRun;
  let release!: () => void;
  codeRun = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await action();
  } finally {
    release();
  }
}

function resultText(result: RunResult): string {
  const header = `${result.backend} ${result.role} (${result.model}; effort ${result.effort}; ${result.executable})`;
  if (result.authRequired) {
    return `${header} could not authenticate.\n\nClaude Code authentication is required. Run \`!claude\` and complete \`/login\` inside the sandbox.\n\nLog: ${result.logFile}`;
  }
  const status = result.exitCode === 0 ? "completed" : `failed (exit ${result.exitCode})`;
  return `${header} ${status}.\n\n${result.output}\n\nLog: ${result.logFile}`;
}

const parameters = Type.Object({
  backend: StringEnum(["codex", "claude"] as const, { description: "Native subagent backend" }),
  role: StringEnum(roles, { description: "plan and review are read-only; code may modify the workspace" }),
  task: Type.String({ description: "Focused task for the native subagent" }),
  model: Type.Optional(StringEnum(modelAliases, {
    description: "Model alias. Codex: sol (default), terra, luna. Claude: opus (default), sonnet.",
  })),
});

export default function (pi: ExtensionAPI) {
  const execute = async (
    backend: Backend,
    role: Role,
    task: string,
    cwd: string,
    modelAlias: ModelAlias | undefined,
    signal: AbortSignal | undefined,
    onProgress: (text: string) => void,
  ) => {
    const selection = selectionFor(backend, role, modelAlias);
    return withCodeLock(role, () => runNativeAgent(backend, role, task, cwd, selection, signal, onProgress));
  };

  pi.registerTool({
    name: "run_subagent",
    label: "Run Subagent",
    description: "Run native Codex or Claude Code only when the current user explicitly asks for that subagent. Never use it proactively. Code runs share a workspace lock; plan and review are read-only.",
    promptGuidelines: [
      "Never call run_subagent proactively; call it only when the current user explicitly asks to run or delegate to a native subagent, Codex, or Claude.",
    ],
    parameters,
    prepareArguments(args) {
      if (!args || typeof args !== "object") return args;
      const input = args as { model?: unknown };
      const legacyAliases: Record<string, ModelAlias> = {
        "gpt-5.6-sol": "sol",
        "gpt-5.6-terra": "terra",
        "gpt-5.6-luna": "luna",
      };
      return typeof input.model === "string" && legacyAliases[input.model]
        ? { ...input, model: legacyAliases[input.model] }
        : args;
    },
    async execute(_id, params, signal, onUpdate, ctx) {
      const result = await execute(params.backend, params.role, params.task, ctx.cwd, params.model, signal, (text) => {
        onUpdate?.({ content: [{ type: "text", text }] });
      });
      return { content: [{ type: "text", text: resultText(result) }], details: result };
    },
  });

  for (const backend of ["codex", "claude"] as const) {
    const availableAliases = aliasesFor(backend);
    pi.registerCommand(backend, {
      description: `Run native ${backend === "codex" ? "Codex" : "Claude Code"}: /${backend} <plan|review|code> [${availableAliases.join("|")}] <task>`,
      handler: async (args, ctx) => {
        const [roleToken, ...remainingParts] = args.trim().split(/\s+/);
        const requestedAlias = availableAliases.includes(remainingParts[0] as ModelAlias)
          ? remainingParts.shift() as ModelAlias
          : undefined;
        if (!roles.includes(roleToken as Role) || remainingParts.length === 0) {
          ctx.ui.notify(`Usage: /${backend} <plan|review|code> [${availableAliases.join("|")}] <task>`, "error");
          return;
        }
        const role = roleToken as Role;
        const selection = selectionFor(backend, role, requestedAlias);
        ctx.ui.setStatus("native-subagent", `${backend} ${role} (${selection.alias ?? selection.model}) running…`);
        try {
          const result = await execute(backend, role, remainingParts.join(" "), ctx.cwd, requestedAlias, undefined, (text) => {
            ctx.ui.setStatus("native-subagent", `${backend} ${role}: ${text.slice(-80)}`);
          });
          pi.sendMessage({ customType: "native-subagent", content: resultText(result), display: true, details: result });
        } finally {
          ctx.ui.setStatus("native-subagent", undefined);
        }
      },
    });
  }
}
