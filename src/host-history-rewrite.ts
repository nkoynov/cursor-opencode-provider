import path from "node:path"
import { processShared } from "./process-shared.js"
import { getPersistedConversation, persistConversation } from "./protocol/conversation-persistence.js"

// Locations and the provider can load separate module graphs. The write lane
// also fences a late TurnEnded/shutdown save against a committed host rewrite.
type Rewrite = { eventID: string; pending: boolean; durable: boolean; saving?: Promise<void> }
const state = processShared("host-history-rewrite.v1", () => ({
  rewrites: new Map<string, Rewrite>(),
  writes: new Map<string, Promise<void>>(),
}))
const keyFor = (cacheDir: string, sessionKey: string) => JSON.stringify([path.resolve(cacheDir), sessionKey])

export function queueConversationStateWrite(
  cacheDir: string, sessionKey: string, write: () => Promise<void>,
): Promise<void> {
  const key = keyFor(cacheDir, sessionKey)
  const next = (state.writes.get(key) ?? Promise.resolve()).catch(() => {}).then(write)
  state.writes.set(key, next)
  void next.finally(() => {
    if (state.writes.get(key) === next) state.writes.delete(key)
  }).catch(() => {})
  return next
}

export function hasHostHistoryRewrite(cacheDir: string, sessionKey: string): boolean {
  return state.rewrites.get(keyFor(cacheDir, sessionKey))?.pending === true
}

function saveRewrite(cacheDir: string, sessionKey: string, rewrite: Rewrite): Promise<void> {
  if (rewrite.durable) return Promise.resolve()
  return rewrite.saving ??= queueConversationStateWrite(cacheDir, sessionKey, async () => {
    const saved = await getPersistedConversation(cacheDir, sessionKey)
    // With no saved Cursor state, restart already starts from host history.
    // Do not manufacture an incomplete frozen RequestContext as a tombstone.
    // Any later held-Run save is serialized here and carries the pending flag.
    if (saved) await persistConversation(cacheDir, { ...saved, postCompactionRebase: true })
    rewrite.durable = true
  }).finally(() => { rewrite.saving = undefined })
}

/** Only a committed compaction event calls this; preparing a summary does not. */
export function noteHostHistoryRewrite(cacheDir: string, sessionKey: string, eventID: string): Promise<void> {
  const key = keyFor(cacheDir, sessionKey)
  let rewrite = state.rewrites.get(key)
  if (!rewrite || rewrite.eventID !== eventID) {
    rewrite = { eventID, pending: true, durable: false }
    state.rewrites.set(key, rewrite)
  }
  return saveRewrite(cacheDir, sessionKey, rewrite)
}

/** Await the durable receipt; a failed save is retried by the next request. */
export async function awaitHostHistoryRewrite(cacheDir: string, sessionKey: string): Promise<boolean> {
  const rewrite = state.rewrites.get(keyFor(cacheDir, sessionKey))
  if (!rewrite?.pending) return false
  await saveRewrite(cacheDir, sessionKey, rewrite)
  return true
}

/** Consume only after the provider has replaced the old conversation binding. */
export function acknowledgeHostHistoryRewrite(cacheDir: string, sessionKey: string): void {
  const rewrite = state.rewrites.get(keyFor(cacheDir, sessionKey))
  if (rewrite) rewrite.pending = false
}

export function resetHostHistoryRewritesForTests(): void {
  state.rewrites.clear()
  state.writes.clear()
}
