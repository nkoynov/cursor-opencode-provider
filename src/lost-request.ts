import { createHash } from "node:crypto"
import { processShared } from "./process-shared.js"

export type LostRequest = {
  conversationId: string
  checkpointKey: string
  /** Everything Cursor has not checkpointed, as the last attempt sent it. */
  text: string
  /** That attempt's own live text, before anything was prepended. */
  latest: string
}

const MAX_RECORDS = 1_024

const records = () => processShared("lost-request.v2", () => new Map<string, LostRequest>())

export function checkpointKey(bytes: Uint8Array | undefined): string {
  if (!bytes?.length) return "none"
  return createHash("sha256").update(bytes).digest("hex")
}

/**
 * Prepend a user message whose Run never received a newer checkpoint.
 * A history rebuild already contains it, so that path drops the record.
 * A retry is the previous attempt's live text again: it sends what that
 * attempt sent. A host that sends the same note before every attempt must not
 * pile it up. Any other text is a new request and is appended, even when it
 * repeats an older one (red, blue, then red again).
 */
export function carryLostRequest(input: {
  sessionKey: string
  conversationId: string
  checkpoint: Uint8Array | undefined
  text: string
  rebuildFromHistory: boolean
}): string {
  const map = records()
  const record = map.get(input.sessionKey)
  if (!record) return input.text
  const key = checkpointKey(input.checkpoint)
  if (
    input.rebuildFromHistory
    || record.conversationId !== input.conversationId
    || record.checkpointKey !== key
  ) {
    map.delete(input.sessionKey)
    return input.text
  }
  if (input.text === record.latest) return record.text
  // The host already resends the lost text ahead of this one (OpenCode 1.x
  // merges user messages left without a reply into one live turn).
  if (input.text === record.text || input.text.startsWith(`${record.text}\n\n`)) return input.text
  map.delete(input.sessionKey)
  return `${record.text}\n\n${input.text}`
}

/** `text` is what this turn sends; `latest` is its own live text (defaults to `text`). */
export function rememberLostRequest(input: {
  sessionKey: string
  conversationId: string
  checkpoint: Uint8Array | undefined
  text: string
  latest?: string
}): void {
  if (!input.sessionKey || !input.text || input.text === ".") return
  setRecord(input.sessionKey, {
    conversationId: input.conversationId,
    checkpointKey: checkpointKey(input.checkpoint),
    text: input.text,
    latest: input.latest ?? input.text,
  })
}

/** A session that never sends another turn must not keep its record forever. */
function setRecord(sessionKey: string, record: LostRequest): void {
  const map = records()
  map.delete(sessionKey)
  map.set(sessionKey, record)
  while (map.size > MAX_RECORDS) {
    const oldest = map.keys().next().value as string | undefined
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

/** A checkpoint other than the one this turn was sent on means Cursor kept the turn. */
export function noteCheckpoint(sessionKey: string | undefined, bytes: Uint8Array): void {
  if (!sessionKey) return
  const map = records()
  const record = map.get(sessionKey)
  if (!record) return
  if (checkpointKey(bytes) !== record.checkpointKey) map.delete(sessionKey)
}

export function peekLostRequest(sessionKey: string): Readonly<LostRequest> | undefined {
  return records().get(sessionKey)
}

export function hasLostRequest(sessionKey: string | undefined): boolean {
  return !!sessionKey && records().has(sessionKey)
}

export function dropLostRequest(sessionKey: string | undefined): void {
  if (sessionKey) records().delete(sessionKey)
}

export function serializeLostRequest(sessionKey: string | undefined): string | undefined {
  if (!sessionKey) return undefined
  const record = records().get(sessionKey)
  return record ? JSON.stringify(record) : undefined
}

export function restoreLostRequest(sessionKey: string, raw: string | undefined): void {
  if (!raw || records().has(sessionKey)) return
  let parsed: Partial<LostRequest>
  try {
    parsed = JSON.parse(raw) as Partial<LostRequest>
  } catch {
    return
  }
  if (
    typeof parsed.conversationId !== "string"
    || typeof parsed.checkpointKey !== "string"
    || typeof parsed.text !== "string"
    || parsed.text.length === 0
    || (parsed.latest !== undefined && typeof parsed.latest !== "string")
  ) return
  setRecord(sessionKey, {
    conversationId: parsed.conversationId,
    checkpointKey: parsed.checkpointKey,
    text: parsed.text,
    latest: parsed.latest ?? parsed.text,
  })
}

export function resetLostRequestsForTests(): void {
  records().clear()
}
