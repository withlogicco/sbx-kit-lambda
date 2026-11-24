/**
 * Claude Agent provider for Pi.
 *
 * Anthropic models through the sandbox's Claude Code subscription: Pi drives
 * the installed `claude` program with the Claude Agent SDK, keeps its own
 * tools, history, permissions, and compaction, and pays nothing at the mock
 * rate card because the subscription covers usage.
 *
 * The provider is registered as `claude-agent` (SDK branding forbids "Claude
 * Code" as a product name). Pi's `anthropic/*` models keep the platform API
 * key; this provider never touches it.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { makeRegistry } from "./sessions.js";

/** A subscription covers usage; no request costs anything at the rate card. */
const FREE_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * The aliases Claude's own picker uses. Fable resolves to a 1M-context model
 * on current Claude; the rest stay at the conservative default. No Haiku:
 * the kit's curated model scope keeps the two mid tiers and the top tier.
 */
const MODELS = [
  { id: "sonnet", name: "Claude Sonnet", cents: 0, contextWindow: 200_000, maxTokens: 32_000 },
  { id: "opus", name: "Claude Opus", cents: 0, contextWindow: 200_000, maxTokens: 32_000 },
  { id: "fable", name: "Claude Fable", cents: 0, contextWindow: 1_000_000, maxTokens: 32_000 },
];

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** Pi thinking levels map onto Claude's effort levels; "minimal" rounds down. */
function toEffort(level: ThinkingLevel | undefined): Effort | undefined {
  if (!level || level === "minimal") return level ? "low" : undefined;
  return level as Effort;
}

export default function registerClaudeAgent(pi: ExtensionAPI): void {
  const registry = makeRegistry();

  pi.registerProvider("claude-agent", {
    name: "Claude Agent",
    api: "claude-agent-sdk",
    // Required by the config layer even though no HTTP request ever leaves this provider.
    baseUrl: "https://claude-agent.invalid",
    // Pi requires a resolvable key before it calls streamSimple. Claude Code
    // authenticates itself (CLAUDE_CODE_OAUTH_TOKEN via the SBX proxy), so
    // this literal is a non-secret marker that is never sent anywhere.
    apiKey: "claude-code-login",
    // No endpoint: the child `claude` process performs every request itself.
    models: MODELS.map((model) => ({
      type: "chat" as const,
      id: model.id,
      name: model.name,
      reasoning: true,
      input: ["text", "image"],
      // promptCache stays unset so Pi's cache warmer never replays these
      // models' requests: warm-ups would spawn a full `claude` process.
      cost: { ...FREE_COST },
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    })),
    streamSimple: (model, context, options) =>
      registry.run({
        sessionId: options?.sessionId,
        model,
        effort: toEffort(options?.reasoning),
        context,
        options,
        cwd: process.cwd(),
      }),
  });

  // The factory must stay process-free; every claude child dies here or on
  // the idle timer, whichever comes first.
  pi.on("session_shutdown", () => registry.close());
}
