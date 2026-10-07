# Changelog

## [Unreleased]

### Fixed

- A message OpenCode queues right before or after the user's own one (a finished background shell, subagent or task, a `<system-update>`) no longer replaces it: a Run sends every user message since the model's last reply, in OpenCode's order, where it sent only the last one, so on a Run with a Cursor checkpoint the user's question or the host note was lost, and without one the question was replayed as history while the note became the request ([#61](https://github.com/oakimov/cursor-opencode-provider/pull/61) by [@nkoynov](https://github.com/nkoynov))

## [0.8.0] - 2026-10-04

### Changed

- Host system context is delivered as a single always-apply rule; the provider no longer rediscovers local `AGENTS.md`, skills, or agent files for Cursor `RequestContext` ([#37](https://github.com/oakimov/cursor-opencode-provider/pull/37))
- RequestContext tool overlay is names-only; full tool definitions are answered from the live host catalog on exec #36 ([#37](https://github.com/oakimov/cursor-opencode-provider/pull/37))

### Fixed

- Cursor browser-login and API-key credentials renew the same way Cursor's own clients do, so long sessions stop failing after token expiry ([#35](https://github.com/oakimov/cursor-opencode-provider/issues/35))
- Cursor conversations stay consistent across OpenCode 2.x subagents, model switches, and host mid-turn notes instead of superseding the held Run or losing tool continuations ([#34](https://github.com/oakimov/cursor-opencode-provider/pull/34))
- Recovered RequestContext and standalone tool catalogs survive restart and lifecycle turns without dropping MCP/tool state

Prior releases before the changelog was introduced are available via git tags (`v0.7.6`, `v0.7.5`, …).
