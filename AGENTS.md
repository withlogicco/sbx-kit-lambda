# Repository guide

Lambda is a Docker SBX agent kit. Its `lambda` binary runs Pi; `codex` and
`claude` remain the native CLIs.

## Find the code

- `spec.yaml`: kit configuration, network and credential declarations, runtime
  setup, and the shared agent instructions shipped into workspace repositories.
- `files/home/.lambda/install-tools.sh`: shared tool installer called by both
  `Dockerfile` and `spec.yaml`'s `setup.install`.
- `files/home/.pi/agent/extensions/`: Pi extensions. `claude-agent/` implements
  the subscription provider; `native-subagents.ts` drives the native CLIs;
  `session-status.ts` defines the dashboard contract; `session-backup.ts`
  handles transcript backups; `sbx-codex.ts` adapts Codex proxy headers.
- `files/home/.pi/agent/settings.json`: shared preferences and model scope.
  `models.json` supplies provider overrides.
- `tests/`: behavior tests and extension typechecking. `.github/workflows/`
  defines CI checks and image publication.
- `README.md`: installation, authentication, model selection, and troubleshooting.

Search for tool and command registration in `pi.registerTool` and
`pi.registerCommand`; lifecycle behavior is registered with `pi.on`.

## Coding conventions

- Follow `.editorconfig`: spaces, with two-space indentation for TypeScript,
  JavaScript, JSON, and YAML.
- Keep Pi extensions self-contained under the discovered extensions directory.
- Keep shared preferences and model defaults in `settings.json`; verify model
  IDs against the live catalogs linked from `README.md`.
- Keep `README.md` aligned with changes to installation, authentication, and
  command behavior in `spec.yaml`.

## Validate changes

Use Node 22, matching `.github/workflows/tests.yml`:

```bash
cd tests && npm ci && npm test && npm run typecheck
```

From the repository root, validate and inspect kit changes:

```bash
sbx kit validate .
sbx kit inspect .
```
