/**
 * Lazy loader for the Claude Agent SDK.
 *
 * The SDK ships its own `claude` binary through optional platform packages, but
 * this kit sets the real path with `pathToClaudeCodeExecutable`, so those
 * packages are not needed and `npm ci --omit=optional` skips them.
 */
import type * as SDK from "@anthropic-ai/claude-agent-sdk";

let cached: Promise<typeof SDK> | undefined;

export function load(): Promise<typeof SDK> {
  cached ??= import("@anthropic-ai/claude-agent-sdk").catch((cause) => {
    // Let the next request retry, e.g. after the dependencies are installed.
    cached = undefined;
    throw new Error(
      "Claude Agent SDK isn't installed. Run the kit's install-tools (or `npm ci --omit=optional` in the claude-agent extension directory).",
      { cause },
    );
  });
  return cached;
}

/** Older binaries ignore `verbatimPrompts` and can mistake user text for slash commands. */
const MINIMUM_VERSION = "2.1.248";

export function versionError(version: string | undefined): Error | undefined {
  if (version && atLeast(version, MINIMUM_VERSION)) return undefined;
  if (!version) return new Error("Claude Code did not report its version; run `claude update`.");
  return new Error(`Claude Code ${version} is too old; run \`claude update\`.`);
}

function atLeast(version: string, minimum: string): boolean {
  const parse = (value: string) => value.split(/[-+]/)[0].split(".").map(Number);
  const current = parse(version);
  const required = parse(minimum);
  const index = required.findIndex((part, i) => (current[i] ?? 0) !== part);
  return index === -1 || (current[index] ?? 0) > required[index];
}
