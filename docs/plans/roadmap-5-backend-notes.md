# Roadmap 5 backend implementation notes

Work proceeds on `feat/r5-backend`, without editing `packages/web` or the fixed `packages/protocol` contract. Each stage includes this log in its commit. No parent agent, other agents, or pushes are used.

## B0 — package structure (N1)

- Merged core and the Node host into `@gense/server`, under `platform/`, `agent/`, `events/`, `channels/`, and `plugins/`. Removed protocol/notes forwarding files and the Drive plugin entry.
- Split conversation behavior into trees, branches/send, events, subagents, schedules and webhooks. `UserSpace` assembles typed, bound operations and owns runtime state.
- Updated workspace scripts, Docker entry point/manifests, Makefile checks, and startup paths. `check:server` checks protocol and server types and runs all server tests; it excludes the web package. Test temporary files stay in repository-local `data/test-tmp`.
- Tests: `npm run check:server` passed: protocol/server type checks and all 40 tests, including Docker sandbox and crash/restart recovery; 0 skipped.
- Protocol problems: none for this stage.
- Deviations and reasons: the existing host tests revealed that independently opened servers shared the fixed Docker container name, so closing one could kill another's command (exit 137). Container names now include a stable hash of the files directory. This isolates concurrent tests and separate data directories without changing sandbox behavior. The original 256 MB sandbox test limit is preserved.

## B1 — plugin registry and tool catalog (N26)

- Added `definePlugin` and a declaration directory for every built-in plugin. Each owns availability checks, settings, extension, resource URIs and view tools. Removed the catalog's ID-specific availability branches and `callTool` name dispatch.
- Plugin messages contain complete tool descriptions, enabled state, resources and view-only flags. Persisted per-tool switches update the real Harness registry for the next resolution. View calls require the declared plugin and pass the same switches.
- Added persisted owner preferences, initial/live `prefs` messages, and a preferences prompt section. Added title/message search across branches and authenticated password rotation with current-password verification, fresh cookie and revocation of older sessions.
- Tests: `npm run check:server` passed, 43 tests, 0 skipped. New tests exercise real SQLite, conversation tool resolution, actual artifact files, preferences/search with the faux model, and password/session rotation.
- Protocol problems: none.
- Deviations and reasons: pi-durable's `search` export searches tool descriptions, not transcripts; conversation search therefore uses its public conversation/context API and orders matching trees by update time. This avoids depending on its private storage schema.

## B2 — Skills (N24, N25)

- Parse YAML front matter, including folded/multiline descriptions, license, compatibility, metadata and allowed-tools, against the [Agent Skills specification](https://agentskills.io/specification). Preserve the three Chinese built-in names; enforce standard installed names and matching folder names.
- Install one or more Skills from uploaded ZIPs or shallow HTTP(S) Git fetches with optional ref/path. Reject traversal, symlinks, special files, duplicate archive paths, excessive file counts and oversized content. Git runs on the host without credentials/global config/hooks or prompts; fetches have time and disk limits and scratch cleanup.
- Persist complete directory bytes and origin in SQLite and project enabled directories into `/data/skills`. Disabled Skills remain available through `skill.read`; enabling or restarting reconstructs their files. Added install/remove/read requests, complete file lists, license/origin, and `canInstall: true`.
- Tests: `npm run check:server` passed, 46 tests, 0 skipped. Added ZIP byte preservation, nested files, YAML parsing, restart/switch/remove, invalid-source rejection, and a real shallow Git HTTP fetch selecting an unmodified Skill. The Git fixture serves this repository read-only; temporary downloads stay under repository-local `data/` and are removed.
- Protocol problems: `SkillInfo` has no compatibility/metadata/allowed-tools fields; they are preserved in `SKILL.md` and in server metadata, accessible through `skill.read`, without changing the contract.
- Deviations and reasons: SQLite retains installed file bytes so disabled directories can be removed from model discovery and reconstructed reliably after restart, while read/remove continue to work. Git installation accepts credential-free HTTP(S) URLs; SSH/local-file transports are excluded to prevent ambient host credentials and out-of-tree access.

## B3 — MCP (N20–N23)

- Added the official `@modelcontextprotocol/sdk` Streamable HTTP client, pinned to 1.32.2. Runtime MCP declarations share built-in plugin switches, per-tool controls, catalog messages and next-turn Harness selection.
- Added add/update/remove/reconnect/auth requests, encrypted request headers and OAuth data, server status/reasons, paginated tools/list, tool-list notifications, health checks and exponential reconnection. Unavailable servers leave the next model resolution; recovered servers return automatically.
- Namespaced MCP tools; more than 20 tools use pi-durable `deferred` and the real `tool_search` extension. Model calls preserve text/image blocks and structured results; browser calls follow `ToolCallResult` and reject other servers' tools.
- Added declared `ui://` reads restricted to `text/html;profile=mcp-app`, including resource CSP/border metadata. Added OAuth discovery, dynamic client registration, PKCE, encrypted tokens/verifier, expiring single-use state, and `/api/mcp/callback`. See the [official client documentation](https://ts.sdk.modelcontextprotocol.io/client).
- Tests: `npm run check:server` passed, 48 tests, 0 skipped. Local HTTP protocol servers cover initialization, deferred search/model execution, resource MIME/CSP, tool isolation/switches, outage and automatic recovery, encrypted headers/restart, and real OAuth discovery/registration/token exchange with PKCE and callback replay rejection.
- Protocol problems: none blocking. OAuth requires `PUBLIC_URL` plus `TOKEN_ENCRYPTION_KEY`; the fixed requests expose no manual client-registration fields, so this implementation uses servers' dynamic registration support.
- Deviations and reasons: health checks use tools/list on the existing connection (and process list-change notifications), which also refreshes the catalog. SDK authentication and its default same-origin redirect policy are retained rather than implementing another OAuth stack.
