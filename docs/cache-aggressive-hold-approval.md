# Cache aggressiveness — approval list

Status: **approved & implemented**  
Repo: `cursor-opencode-provider`  
CLI evidence: decompiled Cursor CLI 2026.09.28 (local evidence retained privately)
Related: [`cache-log-runbook.md`](./cache-log-runbook.md)

## Checklist

| # | Item | Decision | Status |
|---|---|---|---|
| 1 | Delete all system-prompt remint paths | Full removal | **Done** |
| 2 | Extra overlay freeze | Already done | **No change** |
| 3 | Agent-change remint | **Remove** (match CLI) | **Done** |
| 4 | Harden fresh-turn hold | Cap skips held-pending; refuse mid-pending supersede | **Done** |
| 5 | Hydrate / binding — CLI-shaped | Soft-evict; keep state + lastBound; disk hydrate on miss | **Done** |
| 6 | Never remint incomplete/oversized graph | Warm reuse + warn | **Done** |

Compaction and post-compaction rebase still rotate the conversation; they transfer
the stable workspace base. This is a design decision record, not a fresh live
acceptance result. Source guards: [`resolveTurnConversationReset`](../src/language-model.ts),
[`admitContextEpoch`](../src/context/epoch.ts), [frozen-context tests](../test/frozen-request-context.test.ts)
and the [cache runbook](cache-log-runbook.md).

## Locked decisions

- **3:** No remint on `hostAgent` flip.
- **5:** Soft-evict active map only; keep checkpoint/blobs/frozen + lastBound; `hydrateConversationState` for process restart (CLI `resetFromDb`).
- **1 + 6:** As previously approved.
