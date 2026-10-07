# Changelog

## [Unreleased]

### Fixed

- A Run without a Cursor checkpoint (after a restart, a lost Run, a foreign-history or history-rewrite rebase) keeps the host system context, subagents and MCP instructions, and replays earlier tool calls with their results: prior turns now open the user message instead of replacing Cursor's root prompt, where they dropped the rules for the rest of the conversation and the model took its own earlier work for undone. When such a history would fill more than 80% of the model's context, the provider asks OpenCode to compact first, as a foreign-history rebase already did ([#60](https://github.com/oakimov/cursor-opencode-provider/pull/60) by [@nkoynov](https://github.com/nkoynov))

## [0.8.0] - 2026-10-04

### Changed

- Host system context is delivered as a single always-apply rule; the provider no longer rediscovers local `AGENTS.md`, skills, or agent files for Cursor `RequestContext` ([#37](https://github.com/oakimov/cursor-opencode-provider/pull/37))
- RequestContext tool overlay is names-only; full tool definitions are answered from the live host catalog on exec #36 ([#37](https://github.com/oakimov/cursor-opencode-provider/pull/37))

### Fixed

- Cursor browser-login and API-key credentials renew the same way Cursor's own clients do, so long sessions stop failing after token expiry ([#35](https://github.com/oakimov/cursor-opencode-provider/issues/35))
- Cursor conversations stay consistent across OpenCode 2.x subagents, model switches, and host mid-turn notes instead of superseding the held Run or losing tool continuations ([#34](https://github.com/oakimov/cursor-opencode-provider/pull/34))
- Recovered RequestContext and standalone tool catalogs survive restart and lifecycle turns without dropping MCP/tool state

Prior releases before the changelog was introduced are available via git tags (`v0.7.6`, `v0.7.5`, …).
