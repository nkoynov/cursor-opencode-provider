import { trace } from "./debug.js"
import type { CursorSession } from "./session.js"

/** A turn whose Run failed before Cursor stored a checkpoint, so Cursor's conversation never received its request. */
type LostTurn = { conversationId: string; base: Uint8Array; requests: string[] }

const MAX_LOST_TURNS = 256
const lostTurns = new Map<string, LostTurn>()

function sameBytes(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * Cursor stores a turn's first checkpoint only once the turn's first model step ends. A Run that fails
 * before that leaves the conversation on the checkpoint the request was sent on, without the request;
 * Cursor CLI then sends the same request again, so the host's retry of this turn has to carry it.
 */
export function noteFailedTurn(session: CursorSession): void {
  const key = session.openCodeSessionId
  if (!key) return
  lostTurns.delete(key)
  const base = session.requestBase
  const requests = session.turnRequests ?? []
  if (!base || (session.resumeCheckpoint && !sameBytes(session.resumeCheckpoint, base))) return
  if (requests.every((request) => !request || request === ".")) return
  lostTurns.set(key, { conversationId: session.conversationId, base, requests })
  for (const oldest of lostTurns.keys()) {
    if (lostTurns.size <= MAX_LOST_TURNS) break
    lostTurns.delete(oldest)
  }
  trace(
    `lost turn: sessionKey=${key} conversationId=${session.conversationId} requests=${requests.length} ` +
      `— the Run failed before Cursor checkpointed the request`,
  )
}

/**
 * The requests of the session's failed turn when the next Run starts from the checkpoint they were sent on.
 * The record stays until the conversation moves past that checkpoint, so a Run that fails to open loses nothing.
 */
export function lostRequestsFor(
  sessionKey: string,
  conversationId: string,
  checkpoint: Uint8Array | undefined,
): string[] | undefined {
  const lost = lostTurns.get(sessionKey)
  if (!lost) return undefined
  if (lost.conversationId === conversationId && sameBytes(lost.base, checkpoint)) return lost.requests
  lostTurns.delete(sessionKey)
  return undefined
}

/** The user stopped the session: a request it lost stays dropped. */
export function forgetLostTurn(sessionKey: string): void {
  if (lostTurns.delete(sessionKey)) trace(`lost turn: dropped for sessionKey=${sessionKey} — the host stopped the session`)
}

/** The lost requests, then the live one unless it repeats one of them (a plain retry of the same prompt). */
export function withLostRequests(requests: readonly string[], live: string): string[] {
  const all = requests.filter((request) => request && request !== ".")
  if (live && live !== "." && !all.includes(live)) all.push(live)
  return all
}

export function resetLostTurnsForTests(): void {
  lostTurns.clear()
}
