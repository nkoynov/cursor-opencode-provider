import { trace } from "../debug.js"
import { restoreEarlySteers, serializeEarlySteers } from "../host-steer.js"
import { restoreLostRequest, serializeLostRequest } from "../lost-request.js"
import { restorePlanOperations, serializePlanOperations } from "./plan-operations.js"
import {
  getFrozenRequestContext,
  setFrozenRequestContext,
  transferFrozenRequestContext,
} from "../context/frozen.js"
import { attachContextEpoch, detachContextEpoch, type ContextEpoch } from "../context/epoch.js"
import {
  hasConversationBinding,
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
  getPersistedTurnProvenance,
  loadPersistedConversation,
  persistConversation,
} from "./conversation-persistence.js"

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
} | undefined> {
  if (hasConversationBinding(sessionKey)) return undefined
  const loaded = await loadPersistedConversation(cacheDir, sessionKey)
  const persisted = loaded.value
  if (!persisted) {
    trace(
      `conversation persistence: hydration skipped sessionKey=${sessionKey} ` +
        `status=${loaded.status}`,
    )
    return undefined
  }

  restoreConversationBinding(sessionKey, persisted.conversationId)
  restoreEarlySteers(sessionKey, persisted.earlySteers)
  restoreLostRequest(sessionKey, persisted.lostRequest)
  restorePlanOperations(sessionKey, persisted.planOperations)
  // Snapshots written before this marker existed came from releases that never sent a deny.
  restoreSessionEditsDenySent(persisted.conversationId, persisted.sessionEditsDenySent === true)
  if (persisted.occupancyCheckpoint) restoreCheckpointOccupancy(persisted.conversationId, persisted.occupancyCheckpoint)
  if (persisted.checkpoint) setCheckpoint(persisted.conversationId, persisted.checkpoint)
  restoreConversationBlobs(persisted.conversationId, persisted.blobs)
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
      `blobs=${persisted.blobs.length} heldImages=${persisted.sentImageHashes?.length ?? 0}`,
  )
  return {
    conversationId: persisted.conversationId,
    postCompactionRebase: persisted.postCompactionRebase,
    toolCatalog: structuredClone(persisted.toolCatalog),
    ...(persisted.hostAgent ? { hostAgent: persisted.hostAgent } : {}),
    ...(persisted.systemPromptHash ? { systemPromptHash: persisted.systemPromptHash } : {}),
    ...(persisted.hostNote ? { hostNote: persisted.hostNote } : {}),
    ...(persisted.modelFallbackStop ? { modelFallbackStop: persisted.modelFallbackStop } : {}),
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
  if (!isActiveConversationBinding(input.sessionKey, input.conversationId)) {
    trace(
      `conversation persistence: skipped superseded TurnEnded ` +
        `sessionKey=${input.sessionKey} conversationId=${input.conversationId}`,
    )
    return
  }
  const checkpoint = getCheckpoint(input.conversationId)
  const blobCompaction = compactConversationBlobs(input.conversationId, checkpoint, {
    keepInMemory: input.runInProgress,
  })
  const blobs = blobCompaction.blobs
  const requestContext = getFrozenRequestContext(input.conversationId) ?? input.requestContext
  const provenance = getTurnProvenance(input.sessionKey)
  const heldImages = heldHistoryImagesSnapshot(input.sessionKey, input.conversationId, checkpoint)
  await persistConversation(cacheDir, {
    sessionKey: input.sessionKey,
    conversationId: input.conversationId,
    checkpoint,
    occupancyCheckpoint: getCheckpointOccupancy(input.conversationId),
    blobs,
    requestContext,
    toolCatalog: structuredClone(input.toolCatalog ?? []),
    postCompactionRebase: input.postCompactionRebase,
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
  })
  trace(
    `conversation persistence: saved${input.runInProgress ? " in-progress" : ""} sessionKey=${input.sessionKey} ` +
      `conversationId=${input.conversationId} checkpoint=${checkpoint?.length ?? 0}B ` +
      `blobs=${blobCompaction.beforeCount}->${blobCompaction.afterCount} ` +
      `blobBytes=${blobCompaction.beforeBytes}->${blobCompaction.afterBytes}` +
      (blobCompaction.fallbackReason ? ` compactionFallback=${blobCompaction.fallbackReason}` : ""),
  )
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
  await deletePersistedConversation(cacheDir, sessionKey, expectedConversationId)
}
