import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Pi parses Codex API keys as JWTs before sending them. This non-secret value
// satisfies that local parser; the header hook below swaps it for Codex's SBX
// sentinel, which the built-in Codex sandbox OAuth proxy replaces on the host.
const PI_CODEX_SENTINEL =
	"eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoicHJveHktbWFuYWdlZCJ9fQ.proxy-managed";
const SBX_CODEX_SENTINEL = "oai-oat01-proxy-managed";

export default function configureSbxCodex(pi: ExtensionAPI): void {
	pi.registerProvider("openai-codex", {
		apiKey: PI_CODEX_SENTINEL,
	});
	pi.on("before_provider_headers", (event) => {
		if (event.headers.Authorization === `Bearer ${PI_CODEX_SENTINEL}`) {
			event.headers.Authorization = `Bearer ${SBX_CODEX_SENTINEL}`;
		}
	});
}
