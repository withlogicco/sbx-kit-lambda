# Align usage-based Anthropic authentication

## Scope

Resolve the high-severity contradiction in the Claude credential source and
bring the historical image and authentication decisions up to date. The user
confirmed that Anthropic billing is usage-based; no billing-discovery tests are
part of this change.

## Relevant files

- `AGENTS.md`
- `README.md`
- `spec.yaml`
- `agents/plans/2026-08-31-prebuilt-image.md`
- `agents/plans/2026-08-31-agent-kit.md`
- `agents/CHANGELOG.md`

## Implementation

1. Keep `claude-code` dynamically sourced from `pi auth print-bearer-token
   --provider anthropic` with on-demand refresh.
2. State consistently that Pi Anthropic models and native Claude share the one
   `claude-code` injection rule and therefore use the same usage-based billing
   mode; do not claim native Claude is plan-billed separately.
3. Preserve the `sk-ant-oat` sentinel extension and `anthropic/*` model scope,
   which make Pi emit a bearer header for proxy substitution.
4. Correct the prebuilt-image record: `sbx` uses its own image store, so a local
   image requires `docker save` and `sbx template load`; inspect it with
   `sbx template ls`.
5. Mark the earlier `claude setup-token` and unwired-Pi decisions as superseded,
   retaining the historical native-Claude smoke result as context.

## Decisions

- The shared `api.anthropic.com` injection rule cannot give Pi and native Claude
  distinct token sources or billing modes.
- Anthropic calls through `claude-code` are usage-based, including native
  Claude calls that receive the same host-minted bearer.
- The previously proposed Keychain-backed `claude setup-token` replacement is
  not used.

## Verification

- Run `sbx kit validate .` and `sbx kit inspect .`; the known `sandbox.build`
  notice is expected.
- Confirm references to billing, `setup-token`, and the local-image workflow
  agree across the README, spec, guidance, and plans.
