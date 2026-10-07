// OpenCode 2 promotes a steer only at a step boundary, which a Cursor-side wait (AwaitShell) lacks.
export type HostSteer = { sessionID: string; inboxID: string; text: string }

export type EarlySteer = HostSteer & {
  injectionId: string
  conversationId: string
  /** The Run that took it reached `turn_ended`, so the model has answered it. */
  answered: boolean
}

type HostSteerState = {
  listeners: Map<string, (steer: HostSteer) => boolean>
  injected: Map<string, EarlySteer[]>
  /** Answered steers OpenCode promoted after the reply, ended by an empty step: they open the next user turn. */
  settled?: Map<string, EarlySteer[]>
  queued: Map<string, HostSteer>
  announced: Set<string>
}

const MAX_RECORDS_PER_SESSION = 32
const MAX_REMEMBERED = 256

// The plugin and the model can be separate copies of this module, and each plugin copy sees every event.
const HOST_STEERS = Symbol.for("cursor-opencode-provider.host-steers")
const globals = globalThis as typeof globalThis & { [HOST_STEERS]?: HostSteerState }
const state: HostSteerState = globals[HOST_STEERS] ??= {
  listeners: new Map(),
  injected: new Map(),
  queued: new Map(),
  announced: new Set(),
}
const settled = state.settled ??= new Map()

function remember<K>(entries: Map<K, unknown> | Set<K>, key: K): void {
  while (entries.size > MAX_REMEMBERED) {
    const oldest = entries.keys().next().value as K | undefined
    if (oldest === undefined || oldest === key) break
    entries.delete(oldest)
  }
}

/** undefined when another plugin copy already announced the steer. */
export function announceHostSteer(steer: HostSteer): boolean | undefined {
  state.queued.delete(steer.inboxID)
  if (state.announced.has(steer.inboxID)) return undefined
  state.announced.add(steer.inboxID)
  remember(state.announced, steer.inboxID)
  const listener = state.listeners.get(steer.sessionID)
  return listener ? listener(steer) : false
}

/** Remember a queued message, so a later switch to `steer` can announce it. */
export function rememberQueuedSteer(steer: HostSteer): void {
  if (state.announced.has(steer.inboxID)) return
  state.queued.delete(steer.inboxID)
  state.queued.set(steer.inboxID, steer)
  remember(state.queued, steer.inboxID)
}

export function takeQueuedSteer(inboxID: string): HostSteer | undefined {
  const steer = state.queued.get(inboxID)
  state.queued.delete(inboxID)
  return steer
}

export function forgetQueuedSteer(inboxID: string): void {
  state.queued.delete(inboxID)
}

export function listenForHostSteers(sessionID: string, listener: (steer: HostSteer) => boolean): () => void {
  state.listeners.set(sessionID, listener)
  return () => {
    if (state.listeners.get(sessionID) === listener) state.listeners.delete(sessionID)
  }
}

export function recordEarlySteer(steer: EarlySteer): void {
  const records = state.injected.get(steer.sessionID) ?? []
  records.push(steer)
  while (records.length > MAX_RECORDS_PER_SESSION) records.shift()
  state.injected.set(steer.sessionID, records)
}

export function markEarlySteersAnswered(sessionID: string | undefined, injectionIds: Iterable<string>): void {
  if (!sessionID) return
  const ids = new Set(injectionIds)
  for (const record of state.injected.get(sessionID) ?? []) {
    if (ids.has(record.injectionId)) record.answered = true
  }
}

/** The text of a promoted user message; the host may append its own parts before or after it. */
function carries(message: string, text: string): boolean {
  return message === text
    || message.startsWith(`${text}\n`)
    || message.endsWith(`\n${text}`)
    || message.includes(`\n${text}\n`)
}

/** With `all`, nothing is consumed unless every message was injected. */
export function takeEarlySteers(
  sessionID: string | undefined,
  messages: readonly string[],
  accept: (record: EarlySteer) => boolean,
  all = false,
): { remaining: string[]; taken: EarlySteer[] } {
  const records = sessionID ? state.injected.get(sessionID) : undefined
  if (!records?.length) return { remaining: [...messages], taken: [] }
  const candidates = [...records]
  const remaining: string[] = []
  const taken: EarlySteer[] = []
  for (const message of messages) {
    const index = candidates.findIndex((record) => accept(record) && carries(message, record.text))
    if (index === -1) remaining.push(message)
    else taken.push(...candidates.splice(index, 1))
  }
  if (all && remaining.length > 0) return { remaining: [...messages], taken: [] }
  if (candidates.length === 0) state.injected.delete(sessionID!)
  else state.injected.set(sessionID!, candidates)
  return { remaining, taken }
}

export function settleEarlySteers(sessionID: string, steers: readonly EarlySteer[]): void {
  settled.set(sessionID, [...(settled.get(sessionID) ?? []), ...steers].slice(-MAX_RECORDS_PER_SESSION))
}

/** Indices of the messages that carry a steer the model already answered, each matched once; forgets the settled ones. */
export function takeAnsweredEarlySteers(
  sessionID: string | undefined,
  messages: ReadonlyArray<string | undefined>,
): Set<number> {
  const indices = new Set<number>()
  if (!sessionID) return indices
  const candidates = [
    ...(settled.get(sessionID) ?? []),
    ...(state.injected.get(sessionID) ?? []).filter((record) => record.answered),
  ]
  settled.delete(sessionID)
  messages.forEach((message, index) => {
    if (message === undefined) return
    const match = candidates.findIndex((record) => carries(message, record.text))
    if (match === -1) return
    candidates.splice(match, 1)
    indices.add(index)
  })
  return indices
}

/** A new user turn began, so no message injected before it can still come back. */
export function clearEarlySteers(sessionID: string | undefined): void {
  if (sessionID) state.injected.delete(sessionID)
}

export function forgetEarlySteers(sessionID: string): void {
  state.injected.delete(sessionID)
  settled.delete(sessionID)
  state.listeners.delete(sessionID)
}
