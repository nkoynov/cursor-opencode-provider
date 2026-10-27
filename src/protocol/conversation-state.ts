import path from "node:path"
import { hasHostHistoryRewrite, queueConversationStateWrite, settleConversationStateWrites } from "../host-history-rewrite.js"
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
  restoreConversationBinding,
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
  persistConversation,
  type PersistedConversationLoad,
} from "./conversation-persistence.js"

// Every snapshot write or delete that lands gets a process-wide generation, and writes still queued are counted per
// module copy; each copy remembers the generation it last wrote or restored. The shared records are never evicted:
// losing one, or its unsaved mark, would let a copy keep or resume a stale snapshot.
type SnapshotRecord = { generation: number; unsaved: boolean; queued: Map<string, number> }
const copyId = crypto.randomUUID()
const snapshots = processShared("conversation-snapshot-generations.v1", () => ({
  next: 0,
  bySession: new Map<string, SnapshotRecord>(),
}))
const MAX_HELD_GENERATIONS = 4096
const heldGenerations = new Map<string, number>()
const snapshotKey = (cacheDir: string, sessionKey: string) => JSON.stringify([path.resolve(cacheDir), sessionKey])

function snapshotRecord(key: string): SnapshotRecord {
  let record = snapshots.bySession.get(key)
  if (!record) {
    record = { generation: ++snapshots.next, unsaved: false, queued: new Map() }
    snapshots.bySession.set(key, record)
  }
  return record
}

function rememberHeldGeneration(key: string, generation: number): void {
  heldGenerations.delete(key)
  heldGenerations.set(key, generation)
  while (heldGenerations.size > MAX_HELD_GENERATIONS) heldGenerations.delete(heldGenerations.keys().next().value as string)
}

function holdsLatestSnapshot(key: string): boolean {
  const record = snapshots.bySession.get(key)
  return !!record && heldGenerations.get(key) === record.generation
}

function otherCopyQueuedWrite(key: string): boolean {
  for (const [copy, count] of snapshots.bySession.get(key)?.queued ?? []) if (copy !== copyId && count > 0) return true
  return false
}

/** Count a write from when it is requested; record whether it landed. A failed write leaves an older snapshot on disk. */
async function trackedSnapshotWrite(key: string, write: () => Promise<boolean>): Promise<void> {
  const record = snapshotRecord(key)
  record.queued.set(copyId, (record.queued.get(copyId) ?? 0) + 1)
  try {
    if (!await write()) return
    record.generation = ++snapshots.next
    record.unsaved = false
    rememberHeldGeneration(key, record.generation)
  } catch (error) {
    record.generation = ++snapshots.next
    record.unsaved = true
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

export function resetSnapshotGenerationsForTests(): void {
  snapshots.next = 0
  snapshots.bySession.clear()
  heldGenerations.clear()
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
      if (attempt === 0 && holdsLatestSnapshot(key) && !otherCopyQueuedWrite(key)) return undefined
      await settleConversationStateWrites(cacheDir, sessionKey)
      if (holdsLatestSnapshot(key)) return undefined
      if (snapshots.bySession.get(key)?.unsaved) {
        trace(`conversation persistence: hydration skipped sessionKey=${sessionKey} status=unsaved`)
        return undefined
      }
      await forgetCachedConversation(cacheDir, sessionKey)
    }
    generation = snapshotRecord(key).generation
    const read = await loadPersistedConversation(cacheDir, sessionKey)
    // A write that landed or was queued during the read may be newer than what was read.
    if (snapshotRecord(key).generation === generation && !otherCopyQueuedWrite(key)) loaded = read
  }
  if (!loaded) {
    trace(`conversation persistence: hydration skipped sessionKey=${sessionKey} status=still-writing`)
    return undefined
  }
  // A concurrent request in this copy already restored this generation.
  if (bound !== undefined && heldGenerations.get(key) === generation) return undefined
  rememberHeldGeneration(key, generation)
  if (bound !== undefined) {
    // This copy was behind: what is on disk (a snapshot, or none after a delete) replaces its per-session state.
    forgetTurnProvenance(sessionKey)
    for (const reset of copyStateResets) reset(sessionKey)
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
  await trackedSnapshotWrite(snapshotKey(cacheDir, input.sessionKey), () => queueConversationStateWrite(cacheDir, input.sessionKey, async () => {
    if (superseded()) return false
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
  }))
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
  await trackedSnapshotWrite(snapshotKey(cacheDir, sessionKey), () => queueConversationStateWrite(cacheDir, sessionKey, async () => {
    await deletePersistedConversation(cacheDir, sessionKey, expectedConversationId)
    return true
  }))
}
