import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";

const settingsText = await readFile(
  new URL("../files/home/.pi/agent/settings.json", import.meta.url),
  "utf8",
);
const settings = JSON.parse(settingsText);

test("shared Pi settings load model and interaction defaults without installation metadata", () => {
  const manager = SettingsManager.inMemory(settings);
  assert.equal(manager.getDefaultProvider(), "openai-codex");
  assert.equal(manager.getDefaultModel(), "gpt-6.1-sol");
  assert.equal(manager.getDefaultThinkingLevel(), "high");
  assert.equal(manager.getTheme(), "dark");
  assert.equal(manager.getSteeringMode(), "all");
  assert.equal(manager.getCollapseChangelog(), true);
  assert.equal(manager.getEnableInstallTelemetry(), false);
  assert.equal(manager.getDefaultProjectTrust(), "always");
  assert.deepEqual(manager.getPackages(), []);
  assert.equal(manager.getSettings().tuiMode, "regular");
  assert.deepEqual(manager.getSettings().warnings, { anthropicExtraUsage: false });
  assert.equal("deviceId" in settings, false);
  assert.equal("lastChangelogVersion" in settings, false);
});

test("model scope includes the default and has no duplicates or launch flags", async () => {
  const enabled = SettingsManager.inMemory(settings).getEnabledModels();
  assert.ok(enabled.includes(`${settings.defaultProvider}/${settings.defaultModel}`));
  assert.equal(new Set(enabled).size, enabled.length);
  for (const model of ["opencode-go/gpt-5.6-luna", "anthropic/claude-sonnet-5"]) {
    assert.ok(!enabled.includes(model), model);
  }
  const spec = await readFile(new URL("../spec.yaml", import.meta.url), "utf8");
  assert.match(spec, /^  entrypoint: \[lambda\]$/m);
  assert.match(spec, /^  command: \[\]$/m);
});

test("each provider retains budget and recommended choices, plus capability tiers where useful", () => {
  const tiers = {
    "openai-codex": ["gpt-6-luna", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-astra"],
    anthropic: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"],
    xai: ["grok-4.3", "grok-4.7"],
    "opencode-go": [
      "gpt-6-luna",
      "kimi-k2.7-code", "kimi-k3",
      "glm-5.3-flash", "glm-5.3",
      "deepseek-v4.1-flash", "deepseek-v4-pro",
      "qwen3.8-flash", "qwen3.8-max",
    ],
  };
  for (const [provider, models] of Object.entries(tiers)) {
    for (const model of models) {
      assert.ok(settings.enabledModels.includes(`${provider}/${model}`), `${provider}/${model}`);
    }
  }
  assert.deepEqual(
    settings.enabledModels.filter((model) => model.startsWith("anthropic/")),
    tiers.anthropic.map((model) => `anthropic/${model}`),
  );
  const counts = new Map();
  for (const model of settings.enabledModels) {
    const provider = model.split("/")[0];
    counts.set(provider, (counts.get(provider) ?? 0) + 1);
  }
  for (const [provider, count] of counts) assert.ok(count >= 2, provider);
});

test("agent-directory settings load from disk and allow trusted project overrides", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lambda-settings-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  await mkdir(agentDir);
  await mkdir(join(project, ".pi"), { recursive: true });
  await writeFile(join(agentDir, "settings.json"), settingsText);
  const manager = SettingsManager.create(project, agentDir);
  assert.equal(manager.getDefaultModel(), "gpt-6.1-sol");
  assert.deepEqual(manager.getEnabledModels(), settings.enabledModels);

  await writeFile(join(project, ".pi", "settings.json"), JSON.stringify({
    defaultProvider: "anthropic",
    defaultModel: "claude-sonnet-5-5",
    defaultThinkingLevel: "medium",
    enabledModels: ["anthropic/claude-sonnet-5-5"],
    theme: "light",
  }));
  manager.setProjectTrusted(true);
  await manager.reload();
  assert.equal(manager.getDefaultProvider(), "anthropic");
  assert.equal(manager.getDefaultModel(), "claude-sonnet-5-5");
  assert.equal(manager.getDefaultThinkingLevel(), "medium");
  assert.deepEqual(manager.getEnabledModels(), ["anthropic/claude-sonnet-5-5"]);
  assert.equal(manager.getTheme(), "light");
  assert.equal(manager.getSteeringMode(), "all");
  assert.deepEqual(manager.drainErrors(), []);
});
