import { randomUUID } from "node:crypto"
import path from "node:path"
import {
  hasHostHistoryRewrite,
  isLastConversationStateWrite,
  queueConversationStateWrite,
  settleConversationStateWrites,
} from "../host-history-rewrite.js"
import { processShared } from "../process-shared.js"
import { trace } from "../debug.js"
import { restoreEarlySteers, serializeEarlySteers } from "../host-steer.js"
import { restoreLostRequest, serializeLostRequest } from "../lost-request.js"
import { restorePlanOperations, serializePlanOperations } from "./plan-operations.js"
import {
  clearFrozenRequestContext,
  getFrozenRequestContext,
  setFrozenRequestContext,
  transferFrozenRequestContext,
} from "../context/frozen.js"
import { attachContextEpoch, detachContextEpoch, type ContextEpoch } from "../context/epoch.js"
import {
  boundConversationId,
  isActiveConversationBinding,
  MAX_ACTIVE_CONVERSATION_BINDINGS,
  restoreConversationBinding,
  sessionIdToUuid,
} from "./conversation-bind.js"
import {
  clearConversationBlobs,
  compactConversationBlobs,
  restoreConversationBlobs,
  snapshotConversationBlobs,
} from "./blob-store.js"
import { clearCheckpoint, getCheckpoint, getCheckpointOccupancy, restoreCheckpointOccupancy, setCheckpoint,
  restoreCheckpointOccupancyGuard, serializeCheckpointOccupancyGuard } from "./checkpoint.js"
import type { OpencodeToolDef } from "./tools.js"
import {
  forgetTurnProvenance,
  getTurnProvenance,
  parseTurnProvenance,
  rebindTurnProvenance,
  restoreTurnProvenance,
  serializeTurnProvenance,
} from "./turn-provenance.js"
import {
  heldHistoryImagesSnapshot,
  rebindHeldHistoryImages,
  restoreHeldHistoryImages,
} from "./sent-history-images.js"
import { moveSessionEditsDenySent, restoreSessionEditsDenySent, sessionEditsDenySent } from "./session-edits.js"
import {
  deletePersistedConversation,
  discardPersistedConversation,
  forgetCachedConversation,
  getPersistedTurnProvenance,
  loadPersistedConversation,
  MAX_CONVERSATION_SNAPSHOT_BLOB_BYTES,
  persistConversation,
  type PersistedConversationLoad,
} from "./conversation-persistence.js"

// Every snapshot write or delete that lands gets a process-wide generation, and writes still queued are counted per
// module copy; each copy's entry in `held` is the generation it last wrote (landed or failed), restored or adopted.
// A record is evicted only once its session is unbound and no write or read is using it; up to the cap's worth whose
// latest save failed stay past it. Generations are never reused: a copy whose record was evicted counts as never having
// held one.
type SnapshotRecord = {
  sessionKey: string
  generation: number
  unsaved: boolean
  queued: Map<string, number>
  held: Map<string, number>
  reading: number
}
// A copy of an older build loaded in the same process (7d3650e) shares this map and creates records without the
// fields added since; it reads only generation, unsaved and queued.
type StoredRecord = Pick<SnapshotRecord, "generation" | "unsaved" | "queued"> & Partial<SnapshotRecord>
const copyId = randomUUID()
const snapshots: { next: number; bySession: Map<string, StoredRecord> } = processShared(
  "conversation-snapshot-generations.v1",
  () => ({ next: 0, bySession: new Map<string, StoredRecord>() }),
)
const snapshotKey = (cacheDir: string, sessionKey: string) => JSON.stringify([path.resolve(cacheDir), sessionKey])

function upgraded(key: string, record: StoredRecord): SnapshotRecord {
  record.sessionKey ??= (JSON.parse(key) as [string, string])[1]
  record.held ??= new Map()
  record.reading ??= 0
  return record as SnapshotRecord
}

function existingRecord(key: string): SnapshotRecord | undefined {
  const record = snapshots.bySession.get(key)
  return record && upgraded(key, record)
}

function snapshotRecord(key: string, sessionKey: string): SnapshotRecord {
  let record = existingRecord(key)
  if (!record) {
    record = { sessionKey, generation: ++snapshots.next, unsaved: false, queued: new Map(), held: new Map(), reading: 0 }
    snapshots.bySession.set(key, record)
    pruneSnapshotRecords(key)
  }
  return record
}

function pruneSnapshotRecords(keep?: string): void {
  if (snapshots.bySession.size <= MAX_ACTIVE_CONVERSATION_BINDINGS) return
  const idle = [...snapshots.bySession].map(([key, stored]) => [key, upgraded(key, stored)] as const)
    .filter(([key, record]) => key !== keep && record.queued.size === 0
      && record.reading === 0 && boundConversationId(record.sessionKey) === undefined)
  // A failed save's record keeps copies behind off the older snapshot on disk, also once the binding is gone.
  let spareFailed = idle.filter(([, record]) => record.unsaved).length - MAX_ACTIVE_CONVERSATION_BINDINGS
  for (const [key, record] of idle) {
    if (snapshots.bySession.size <= MAX_ACTIVE_CONVERSATION_BINDINGS) return
    if (record.unsaved && spareFailed-- <= 0) continue
    snapshots.bySession.delete(key)
  }
}

function heldGeneration(key: string): number | undefined {
  return existingRecord(key)?.held.get(copyId)
}

function holdsLatestSnapshot(key: string): boolean {
  const record = existingRecord(key)
  return !!record && record.held.get(copyId) === record.generation
}

function queuedWrite(key: string, otherCopiesOnly: boolean): boolean {
  for (const [copy, count] of snapshots.bySession.get(key)?.queued ?? []) {
    if (count > 0 && (!otherCopiesOnly || copy !== copyId)) return true
  }
  return false
}

/** Count a write from when it is requested; record whether it landed. A failed write leaves an older snapshot on disk. */
async function trackedSnapshotWrite(cacheDir: string, sessionKey: string, write: () => Promise<boolean>): Promise<void> {
  const record = snapshotRecord(snapshotKey(cacheDir, sessionKey), sessionKey)
  record.queued.set(copyId, (record.queued.get(copyId) ?? 0) + 1)
  try {
    if (!await write()) return
    record.generation = ++snapshots.next
    record.unsaved = false
    record.held.set(copyId, record.generation)
  } catch (error) {
    // The disk misses this state, but this copy's memory still holds it.
    record.generation = ++snapshots.next
    record.unsaved = true
    record.held.set(copyId, record.generation)
    throw error
  } finally {
    const left = (record.queued.get(copyId) ?? 1) - 1
    if (left > 0) record.queued.set(copyId, left)
    else record.queued.delete(copyId)
    // Records skipped while queued would otherwise stay past the cap until another record is created.
    pruneSnapshotRecords()
  }
}

const copyStateResets: Array<(sessionKey: string) => void> = []

/** Per-session state this module copy keeps elsewhere, dropped when it accepts a newer state from disk. */
export function onCopyStateReplaced(reset: (sessionKey: string) => void): void {
  copyStateResets.push(reset)
}

/**
 * A copy behind the latest state replaces its per-session state with what it could read: a snapshot, or nothing.
 * A copy that served the session before holds a checkpoint without the turns another copy ran since, so without a
 * snapshot to restore it drops that checkpoint and its next Run seeds host history. A copy that never held a
 * generation has no older checkpoint of its own, unless its record was evicted since: so while another copy holds
 * newer state (its save failed, or its writes keep landing), or another copy holds the latest generation (it wrote,
 * restored or adopted it, also without a snapshot) and that snapshot is now unreadable or gone, every copy behind
 * drops its checkpoint.
 */
function replaceCopyState(
  key: string, generation: number, sessionKey: string, conversationId: string, newerElsewhere = false,
): void {
  const record = snapshotRecord(key, sessionKey)
  const servedBefore = record.held.has(copyId)
  const heldElsewhere = [...record.held].some(([copy, held]) => copy !== copyId && held === record.generation)
  record.held.set(copyId, generation)
  forgetTurnProvenance(sessionKey)
  for (const reset of copyStateResets) reset(sessionKey)
  if (servedBefore || newerElsewhere || heldElsewhere) clearCheckpoint(conversationId)
}

export function resetSnapshotGenerationsForTests(): void {
  snapshots.next = 0
  snapshots.bySession.clear()
  waitingSnapshotSaves.clear()
}

export function snapshotGenerationRecordsForTests(): number {
  return snapshots.bySession.size
}

/** Restore one OpenCode session before its conversation binding is resolved. */
export async function hydrateConversationState(
  cacheDir: string,
  sessionKey: string,
): Promise<{
  conversationId: string
  postCompactionRebase: boolean
  toolCatalog: OpencodeToolDef[]
  hostAgent?: string
  systemPromptHash?: string
  hostNote?: string
  modelFallbackStop?: string
  runHostNote?: string
  /** Another copy advanced this binding: the snapshot replaces this copy's per-session turn state. */
  replacesCopyState?: true
} | undefined> {
  // Bindings are process-shared but checkpoints and frozen contexts live per module copy (one per
  // Location): a copy behind the latest snapshot any copy saved restores it.
  const key = snapshotKey(cacheDir, sessionKey)
  const bound = boundConversationId(sessionKey)
  let generation = 0
  let loaded: PersistedConversationLoad | undefined
  // An unbound session binds its default conversation id next, which a checkpoint of this copy may still hold.
  const conversationId = bound ?? sessionIdToUuid(sessionKey)
  const entryCheckpoint = getCheckpoint(conversationId)
  // A concurrent request moved, created or evicted the binding meanwhile. Unless this copy holds the latest
  // generation, the checkpoint it started with may lack turns another copy ran; one set since is that request's own.
  const bindingMoved = (): boolean => {
    if (boundConversationId(sessionKey) === bound) return false
    if (!holdsLatestSnapshot(key) && getCheckpoint(conversationId) === entryCheckpoint) clearCheckpoint(conversationId)
    return true
  }
  for (let attempt = 0; attempt < 3 && !loaded; attempt++) {
    // This copy's own queued writes hold state no newer than its memory; another copy's may.
    if (bound !== undefined && attempt === 0 && holdsLatestSnapshot(key) && !queuedWrite(key, true)) return undefined
    await settleConversationStateWrites(cacheDir, sessionKey)
    // An unbound session still restores process-shared state an eviction may have dropped, unless the disk is behind.
    if (bound !== undefined && holdsLatestSnapshot(key)) return undefined
    if (snapshots.bySession.get(key)?.unsaved) {
      trace(`conversation persistence: hydration skipped sessionKey=${sessionKey} status=unsaved`)
      if (!bindingMoved() && !holdsLatestSnapshot(key)) {
        replaceCopyState(key, snapshotRecord(key, sessionKey).generation, sessionKey, conversationId, true)
      }
      return undefined
    }
    try {
      await forgetCachedConversation(cacheDir, sessionKey)
      const record = snapshotRecord(key, sessionKey)
      generation = record.generation
      record.reading++
      let read: PersistedConversationLoad
      try {
        read = await loadPersistedConversation(cacheDir, sessionKey)
      } finally {
        record.reading--
      }
      // A write that landed or was queued during the read, also this copy's own, may be newer than what was read.
      if (record.generation === generation && !queuedWrite(key, false)) loaded = read
    } catch (error) {
      // The caller logs I/O failures and continues from host history. Its older
      // checkpoint must not remain eligible, nor may this discard a checkpoint
      // a concurrent request received while the read was pending.
      if (!bindingMoved() && !holdsLatestSnapshot(key) && getCheckpoint(conversationId) === entryCheckpoint) {
        replaceCopyState(key, snapshotRecord(key, sessionKey).generation, sessionKey, conversationId, true)
      }
      throw error
    }
  }
  if (!loaded) {
    trace(`conversation persistence: hydration skipped sessionKey=${sessionKey} status=still-writing`)
    if (!bindingMoved()) {
      replaceCopyState(key, snapshotRecord(key, sessionKey).generation, sessionKey, conversationId, true)
    }
    return undefined
  }
  if (bindingMoved()) return undefined
  // A concurrent request in this copy already restored this generation.
  if (bound !== undefined && heldGeneration(key) === generation) return undefined
  // This copy was behind: what is on disk (a snapshot, or none after a delete) replaces its per-session state, also
  // once the binding, and maybe the record, were evicted but this copy's per-session state was not.
  const replacing = heldGeneration(key) !== generation
  if (replacing) {
    if (bound !== undefined) replaceCopyState(key, generation, sessionKey, bound)
    // No copy held a generation: state kept for a session this copy never ran (host notes before its first Run)
    // stays, but a checkpoint of the default conversation may lack turns another copy ran.
    else if (!loaded.value && snapshotRecord(key, sessionKey).held.size === 0) {
      clearCheckpoint(conversationId)
      snapshotRecord(key, sessionKey).held.set(copyId, generation)
    } else replaceCopyState(key, generation, sessionKey, loaded.value?.conversationId ?? conversationId, true)
  }
  const persisted = loaded.value
  if (!persisted) {
    trace(
      `conversation persistence: hydration skipped sessionKey=${sessionKey} ` +
        `status=${loaded.status}`,
    )
    return undefined
  }
  if (bound !== undefined) {
    const current = boundConversationId(sessionKey)
    if (current !== persisted.conversationId) {
      trace(
        `conversation persistence: hydration skipped sessionKey=${sessionKey} ` +
          `status=superseded bound=${current ?? "none"} saved=${persisted.conversationId}`,
      )
      return undefined
    }
  } else {
    restoreConversationBinding(sessionKey, persisted.conversationId)
    // Process-shared: another copy's live state is newer than the snapshot.
    restoreEarlySteers(sessionKey, persisted.earlySteers)
    restoreLostRequest(sessionKey, persisted.lostRequest)
    restorePlanOperations(sessionKey, persisted.planOperations)
  }
  // Snapshots written before this marker existed came from releases that never sent a deny.
  restoreSessionEditsDenySent(persisted.conversationId, persisted.sessionEditsDenySent === true, replacing)
  if (replacing) clearCheckpoint(persisted.conversationId)
  if (persisted.occupancyCheckpoint) restoreCheckpointOccupancy(persisted.conversationId, persisted.occupancyCheckpoint)
  restoreCheckpointOccupancyGuard(persisted.conversationId, persisted.occupancyGuard)
  if (persisted.checkpoint) setCheckpoint(persisted.conversationId, persisted.checkpoint)
  restoreConversationBlobs(persisted.conversationId, persisted.blobs)
  if (replacing) clearFrozenRequestContext(persisted.conversationId)
  setFrozenRequestContext(persisted.conversationId, persisted.requestContext)
  const provenance = persisted.turnProvenance ? parseTurnProvenance(persisted.turnProvenance) : undefined
  if (provenance?.conversationId === persisted.conversationId) restoreTurnProvenance(sessionKey, provenance)
  restoreHeldHistoryImages(sessionKey, persisted.conversationId, {
    checkpoint: persisted.sentImagesCheckpoint,
    hashes: persisted.sentImageHashes,
  })
  trace(
    `conversation persistence: restored sessionKey=${sessionKey} ` +
      `conversationId=${persisted.conversationId} checkpoint=${persisted.checkpoint?.length ?? 0}B ` +
      `blobs=${persisted.blobs.length} heldImages=${persisted.sentImageHashes?.length ?? 0}` +
      (bound !== undefined ? " binding=shared" : ""),
  )
  return {
    conversationId: persisted.conversationId,
    postCompactionRebase: persisted.postCompactionRebase,
    toolCatalog: structuredClone(persisted.toolCatalog),
    ...(persisted.hostAgent ? { hostAgent: persisted.hostAgent } : {}),
    ...(persisted.systemPromptHash ? { systemPromptHash: persisted.systemPromptHash } : {}),
    ...(persisted.hostNote ? { hostNote: persisted.hostNote } : {}),
    ...(persisted.modelFallbackStop ? { modelFallbackStop: persisted.modelFallbackStop } : {}),
    ...(persisted.runHostNote ? { runHostNote: persisted.runHostNote } : {}),
    ...(replacing ? { replacesCopyState: true as const } : {}),
  }
}

/** Restore only turn provenance when its in-memory entry was evicted. */
export async function hydrateTurnProvenance(cacheDir: string, sessionKey: string): Promise<void> {
  if (getTurnProvenance(sessionKey)) return
  // The disk misses the latest save, so its provenance predates the turns some copy holds.
  if (snapshots.bySession.get(snapshotKey(cacheDir, sessionKey))?.unsaved) return
  const persisted = await getPersistedTurnProvenance(cacheDir, sessionKey)
  if (!persisted) return
  const provenance = parseTurnProvenance(persisted.turnProvenance)
  if (provenance?.conversationId === persisted.conversationId) restoreTurnProvenance(sessionKey, provenance)
}

/**
 * Persist the resumable state at Cursor's TurnEnded, or before it
 * (`runInProgress`) so a Run the host interrupts, or a restart, resumes from
 * the latest checkpoint and still recognizes the step in progress.
 */
export async function persistConversationState(cacheDir: string, input: ConversationStateInput): Promise<void> {
  if (supersededTurnEnd(input)) return
  const key = snapshotKey(cacheDir, input.sessionKey)
  const waiting = waitingSnapshotSaves.get(key)
  if (waiting?.queued && isLastConversationStateWrite(cacheDir, input.sessionKey, waiting.queued)) {
    // Held by the slot only: no local of a waiting call keeps a replaced capture alive.
    waiting.save = captureSnapshotSave(cacheDir, input)
    trace(`conversation persistence: replaced a waiting save sessionKey=${input.sessionKey} conversationId=${input.conversationId}`)
    await trackedSnapshotWrite(cacheDir, input.sessionKey, () => waiting.queued!)
    return
  }
  const slot: WaitingSnapshotSave = { save: captureSnapshotSave(cacheDir, input) }
  waitingSnapshotSaves.set(key, slot)
  await trackedSnapshotWrite(cacheDir, input.sessionKey, () => slot.queued = queueConversationStateWrite(
    cacheDir, input.sessionKey, () => {
      if (waitingSnapshotSaves.get(key) === slot) waitingSnapshotSaves.delete(key)
      return slot.save()
    }))
}

type ConversationStateInput = {
  sessionKey: string
  conversationId: string
  requestContext: Record<string, unknown>
  toolCatalog?: OpencodeToolDef[]
  postCompactionRebase?: boolean
  hostAgent?: string
  systemPromptHash?: string
  hostNote?: string
  /** Only with `runInProgress`: notes that Run's own request delivered. */
  runHostNote?: string
  runInProgress?: boolean
  modelFallbackStop?: string
}

// A newer Run may have reset/superseded this conversation while its final
// frame was still in flight. Never let that late TurnEnded resurrect it.
function supersededTurnEnd(input: ConversationStateInput): boolean {
  if (isActiveConversationBinding(input.sessionKey, input.conversationId)) return false
  trace(
    `conversation persistence: skipped superseded TurnEnded ` +
      `sessionKey=${input.sessionKey} conversationId=${input.conversationId}`,
  )
  return true
}

/** Fork: capture now, as turn-end saves are not awaited; a queued capture could compact away a later Run's blobs. */
function captureSnapshotSave(cacheDir: string, input: ConversationStateInput): () => Promise<boolean> {
  const checkpoint = getCheckpoint(input.conversationId)
  const blobCompaction = compactConversationBlobs(input.conversationId, checkpoint, {
    keepInMemory: input.runInProgress,
    maxBytes: snapshotBlobLimit,
  })
  const requestContext = getFrozenRequestContext(input.conversationId) ?? input.requestContext
  const provenance = getTurnProvenance(input.sessionKey)
  const heldImages = heldHistoryImagesSnapshot(input.sessionKey, input.conversationId, checkpoint)
  const snapshot = {
    sessionKey: input.sessionKey,
    conversationId: input.conversationId,
    checkpoint,
    occupancyCheckpoint: getCheckpointOccupancy(input.conversationId),
    occupancyGuard: serializeCheckpointOccupancyGuard(input.conversationId),
    blobs: blobCompaction.blobs,
    requestContext,
    toolCatalog: structuredClone(input.toolCatalog ?? []),
    hostAgent: input.hostAgent,
    systemPromptHash: input.systemPromptHash,
    hostNote: input.hostNote,
    ...(input.runInProgress && input.runHostNote ? { runHostNote: input.runHostNote } : {}),
    earlySteers: serializeEarlySteers(input.sessionKey),
    lostRequest: serializeLostRequest(input.sessionKey),
    ...(input.modelFallbackStop ? { modelFallbackStop: input.modelFallbackStop } : {}),
    planOperations: serializePlanOperations(input.sessionKey),
    ...(heldImages ? { sentImageHashes: heldImages.hashes, sentImagesCheckpoint: heldImages.checkpoint } : {}),
    ...(sessionEditsDenySent(input.conversationId) ? { sessionEditsDenySent: true } : {}),
    ...(provenance?.conversationId === input.conversationId
      ? { turnProvenance: serializeTurnProvenance(provenance) }
      : {}),
  }
  snapshotCaptureHook?.(blobCompaction.blobs)
  return async (): Promise<boolean> => {
    if (supersededTurnEnd(input)) return false
    if (blobCompaction.oversized) {
      // A restore would reject the snapshot; the one on disk is older than this state.
      await discardPersistedConversation(cacheDir, input.sessionKey)
      trace(
        `conversation persistence: not saved${input.runInProgress ? " in-progress" : ""} sessionKey=${input.sessionKey} ` +
          `conversationId=${input.conversationId} blobBytes=${blobCompaction.afterBytes} ` +
          `over limit=${snapshotBlobLimit}; dropped the saved snapshot`,
      )
      return true
    }
    try {
      await persistConversation(cacheDir, {
        ...snapshot,
        postCompactionRebase: input.postCompactionRebase || hasHostHistoryRewrite(cacheDir, input.sessionKey),
      })
    } catch (error) {
      // The snapshot left on disk lacks what this save carried: a restart, or a copy that lost track of this failure,
      // must start from host history instead of resuming it. Still in the write lane, so no newer save is invalidated.
      await discardPersistedConversation(cacheDir, input.sessionKey).then(
        () => trace(`conversation persistence: invalidated older snapshot after failed save sessionKey=${input.sessionKey}`),
        (discardError) => trace(
          `conversation persistence: older snapshot kept after failed save sessionKey=${input.sessionKey}: ` +
            String(discardError),
        ),
      )
      throw error
    }
    trace(
      `conversation persistence: saved${input.runInProgress ? " in-progress" : ""} sessionKey=${input.sessionKey} ` +
        `conversationId=${input.conversationId} checkpoint=${checkpoint?.length ?? 0}B ` +
        `blobs=${blobCompaction.beforeCount}->${blobCompaction.afterCount} ` +
        `blobBytes=${blobCompaction.beforeBytes}->${blobCompaction.afterBytes}` +
        (blobCompaction.fallbackReason ? ` compactionFallback=${blobCompaction.fallbackReason}` : ""),
    )
    return true
  }
}

// Fork: a save still waiting behind the session's running write takes this module copy's newest capture instead of
// queueing another, so a backlog holds at most one copy of the conversation's blobs per module copy. Captures stay
// per copy: each copy's generations record its own writes.
type WaitingSnapshotSave = { save: () => Promise<boolean>; queued?: Promise<boolean> }
const waitingSnapshotSaves = new Map<string, WaitingSnapshotSave>()
let snapshotBlobLimit = MAX_CONVERSATION_SNAPSHOT_BLOB_BYTES

let snapshotCaptureHook: ((blobs: readonly object[]) => void) | undefined

export function setSnapshotBlobLimitForTests(bytes = MAX_CONVERSATION_SNAPSHOT_BLOB_BYTES): void {
  snapshotBlobLimit = bytes
}

export function setSnapshotCaptureHookForTests(hook?: (blobs: readonly object[]) => void): void {
  snapshotCaptureHook = hook
}

/**
 * Move a session to a fresh Cursor conversation that continues from `checkpoint`
 * (or starts empty without one), so nothing Cursor tied to the old id carries over.
 */
export function rekeyConversation(
  sessionKey: string,
  fromId: string,
  checkpoint: Uint8Array | undefined,
  /**
   * The epoch as it was when `checkpoint` was made, when that predates the conversation's current
   * one; `null` when it is not known, so the next Run reasserts the host context.
   */
  checkpointEpoch?: ContextEpoch | null,
): string {
  const toId = crypto.randomUUID()
  const epoch = detachContextEpoch(fromId)
  transferFrozenRequestContext(fromId, toId)
  if (checkpoint?.length) {
    restoreConversationBlobs(toId, snapshotConversationBlobs(fromId))
    setCheckpoint(toId, checkpoint)
    const occupancy = getCheckpointOccupancy(fromId)
    if (occupancy && !getCheckpointOccupancy(toId)) restoreCheckpointOccupancy(toId, occupancy)
    restoreCheckpointOccupancyGuard(toId, serializeCheckpointOccupancyGuard(fromId))
    moveSessionEditsDenySent(fromId, toId)
    // The checkpoint already holds the system context; keep its rule instead of reasserting it.
    const kept = checkpointEpoch === undefined ? epoch : checkpointEpoch
    if (kept) attachContextEpoch(toId, kept)
  }
  clearCheckpoint(fromId)
  clearConversationBlobs(fromId)
  restoreConversationBinding(sessionKey, toId)
  // What this provider emitted last stays the reference for telling another model's answer apart.
  rebindTurnProvenance(sessionKey, fromId, toId)
  rebindHeldHistoryImages(sessionKey, fromId, toId)
  return toId
}

export async function clearPersistedConversationState(
  cacheDir: string,
  sessionKey: string,
  expectedConversationId?: string,
): Promise<void> {
  await trackedSnapshotWrite(cacheDir, sessionKey, () => queueConversationStateWrite(cacheDir, sessionKey, async () => {
    await deletePersistedConversation(cacheDir, sessionKey, expectedConversationId)
    return true
  }))
}
