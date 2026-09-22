import { spawn } from "node:child_process";
import { matchesKey } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Rate limit handler.
 *
 * Catches terminal rate-limit failures from OpenCode Go (usage-window limits)
 * and ChatGPT Codex ("The usage limit has been reached") by inspecting failed
 * assistant messages on `agent_end`. These errors surface as application-level
 * error messages, never as 429 response headers.
 *
 * When one is detected, the wait until reset is parsed from the error message
 * (falling back to a 429 `retry-after` header, then to provider defaults), a
 * countdown widget is shown, and the session is automatically restarted when
 * the limit resets. The user can press ESC at any time to cancel the scheduled
 * restart and keep using the session.
 */

type Provider = "opencode-go" | "codex";

interface PendingRestart {
  provider: Provider;
  resetAt: number;
  timer: NodeJS.Timeout;
  ticker: NodeJS.Timeout;
  clearWidget: () => void;
}

/** Used only when neither the error message nor a 429 header carries a reset time. */
const DEFAULT_RESET_SECONDS: Record<Provider, number> = {
  "opencode-go": 5 * 60,
  codex: 60 * 60,
};

const pendingRestarts = new Map<Provider, PendingRestart>();

// Private consumer usage endpoints. They sit behind the same credentials as
// the completion APIs, so in sandboxes the proxy injects the real token over
// the sentinel Authorization header.
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const OPENCODE_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const USAGE_TIMEOUT_MS = 8000;
const CODEX_USAGE_SENTINEL = "oai-oat01-proxy-managed";
const OPENCODE_USAGE_SENTINEL = "proxy-managed";

/**
 * Reset timestamp captured from the most recent 429 per provider. The Codex
 * websocket path reports usage limits as bare "Codex error: The usage limit
 * has been reached" messages with no reset time, so the HTTP-layer headers
 * are our only precise signal in that case.
 */
const lastRetryAfter = new Map<Provider, number>();

/** Authoritative reset from the last successful usage-endpoint query per provider. */
const lastUsageReset = new Map<Provider, number>();

/** Minimal slice of a command/event context needed to show a notification. */
interface Notifier {
  ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
}

function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.ceil(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function errorText(message: { errorMessage?: string; content?: unknown }): string {
  const parts: string[] = [];
  if (message.errorMessage) parts.push(message.errorMessage);
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
        parts.push(String((block as { text?: string }).text ?? ""));
      }
    }
  }
  return parts.join("\n");
}

export function parseRateLimit(
  message: { role: string; stopReason?: string; errorMessage?: string; content?: unknown },
): { provider: Provider; resetSeconds: number } | null {
  if (message.role !== "assistant" || message.stopReason !== "error") return null;
  const text = errorText(message);
  if (!text) return null;

  const now = Date.now();
  let provider: Provider | null = null;
  let resetSeconds: number | null = null;

  // OpenCode Go usage-window limits. The message either carries an absolute
  // reset timestamp or a wall-clock reset time ("Resets at 14:32").
  const isOpencode =
    /(?:GoUsageLimitError|FreeUsageLimitError|usage limit)/i.test(text) && !/ChatGPT usage limit/i.test(text);
  if (isOpencode) {
    provider = "opencode-go";
    const unixMs = text.match(/\b(1[6-9]\d{11})\b/);
    const unixSeconds = text.match(/\b(1[6-9]\d{8})\b/);
    if (unixMs) {
      resetSeconds = Math.max(1, Math.round((parseInt(unixMs[1]!, 10) - now) / 1000));
    } else if (unixSeconds) {
      resetSeconds = Math.max(1, Math.round((parseInt(unixSeconds[1]!, 10) * 1000 - now) / 1000));
    } else {
      const clock = text.match(/resets? (?:at|in)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
      if (clock) {
        let hours = parseInt(clock[1]!, 10);
        const minutes = clock[2] ? parseInt(clock[2], 10) : 0;
        const meridiem = clock[3]?.toLowerCase();
        if (meridiem === "pm" && hours < 12) hours += 12;
        if (meridiem === "am" && hours === 12) hours = 0;
        const target = new Date(now);
        target.setHours(hours, minutes, 0, 0);
        // A reset time already in the past refers to tomorrow.
        if (target.getTime() <= now) target.setDate(target.getDate() + 1);
        resetSeconds = Math.round((target.getTime() - now) / 1000);
      }
    }
  }

  // ChatGPT Codex: "You have hit your ChatGPT usage limit (pro plan). Try again in ~37 min."
  if (/ChatGPT usage limit|usage limit has been reached/i.test(text)) {
    provider = "codex";
    const relative = text.match(/try again in\s*~?\s*(\d+)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)/i);
    if (relative) {
      const value = parseInt(relative[1]!, 10);
      const unit = relative[2]!.toLowerCase();
      if (/^(hours?|hrs?|h)$/.test(unit)) resetSeconds = value * 3600;
      else if (/^(minutes?|mins?|m)$/.test(unit)) resetSeconds = value * 60;
      else resetSeconds = value;
    } else {
      const resetsAt = text.match(/resets?[^0-9]{0,20}(\d{10,13})/);
      if (resetsAt) {
        const ms = resetsAt[1]!.length > 10 ? parseInt(resetsAt[1]!, 10) : parseInt(resetsAt[1]!, 10) * 1000;
        resetSeconds = Math.max(1, Math.round((ms - now) / 1000));
      }
    }
  }

  if (!provider) return null;

  const retryAfter = lastRetryAfter.get(provider);
  lastRetryAfter.delete(provider);
  if (resetSeconds === null && retryAfter !== undefined && retryAfter > now) {
    resetSeconds = Math.max(1, Math.round((retryAfter - now) / 1000));
  }
  return { provider, resetSeconds: resetSeconds ?? DEFAULT_RESET_SECONDS[provider] };
}

/** Detach a fresh session from the terminal and stop the rate-limited one. */
function restartSession(): void {
  const child = spawn("lambda", [], {
    stdio: "inherit",
    detached: true,
    env: process.env,
  });
  child.unref();
  process.exit(0);
}

interface CodexAuth {
  accessToken?: string;
  accountId?: string;
}

/**
 * Resolve credentials through Pi rather than reading another agent's state.
 * `pi auth` also applies Pi's normal auth-file/environment resolution and can
 * refresh OAuth credentials before returning them.
 */
async function readPiCredential(args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn("pi", ["auth", ...args], {
      env: process.env,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    let settled = false;
    let timer: NodeJS.Timeout;
    const finish = (useOutput: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const credential = output.trim();
      resolve(useOutput && credential.length > 0 ? credential : undefined);
    };
    timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, USAGE_TIMEOUT_MS);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
    });
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
  });
}

function codexAccountId(accessToken: string | undefined): string | undefined {
  if (!accessToken) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split(".")[1]!, "base64url").toString("utf8")) as {
      "https://api.openai.com/auth"?: { chatgpt_account_id?: unknown };
    };
    const accountId = payload["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof accountId === "string" ? accountId : undefined;
  } catch {
    // The proxy-managed sentinel is not a JWT; proceed without this header.
    return undefined;
  }
}

async function readCodexAuth(): Promise<CodexAuth> {
  const accessToken = await readPiCredential([
    "print-bearer-token",
    "--provider",
    "openai-codex",
    "--min-expiry",
    "1m",
  ]);
  return { accessToken, accountId: codexAccountId(accessToken) };
}

async function readOpencodeKey(): Promise<string | undefined> {
  // Pi resolves this provider from auth.json first and OPENCODE_API_KEY second.
  // Keep the explicit environment fallback so this request uses the same
  // credential sources as the OpenCode Go model request itself.
  return (
    (await readPiCredential(["print-api-key", "--provider", "opencode-go"])) ??
    process.env.OPENCODE_API_KEY
  );
}

/**
 * Ask the provider's usage endpoint for the authoritative reset time of the
 * blocking window. Returns epoch ms, or null when the answer is unavailable
 * (network failure, auth rejection, or no exhausted window) — callers keep
 * their parsed/default schedule in that case.
 */
async function fetchUsageReset(provider: Provider): Promise<number | null> {
  try {
    if (provider === "codex") {
      const auth = await readCodexAuth();
      const headers: Record<string, string> = {
        Accept: "application/json",
        "User-Agent": "pi-rate-limit-handler",
        Authorization: `Bearer ${auth.accessToken ?? CODEX_USAGE_SENTINEL}`,
      };
      if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;
      const res = await fetch(CODEX_USAGE_URL, { headers, signal: AbortSignal.timeout(USAGE_TIMEOUT_MS) });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        rate_limit?: {
          primary_window?: { used_percent?: unknown; reset_at?: unknown; reset_after_seconds?: unknown } | null;
          secondary_window?: { used_percent?: unknown; reset_at?: unknown; reset_after_seconds?: unknown } | null;
        } | null;
      };
      const windows = [data.rate_limit?.primary_window, data.rate_limit?.secondary_window].filter(
        (w): w is NonNullable<typeof w> => !!w,
      );
      if (windows.length === 0) return null;
      const resetOf = (w: (typeof windows)[number]): number | null => {
        if (typeof w.reset_at === "number" && w.reset_at > 0) return w.reset_at * 1000;
        if (typeof w.reset_after_seconds === "number" && w.reset_after_seconds > 0) {
          return Date.now() + w.reset_after_seconds * 1000;
        }
        return null;
      };
      // Prefer exhausted windows; an error can also stem from a depleted
      // credit balance, in which case the nearest window reset is the best
      // available estimate.
      const exhausted = windows.filter((w) => (typeof w.used_percent === "number" ? w.used_percent : 0) >= 100);
      const candidates = (exhausted.length > 0 ? exhausted : windows)
        .map(resetOf)
        .filter((v): v is number => v !== null);
      return candidates.length > 0 ? Math.max(...candidates) : null;
    }

    const key = await readOpencodeKey();
    const res = await fetch(OPENCODE_USAGE_URL, {
      headers: {
        Accept: "application/json",
        "User-Agent": "pi-rate-limit-handler",
        Authorization: `Bearer ${key ?? OPENCODE_USAGE_SENTINEL}`,
      },
      signal: AbortSignal.timeout(USAGE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      usage?: {
        rolling?: { status?: unknown; resetsAt?: unknown } | null;
        weekly?: { status?: unknown; resetsAt?: unknown } | null;
        monthly?: { status?: unknown; resetsAt?: unknown } | null;
      } | null;
    };
    const windows = [data.usage?.rolling, data.usage?.weekly, data.usage?.monthly].filter(
      (w): w is { status: string; resetsAt: string } => w?.status === "rate-limited" && typeof w.resetsAt === "string",
    );
    if (windows.length === 0) return null;
    const resets = windows.map((w) => Date.parse(w.resetsAt)).filter((t) => !Number.isNaN(t));
    return resets.length > 0 ? Math.max(...resets) : null;
  } catch {
    return null;
  }
}

export default function configureRateLimitHandler(pi: ExtensionAPI): void {
  // Capture reset information from 429 responses to back up error messages
  // that lack a parsable reset time.
  pi.on("after_provider_response", (event) => {
    if (event.status !== 429) return;
    const headers = event.headers;
    let resetAt: number | undefined;

    const retryAfterMs = headers["retry-after-ms"];
    if (retryAfterMs !== undefined && Number.isFinite(Number(retryAfterMs))) {
      resetAt = Date.now() + Number(retryAfterMs);
    }

    if (resetAt === undefined) {
      const retryAfter = headers["retry-after"];
      if (retryAfter !== undefined) {
        const seconds = Number(retryAfter);
        // Delta seconds or an HTTP-date.
        resetAt = Number.isFinite(seconds) ? Date.now() + seconds * 1000 : Date.parse(retryAfter);
      }
    }

    if (resetAt === undefined) {
      const reset = headers["x-ratelimit-reset"];
      if (reset !== undefined) {
        const value = Number(reset);
        if (Number.isFinite(value)) {
          // Epoch seconds or epoch ms.
          resetAt = value > 1e11 ? value : value * 1000;
        } else {
          const parsed = Date.parse(reset);
          if (!Number.isNaN(parsed)) resetAt = parsed;
        }
      }
    }

    if (resetAt !== undefined && resetAt > Date.now()) {
      // The event carries no model/provider context and both target providers
      // are Codex-family responses APIs, so record the 429 for both.
      lastRetryAfter.set("opencode-go", resetAt);
      lastRetryAfter.set("codex", resetAt);
    }
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!ctx.hasUI) return;

    for (const message of event.messages) {
      const parsed = parseRateLimit(message);
      if (!parsed) continue;
      scheduleRestart(parsed.provider, parsed.resetSeconds, ctx);
      break;
    }
  });

  // Never leave timers or the input listener behind across session changes.
  pi.on("session_shutdown", () => {
    cancelAll();
  });

  function scheduleRestart(provider: Provider, resetSeconds: number, ctx: ExtensionContext): void {
    // Failed turns repeat while the user keeps retrying; keep the earliest
    // schedule per provider instead of pushing the restart further out.
    const existing = pendingRestarts.get(provider);
    if (existing) {
      if (existing.resetAt <= Date.now() + resetSeconds * 1000) return;
      cancel(provider, { silent: true });
    }

    // Show the estimate immediately, then refine it with the provider's usage
    // endpoint (authoritative) once the request settles. A previously refined
    // reset wins outright — repeated failed turns then reuse it without
    // refetching and without flickering back to the rough estimate.
    const cached = lastUsageReset.get(provider);
    if (cached !== undefined && cached > Date.now()) {
      startCountdown(provider, cached, ctx);
      return;
    }
    startCountdown(provider, Date.now() + resetSeconds * 1000, ctx);
    void refineFromUsage(provider, ctx);
  }

  async function refineFromUsage(provider: Provider, ctx: ExtensionContext): Promise<void> {
    const resetMs = await fetchUsageReset(provider);
    // The user may have cancelled (or the timer fired) while we were fetching.
    if (resetMs === null || !pendingRestarts.has(provider)) return;
    if (resetMs <= Date.now()) return;
    lastUsageReset.set(provider, resetMs);
    cancel(provider, { silent: true });
    startCountdown(provider, resetMs, ctx);
  }

  function startCountdown(provider: Provider, resetAt: number, ctx: ExtensionContext): void {
    const renderWidget = () => {
      const remaining = formatDuration((resetAt - Date.now()) / 1000);
      ctx.ui.setWidget(
        "rate-limit",
        [
          `⏱️  ${provider} rate limited — restart in ${remaining}`,
          "    Press ESC to cancel the automatic restart",
        ],
      );
    };
    renderWidget();
    const ticker = setInterval(renderWidget, 1000);

    const timer = setTimeout(async () => {
      pendingRestarts.delete(provider);
      clearInterval(ticker);
      ctx.ui.setWidget("rate-limit", undefined);
      ctx.ui.notify(`${provider} rate limit reset — restarting session`, "info");
      restartSession();
    }, Math.max(0, resetAt - Date.now()));

    pendingRestarts.set(provider, {
      provider,
      resetAt,
      timer,
      ticker,
      clearWidget: () => ctx.ui.setWidget("rate-limit", undefined),
    });
    ensureEscapeListener(ctx.ui);
  }

  /** Watch raw terminal input for ESC while a restart is pending, without consuming it. */
  let detachEscapeListener: (() => void) | null = null;

  function ensureEscapeListener(ui: ExtensionContext["ui"]): void {
    if (detachEscapeListener) return;
    detachEscapeListener = ui.onTerminalInput((data) => {
      if (pendingRestarts.size > 0 && matchesKey(data, "escape")) {
        cancelAll();
      }
      // Never consume: pi keeps its own ESC handling (e.g. aborting a run).
      return undefined;
    });
  }

  function releaseEscapeListener(): void {
    if (pendingRestarts.size > 0) return;
    detachEscapeListener?.();
    detachEscapeListener = null;
  }

  function cancel(provider: Provider, opts?: { ctx?: Notifier; silent?: boolean }): void {
    const notify = !opts?.silent;
    const pending = pendingRestarts.get(provider);
    if (!pending) return;
    clearTimeout(pending.timer);
    clearInterval(pending.ticker);
    pending.clearWidget();
    pendingRestarts.delete(provider);
    if (!notify) return;
    // An explicit cancel invalidates the cached usage answer: the next rate
    // limit should be looked up fresh.
    lastUsageReset.delete(provider);
    opts?.ctx?.ui.notify(`Cancelled the automatic restart for ${provider}.`, "info");
    releaseEscapeListener();
  }

  function cancelAll(): void {
    for (const provider of [...pendingRestarts.keys()]) cancel(provider, { silent: true });
  }

  pi.registerCommand("rate-limits", {
    description: "Show all pending rate limit waits with countdown timers",
    handler: async (_args, ctx) => {
      if (pendingRestarts.size === 0) {
        ctx.ui.notify("No pending rate limit waits.", "info");
        return;
      }
      const items = [...pendingRestarts.values()].map(
        (pending) => `${pending.provider}: restart in ${formatDuration((pending.resetAt - Date.now()) / 1000)}`,
      );
      ctx.ui.notify(`Rate limit waits:\n${items.join("\n")}`, "info");
    },
  });

  pi.registerCommand("cancel-wait", {
    description: "/cancel-wait [provider] — Cancel a pending rate limit wait (restart)",
    handler: async (args, ctx) => {
      const provider = args.trim().toLowerCase() as Provider | "";
      if (!provider) {
        const count = pendingRestarts.size;
        cancelAll();
        ctx.ui.notify(`Cancelled ${count} rate limit wait(s).`, count > 0 ? "info" : "warning");
        return;
      }
      if (!pendingRestarts.has(provider)) {
        ctx.ui.notify(`No pending rate limit wait for ${provider}.`, "warning");
        return;
      }
      cancel(provider, { ctx });
    },
  });
}
