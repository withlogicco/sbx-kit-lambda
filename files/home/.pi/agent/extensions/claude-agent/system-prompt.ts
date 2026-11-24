/**
 * What Claude sees on top of Claude Code's own system prompt.
 *
 * Same split as OpenCode's claude-agent provider: Claude Code is the harness,
 * so its `claude_code` preset replaces Pi's harness prompt, and Pi contributes
 * only the user's instructions. Pi's prompt is structured (see Pi's
 * `buildSystemPromptSections`), which makes the split explicit:
 *
 * - dropped: `preamble` (Pi's identity, when it is Pi's default), `tools`
 *   (tool descriptions already reach Claude through the MCP definitions),
 *   `docs` (Pi's own documentation), `cwd` (Claude Code writes its own
 *   environment);
 * - kept: everything else — `rules`, `addendum` (APPEND_SYSTEM), the
 *   `project_context` (AGENTS.md files), `skills`, extension sections, and a
 *   custom SYSTEM.md preamble, which stands in for an agent role.
 */
import { getCurrentSystemMessage, type Message } from "@earendil-works/pi-ai";

/** Pi harness sections that Claude Code's preset already covers. */
const HARNESS_SECTIONS = new Set(["tools", "docs", "cwd"]);

const RUNTIME_NOTE =
  "<runtime_info>You are running in Pi through the Claude Code harness. Mention this only when asked.</runtime_info>";

/** The text appended to the `claude_code` preset for this transcript. */
export function claudeInstructions(messages: readonly Message[]): string {
  const blocks = [RUNTIME_NOTE];
  const system = getCurrentSystemMessage(messages as Message[]);
  if (!system) return RUNTIME_NOTE;

  // Unstructured content is either a forced full prompt or extra instructions
  // an extension added; both are the user's, not Pi's harness.
  const content =
    typeof system.content === "string" ? system.content : system.content.map((part) => part.text).join("\n");
  if (content.trim()) blocks.push(content.trim());

  const sections = system.sections ?? {};
  // Pi only emits `docs` alongside its default preamble; a custom SYSTEM.md
  // preamble comes without it and is the user's own role prompt.
  const defaultPreamble = typeof sections["docs"] === "string";
  for (const [name, text] of Object.entries(sections)) {
    if (!text) continue;
    if (HARNESS_SECTIONS.has(name)) continue;
    if (name === "preamble") {
      if (!defaultPreamble) blocks.push(`# Agent role (from Pi)\n${text}`);
      continue;
    }
    blocks.push(text);
  }
  return blocks.join("\n\n");
}
