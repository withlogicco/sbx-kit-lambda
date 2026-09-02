import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Pi picks its Anthropic auth mode from the shape of the API key: only a key
// containing `sk-ant-oat` takes the OAuth path, which is the one this sandbox
// needs. That path sends `Authorization: Bearer`, which the sandbox proxy can
// overwrite; the API-key path sends `x-api-key`, which it cannot. The same
// switch also turns on the Claude Code identity headers, system prompt, and
// tool naming that Anthropic requires from an OAuth token.
//
// This non-secret sentinel satisfies that check so Pi emits an Authorization
// header at all. The proxy then overwrites it on requests to api.anthropic.com
// with the host-minted token from the kit's `claude-code` credential, so the
// value itself is irrelevant: apiKey injection replaces whatever the header
// contains. Without this extension Pi sends no usable header for the proxy to
// substitute, and `anthropic/*` models fail to authenticate.
const PI_ANTHROPIC_SENTINEL = "sk-ant-oat01-proxy-managed";

export default function configureSbxAnthropic(pi: ExtensionAPI): void {
  pi.registerProvider("anthropic", {
    apiKey: PI_ANTHROPIC_SENTINEL,
  });
}
