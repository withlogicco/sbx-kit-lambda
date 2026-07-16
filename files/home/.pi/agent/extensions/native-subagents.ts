import { spawn } from "node:child_process";
import { mkdir, appendFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_OUTPUT_BYTES = 50 * 1024;
const roles = ["plan", "review", "code"] as const;
type Role = (typeof roles)[number];
type Backend = "codex" | "claude";

interface RunResult {
	backend: Backend;
	role: Role;
	executable: string;
	model: string;
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

async function isExecutable(command: string): Promise<boolean> {
	if (command.includes("/")) {
		try {
			await access(command, constants.X_OK);
			return true;
		} catch {
			return false;
		}
	}
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		try {
			await access(join(directory, command), constants.X_OK);
			return true;
		} catch {
			// Try the next PATH entry.
		}
	}
	return false;
}

async function executableFor(backend: Backend): Promise<string> {
	const configured = backend === "codex" ? process.env.LAMBDA_CODEX_EXECUTABLE : process.env.LAMBDA_CLAUDE_EXECUTABLE;
	if (configured) return configured;
	const native = backend === "codex" ? "sbx-codex" : "sbx-claude";
	if (await isExecutable(native)) return native;
	// `codex` is Lambda's Pi wrapper in this kit, never the native CLI.
	return backend === "codex" ? native : "claude";
}

function modelFor(backend: Backend, role: Role): string {
	const configured = process.env[`LAMBDA_${backend.toUpperCase()}_${role.toUpperCase()}_MODEL`];
	if (configured) return configured;
	if (backend === "codex") return role === "code" ? "gpt-5.6-terra" : "gpt-5.6-sol";
	return role === "code" ? "opus" : "fable";
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
		roleInstructions(role),
		"Work directly in the current workspace. Do not ask for permissions or wait for approval.",
		"Task:",
		task,
	].join("\n\n");
}

function invocation(backend: Backend, executable: string, model: string, cwd: string): { command: string; args: string[] } {
	if (backend === "codex") {
		return {
			command: executable,
			args: [
				"exec", "--json", "--ephemeral", "--skip-git-repo-check",
				"--dangerously-bypass-approvals-and-sandbox", "--model", model, "--cd", cwd, "-",
			],
		};
	}
	return {
		command: executable,
		args: ["-p", "--model", model, "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"],
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
	model: string,
	signal: AbortSignal | undefined,
	onProgress: (text: string) => void,
): Promise<RunResult> {
	const executable = await executableFor(backend);
	const runDirectory = join(tmpdir(), "lambda-subagents");
	await mkdir(runDirectory, { recursive: true, mode: 0o700 });
	const logFile = join(runDirectory, `${Date.now()}-${backend}-${role}.jsonl`);
	const { command, args } = invocation(backend, executable, model, cwd);
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
		model,
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
	const header = `${result.backend} ${result.role} (${result.model}; ${result.executable})`;
	if (result.authRequired) {
		return `${header} could not authenticate.\n\nClaude Code authentication is required. Run:\n\n!sbx-claude auth login\n\nLog: ${result.logFile}`;
	}
	const status = result.exitCode === 0 ? "completed" : `failed (exit ${result.exitCode})`;
	return `${header} ${status}.\n\n${result.output}\n\nLog: ${result.logFile}`;
}

const parameters = Type.Object({
	backend: StringEnum(["codex", "claude"] as const, { description: "Native subagent backend" }),
	role: StringEnum(roles, { description: "plan and review are read-only; code may modify the workspace" }),
	task: Type.String({ description: "Focused task for the native subagent" }),
	model: Type.Optional(Type.String({ description: "Native model override. Defaults to the slash-command role model." })),
});

export default function (pi: ExtensionAPI) {
	const execute = async (
		backend: Backend,
		role: Role,
		task: string,
		cwd: string,
		model: string | undefined,
		signal: AbortSignal | undefined,
		onProgress: (text: string) => void,
	) => withCodeLock(role, () => runNativeAgent(backend, role, task, cwd, model ?? modelFor(backend, role), signal, onProgress));

	pi.registerTool({
		name: "run_subagent",
		label: "Run Subagent",
		description: "Delegate a focused plan, review, or coding task to native Codex or Claude Code. Code runs share a workspace lock; plan and review are read-only.",
		parameters,
		async execute(_id, params, signal, onUpdate, ctx) {
			const result = await execute(params.backend, params.role, params.task, ctx.cwd, params.model, signal, (text) => {
				onUpdate?.({ content: [{ type: "text", text }] });
			});
			return { content: [{ type: "text", text: resultText(result) }], details: result };
		},
	});

	for (const backend of ["codex", "claude"] as const) {
		pi.registerCommand(backend, {
			description: `Run native ${backend === "codex" ? "Codex" : "Claude Code"}: /${backend} <plan|review|code> <task>`,
			handler: async (args, ctx) => {
			const [role, ...taskParts] = args.trim().split(/\s+/);
			if (!roles.includes(role as Role) || taskParts.length === 0) {
				ctx.ui.notify(`Usage: /${backend} <plan|review|code> <task>`, "error");
				return;
			}
			ctx.ui.setStatus("native-subagent", `${backend} ${role} running…`);
			try {
				const result = await execute(backend, role as Role, taskParts.join(" "), ctx.cwd, modelFor(backend, role as Role), undefined, (text) => {
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
