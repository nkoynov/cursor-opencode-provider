# Changelog

## [Unreleased]

### Fixed

- Background shells keep their output reachable: a command Cursor starts in the background, or a foreground one that outlives its wait, writes Cursor's terminal file (`<terminals_folder>/<shell id>.txt`, with Cursor CLI's header and exit footer), and the provider answers Cursor's reads of it, so `AwaitShell` and the model see the output and exit code instead of "No shell found". Such a command that ends within its wait now reports its real exit code under bash ([#N](https://github.com/oakimov/cursor-opencode-provider/pull/N) by [@nkoynov](https://github.com/nkoynov))
- An MCP call to OpenCode 2's `shell` keeps its `background` flag ([#N](https://github.com/oakimov/cursor-opencode-provider/pull/N) by [@nkoynov](https://github.com/nkoynov))

## [0.8.0] - 2026-10-04

### Changed

- Host system context is delivered as a single always-apply rule; the provider no longer rediscovers local `AGENTS.md`, skills, or agent files for Cursor `RequestContext` ([#37](https://github.com/oakimov/cursor-opencode-provider/pull/37))
- RequestContext tool overlay is names-only; full tool definitions are answered from the live host catalog on exec #36 ([#37](https://github.com/oakimov/cursor-opencode-provider/pull/37))

### Fixed

- Cursor browser-login and API-key credentials renew the same way Cursor's own clients do, so long sessions stop failing after token expiry ([#35](https://github.com/oakimov/cursor-opencode-provider/issues/35))
- Cursor conversations stay consistent across OpenCode 2.x subagents, model switches, and host mid-turn notes instead of superseding the held Run or losing tool continuations ([#34](https://github.com/oakimov/cursor-opencode-provider/pull/34))
- Recovered RequestContext and standalone tool catalogs survive restart and lifecycle turns without dropping MCP/tool state

Prior releases before the changelog was introduced are available via git tags (`v0.7.6`, `v0.7.5`, …).
