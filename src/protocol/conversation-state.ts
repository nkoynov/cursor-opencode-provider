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
import { clearCheckpoint, getCheckpoint, getCheckpointOccupancy, restoreCheckpointOccupancy, setCheckpoint } from "./checkpoint.js"
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
  forgetCachedConversation,
  getPersistedTurnProvenance,
  loadPersistedConversation,
  MAX_CONVERSATION_SNAPSHOT_BLOB_BYTES,
  persistConversation,
  type PersistedConversationLoad,
} from "./conversation-persistence.js"

// Every snapshot write or delete that lands gets a process-wide generation, and writes still queued are counted per
// module copy; each copy's entry in `held` is the generation it last wrote or restored. Only a bound session consults
// its record (an unbound one restores from disk), so a record is evicted only once its session is unbound and no write
// or read is using it. Generations are never reused: a copy whose record was evicted counts as never having held one.
// `writer` is the copy whose write or delete, landed or failed, produced the current generation, or that rebound the
// unbound session from its snapshot.
type SnapshotRecord = {
  sessionKey: string
  generation: number
  writer?: string
  unsaved: boolean
  queued: Map<string, number>
  held: Map<string, number>
  reading: number
}
// A copy of an older build loaded in the same process (7d3650e) shares this map and creates records without the
// fields added since; it reads only generation, unsaved and queued. A b635ce1 copy never sets `writer` but enters its
// writes, restores and rebinds in `held`, so a copy missing from `writerAware` that holds the latest generation counts
// as its writer.
type StoredRecord = Pick<SnapshotRecord, "generation" | "unsaved" | "queued"> & Partial<SnapshotRecord>
const copyId = randomUUID()
const snapshots: { next: number; bySession: Map<string, StoredRecord>; writerAware?: Set<string> } = processShared(
  "conversation-snapshot-generations.v1",
  () => ({ next: 0, bySession: new Map<string, StoredRecord>(), writerAware: new Set<string>() }),
)
const writerAware = snapshots.writerAware ??= new Set()
writerAware.add(copyId)
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

function pruneSnapshotRecords(keep: string): void {
  for (const [key, stored] of snapshots.bySession) {
    if (snapshots.bySession.size <= MAX_ACTIVE_CONVERSATION_BINDINGS) return
    const record = upgraded(key, stored)
    if (key === keep || record.queued.size > 0 || record.reading > 0) continue
    if (boundConversationId(record.sessionKey) === undefined) snapshots.bySession.delete(key)
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
    record.writer = copyId
    record.unsaved = false
    record.held.set(copyId, record.generation)
  } catch (error) {
    // The disk misses this state, but this copy's memory still holds it.
    record.generation = ++snapshots.next
    record.writer = copyId
    record.unsaved = true
    record.held.set(copyId, record.generation)
    throw error
  } finally {
    const left = (record.queued.get(copyId) ?? 1) - 1
    if (left > 0) record.queued.set(copyId, left)
    else record.queued.delete(copyId)
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
 * newer state (its save failed, or its writes keep landing), or another copy wrote the latest generation and that
 * snapshot is now unreadable or gone, every copy behind drops its checkpoint.
 */
function replaceCopyState(
  key: string, generation: number, sessionKey: string, conversationId: string, newerElsewhere = false,
): void {
  const record = snapshotRecord(key, sessionKey)
  const servedBefore = record.held.has(copyId)
  const writtenElsewhere = (record.writer !== undefined && record.writer !== copyId)
    || [...record.held].some(([copy, held]) => held === record.generation && !writerAware.has(copy))
  record.held.set(copyId, generation)
  forgetTurnProvenance(sessionKey)
  for (const reset of copyStateResets) reset(sessionKey)
  if (servedBefore || newerElsewhere || writtenElsewhere) clearCheckpoint(conversationId)
}

/**
 * An unbound session's binding, and maybe its record, were evicted, but this copy's checkpoint for the conversation
 * the session binds next was not: unless this copy holds the latest generation, it may lack turns another copy ran.
 * A copy that rebinds the session from its snapshot holds the newest state any copy can tell of.
 */
function adoptUnboundState(key: string, generation: number, sessionKey: string, restored: string | undefined): void {
  const record = snapshotRecord(key, sessionKey)
  if (record.held.get(copyId) !== generation) clearCheckpoint(restored ?? sessionIdToUuid(sessionKey))
  record.held.set(copyId, generation)
  if (restored !== undefined) record.writer = copyId
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
  /** Another copy advanced this binding: the snapshot replaces this copy's per-session turn state. */
  replacesCopyState?: true
} | undefined> {
  // Bindings are process-shared but checkpoints and frozen contexts live per module copy (one per
  // Location): a copy behind the latest snapshot any copy saved restores it.
  const key = snapshotKey(cacheDir, sessionKey)
  const bound = boundConversationId(sessionKey)
  let generation = 0
  let loaded: PersistedConversationLoad | undefined
  for (let attempt = 0; attempt < 3 && !loaded; attempt++) {
    if (bound !== undefined) {
      // This copy's own queued writes hold state no newer than its memory; another copy's may.
      if (attempt === 0 && holdsLatestSnapshot(key) && !queuedWrite(key, true)) return undefined
      await settleConversationStateWrites(cacheDir, sessionKey)
      if (holdsLatestSnapshot(key)) return undefined
      if (snapshots.bySession.get(key)?.unsaved) {
        trace(`conversation persistence: hydration skipped sessionKey=${sessionKey} status=unsaved`)
        if (boundConversationId(sessionKey) === bound) {
          replaceCopyState(key, snapshotRecord(key, sessionKey).generation, sessionKey, bound, true)
        }
        return undefined
      }
      await forgetCachedConversation(cacheDir, sessionKey)
    }
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
  }
  if (!loaded) {
    trace(`conversation persistence: hydration skipped sessionKey=${sessionKey} status=still-writing`)
    if (bound !== undefined && boundConversationId(sessionKey) === bound) {
      replaceCopyState(key, snapshotRecord(key, sessionKey).generation, sessionKey, bound, true)
    }
    return undefined
  }
  // A concurrent request in this copy already restored this generation, or moved the binding meanwhile.
  if (bound !== undefined && (heldGeneration(key) === generation || boundConversationId(sessionKey) !== bound)) {
    return undefined
  }
  // This copy was behind: what is on disk (a snapshot, or none after a delete) replaces its per-session state.
  if (bound !== undefined) replaceCopyState(key, generation, sessionKey, bound)
  else adoptUnboundState(key, generation, sessionKey, loaded.value?.conversationId)
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
  restoreSessionEditsDenySent(persisted.conversationId, persisted.sessionEditsDenySent === true, bound !== undefined)
  if (bound !== undefined) clearCheckpoint(persisted.conversationId)
  if (persisted.occupancyCheckpoint) restoreCheckpointOccupancy(persisted.conversationId, persisted.occupancyCheckpoint)
  if (persisted.checkpoint) setCheckpoint(persisted.conversationId, persisted.checkpoint)
  restoreConversationBlobs(persisted.conversationId, persisted.blobs)
  if (bound !== undefined) clearFrozenRequestContext(persisted.conversationId)
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
    ...(bound !== undefined ? { replacesCopyState: true as const } : {}),
  }
}

/** Restore only turn provenance when its in-memory entry was evicted. */
export async function hydrateTurnProvenance(cacheDir: string, sessionKey: string): Promise<void> {
  if (getTurnProvenance(sessionKey)) return
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
export async function persistConversationState(
  cacheDir: string,
  input: {
    sessionKey: string
    conversationId: string
    requestContext: Record<string, unknown>
    toolCatalog?: OpencodeToolDef[]
    postCompactionRebase?: boolean
    hostAgent?: string
    systemPromptHash?: string
    hostNote?: string
    runInProgress?: boolean
    modelFallbackStop?: string
  },
): Promise<void> {
  // A newer Run may have reset/superseded this conversation while its final
  // frame was still in flight. Never let that late TurnEnded resurrect it.
  const superseded = () => {
    if (isActiveConversationBinding(input.sessionKey, input.conversationId)) return false
    trace(
      `conversation persistence: skipped superseded TurnEnded ` +
        `sessionKey=${input.sessionKey} conversationId=${input.conversationId}`,
    )
    return true
  }
  if (superseded()) return
  // Fork: capture now, as turn-end saves are not awaited; a queued capture could compact away a later Run's blobs.
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
    blobs: blobCompaction.blobs,
    requestContext,
    toolCatalog: structuredClone(input.toolCatalog ?? []),
    hostAgent: input.hostAgent,
    systemPromptHash: input.systemPromptHash,
    hostNote: input.hostNote,
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
  const save = async (): Promise<boolean> => {
    if (superseded()) return false
    if (blobCompaction.oversized) {
      // A restore would reject the snapshot; the one on disk is older than this state.
      await deletePersistedConversation(cacheDir, input.sessionKey)
      trace(
        `conversation persistence: not saved${input.runInProgress ? " in-progress" : ""} sessionKey=${input.sessionKey} ` +
          `conversationId=${input.conversationId} blobBytes=${blobCompaction.afterBytes} ` +
          `over limit=${snapshotBlobLimit}; dropped the saved snapshot`,
      )
      return true
    }
    await persistConversation(cacheDir, {
      ...snapshot,
      postCompactionRebase: input.postCompactionRebase || hasHostHistoryRewrite(cacheDir, input.sessionKey),
    })
    trace(
      `conversation persistence: saved${input.runInProgress ? " in-progress" : ""} sessionKey=${input.sessionKey} ` +
        `conversationId=${input.conversationId} checkpoint=${checkpoint?.length ?? 0}B ` +
        `blobs=${blobCompaction.beforeCount}->${blobCompaction.afterCount} ` +
        `blobBytes=${blobCompaction.beforeBytes}->${blobCompaction.afterBytes}` +
        (blobCompaction.fallbackReason ? ` compactionFallback=${blobCompaction.fallbackReason}` : ""),
    )
    return true
  }
  const key = snapshotKey(cacheDir, input.sessionKey)
  const waiting = waitingSnapshotSaves.get(key)
  if (waiting?.queued && isLastConversationStateWrite(cacheDir, input.sessionKey, waiting.queued)) {
    waiting.save = save
    trace(`conversation persistence: replaced a waiting save sessionKey=${input.sessionKey} conversationId=${input.conversationId}`)
    await trackedSnapshotWrite(cacheDir, input.sessionKey, () => waiting.queued!)
    return
  }
  const slot: WaitingSnapshotSave = { save }
  waitingSnapshotSaves.set(key, slot)
  await trackedSnapshotWrite(cacheDir, input.sessionKey, () => slot.queued = queueConversationStateWrite(
    cacheDir, input.sessionKey, () => {
      if (waitingSnapshotSaves.get(key) === slot) waitingSnapshotSaves.delete(key)
      return slot.save()
    }))
}

// Fork: a save still waiting behind the session's running write takes the newest capture instead of queueing
// another, so a backlog of saves holds at most one copy of the conversation's blobs.
type WaitingSnapshotSave = { save: () => Promise<boolean>; queued?: Promise<boolean> }
const waitingSnapshotSaves = new Map<string, WaitingSnapshotSave>()
let snapshotBlobLimit = MAX_CONVERSATION_SNAPSHOT_BLOB_BYTES

export function setSnapshotBlobLimitForTests(bytes = MAX_CONVERSATION_SNAPSHOT_BLOB_BYTES): void {
  snapshotBlobLimit = bytes
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
