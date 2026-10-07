# Changelog

## [Unreleased]

### Fixed

- Cursor models no longer call OpenCode tools by their own names as top-level tools, which Cursor refuses with "Tool not found" (seen with MCP tools and `execute`). The system guidance called every advertised tool a direct tool to call by name, but Cursor's top-level list has only its own tools plus GetDynamicTools / CallDynamicTool. It now lists which host tools Cursor's native tools run (`read` through Read, `edit` through StrReplace, …) and which are called through CallDynamicTool, with the namespace and tool name from Cursor's catalog

## [0.8.0] - 2026-10-04

### Changed

- Host system context is delivered as a single always-apply rule; the provider no longer rediscovers local `AGENTS.md`, skills, or agent files for Cursor `RequestContext` ([#37](https://github.com/oakimov/cursor-opencode-provider/pull/37))
- RequestContext tool overlay is names-only; full tool definitions are answered from the live host catalog on exec #36 ([#37](https://github.com/oakimov/cursor-opencode-provider/pull/37))

### Fixed

- Cursor browser-login and API-key credentials renew the same way Cursor's own clients do, so long sessions stop failing after token expiry ([#35](https://github.com/oakimov/cursor-opencode-provider/issues/35))
- Cursor conversations stay consistent across OpenCode 2.x subagents, model switches, and host mid-turn notes instead of superseding the held Run or losing tool continuations ([#34](https://github.com/oakimov/cursor-opencode-provider/pull/34))
- Recovered RequestContext and standalone tool catalogs survive restart and lifecycle turns without dropping MCP/tool state

Prior releases before the changelog was introduced are available via git tags (`v0.7.6`, `v0.7.5`, …).
