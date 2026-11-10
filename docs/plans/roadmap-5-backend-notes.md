# Roadmap 5 backend implementation notes

Work proceeds on `feat/r5-backend`, without editing `packages/web` or the fixed `packages/protocol` contract. Each stage includes this log in its commit. No parent agent, other agents, or pushes are used.

## B0 — package structure (N1)

- Merged core and the Node host into `@gense/server`, under `platform/`, `agent/`, `events/`, `channels/`, and `plugins/`. Removed protocol/notes forwarding files and the Drive plugin entry.
- Split conversation behavior into trees, branches/send, events, subagents, schedules and webhooks. `UserSpace` assembles typed, bound operations and owns runtime state.
- Updated workspace scripts, Docker entry point/manifests, Makefile checks, and startup paths. `check:server` checks protocol and server types and runs all server tests; it excludes the web package. Test temporary files stay in repository-local `data/test-tmp`.
- Tests: `npm run check:server` passed: protocol/server type checks and all 40 tests, including Docker sandbox and crash/restart recovery; 0 skipped.
- Protocol problems: none for this stage.
- Deviations and reasons: the existing host tests revealed that independently opened servers shared the fixed Docker container name, so closing one could kill another's command (exit 137). Container names now include a stable hash of the files directory. This isolates concurrent tests and separate data directories without changing sandbox behavior. The original 256 MB sandbox test limit is preserved.
