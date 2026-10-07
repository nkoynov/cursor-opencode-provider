# Contributing to cursor-opencode-provider

> [!IMPORTANT]
> Due to an increased number of pull requests, and because the project is currently going through a **major architectural redesign**, this repository is **temporarily not accepting new PRs** from the public. Only **invited collaborators** can open pull requests right now.
>
> Want to contribute anyway?
>
> - **Ideas** → [GitHub Discussions → Ideas](https://github.com/oakimov/cursor-opencode-provider/discussions/categories/ideas)
> - **Bugs** → [GitHub issues](https://github.com/oakimov/cursor-opencode-provider/issues)

## Before you write code

Post an [idea](https://github.com/oakimov/cursor-opencode-provider/discussions/categories/ideas) first (and wait for maintainer direction) for new features, public API or config changes, auth/transport/protocol behavior, broad refactors, or dependency bumps. Bugs go to [issues](https://github.com/oakimov/cursor-opencode-provider/issues) — see below.

Security vulnerabilities: use GitHub's private [vulnerability reporting form](https://github.com/oakimov/cursor-opencode-provider/security/advisories/new) — do not open a public issue, discussion, or PR. See [SECURITY.md](./SECURITY.md).

Host-specific work for other coding agents belongs in [OCP](https://github.com/oakimov/opencode-plugin-compat), not here. This package stays OpenCode-only and host-neutral; see [AGENTS.md](./AGENTS.md).

## Bug reports

Every bug issue must include:

- Clear **reproduction steps** (host, plugin entrypoint, what you did, what you expected, what happened)
- Which **model** was used (Cursor model id as shown in the host)
- Provider debug logs from a reproduction with `CURSOR_PROVIDER_DEBUG=1` (optional `CURSOR_PROVIDER_DEBUG_FILE`; default path is under `$TMPDIR/cursor-provider-logs-<uid>/` — see [README](./README.md))
- Relevant **host logs** from the same reproduction

Prefer, but do not require, relevant excerpts from the session transcript that show the failure.

Issues without reproduction steps, model, or debug/host logs will be closed.

## Development (invited collaborators)

```bash
bun install
bun run build
bun run typecheck
bun test
```

Full commands, architecture, and release rules: [AGENTS.md](./AGENTS.md). Install and operator docs: [README.md](./README.md).

## Pull requests

During the freeze, only invited collaborators should open PRs. We strive for exceptional quality and consistency — mass-produced slop is not welcome. Keep at most **3 open PRs** per contributor at a time.

When opening one:

- Keep it small and focused on one problem.
- Explain the problem and fix in your own words; say how you verified it.
- If the PR changes behavior or how models treat something, include **A/B testing results** (before vs after, models tried, what improved or regressed).
- **New features must follow OpenCode's security, sandbox, and permission model.** If OpenCode does not provide acceptable footing for a Cursor capability, mimic Cursor CLI's own client-side restrictions instead — and explain that choice and the permission/sandbox path in the PR.
- Link `Fixes #123` / `Closes #123` when applicable.
- Update [CHANGELOG.md](./CHANGELOG.md) under `## [Unreleased]` for user-facing changes.
- Prefer conventional-commit titles (`fix:`, `docs:`, `test:`, …).
- Long AI-generated PR descriptions are not acceptable.
- **Bug fixes must not regress prompt caching** — confirm RequestContext / checkpoint continuity stays warm where it should (see `cache diagnosis:` lines in `CURSOR_PROVIDER_DEBUG` logs and [docs/cache-log-runbook.md](./docs/cache-log-runbook.md)).
- **Consider both OpenCode 1.x and OpenCode 2.0** for every fix — apply or verify the change on both majors unless the bug is specific to one entrypoint.

## License

Contributions are licensed under the [MIT License](./LICENSE). See also [DISCLAIMER.md](./DISCLAIMER.md).
