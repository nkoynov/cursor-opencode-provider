/**
 * Cursor CLI parity: the server emits `conversation_checkpoint_update` after
 * (and during) a turn. The CLI replaces its local ConversationStateStructure
 * and re-sends that structure as `AgentRunRequest.conversation_state` on the
 * next Run. We mirror that with an in-process store keyed by conversation_id.
 *
 * Checkpoints are kept as opaque protobuf bytes — CLI's structure uses blob-id
 * fields (repeated bytes), not the seed JSON strings we invent on turn 1.
 */

import {
  decodeConversationTokenDetails,
  type CursorConversationTokenDetails,
} from "./token-details.js"
import protobuf from "protobufjs"

const byConversationId = new Map<string, Uint8Array>()
/** Last checkpoint occupancy above zero, per conversation. */
const occupancyByConversationId = new Map<string, Uint8Array>()

/** Replace the stored checkpoint for a conversation (CLI handleCheckpoint). */
export function setCheckpoint(conversationId: string, bytes: Uint8Array): void {
  if (!conversationId || bytes.length === 0) return
  // Copy so later mutations of the decode buffer can't corrupt the store.
  byConversationId.set(conversationId, Uint8Array.from(bytes))
  restoreCheckpointOccupancy(conversationId, bytes)
}

/** Token-details-only checkpoint for local persistence; never sent as Run state. */
export function getCheckpointOccupancy(conversationId: string): Uint8Array | undefined {
  return occupancyByConversationId.get(conversationId)
}

/** Retain only field #5, without duplicating the checkpoint's potentially large blob graph. */
export function restoreCheckpointOccupancy(conversationId: string, checkpoint: Uint8Array): void {
  const details = decodeConversationTokenDetails(checkpoint)
  if (!details || details.usedTokens <= 0) return
  const reader = protobuf.Reader.create(checkpoint)
  let tokens: Uint8Array | undefined
  while (reader.pos < reader.len) {
    const tag = reader.uint32()
    if (tag === 42) tokens = reader.bytes()
    else reader.skipType(tag & 7)
  }
  if (tokens) occupancyByConversationId.set(conversationId, protobuf.Writer.create().uint32(42).bytes(tokens).finish())
}

/** Last checkpoint for this conversation, if any. */
export function getCheckpoint(conversationId: string): Uint8Array | undefined {
  return byConversationId.get(conversationId)
}

/**
 * Token details of the checkpoint a Run sends. The checkpoint that ends a
 * cancelled Run reports `usedTokens=0`; the conversation's context did not
 * shrink, so its last measured occupancy stands in.
 */
export function checkpointTokenDetails(
  conversationId: string,
  checkpoint: Uint8Array | undefined,
): CursorConversationTokenDetails | undefined {
  const details = decodeConversationTokenDetails(checkpoint)
  if (details?.usedTokens !== 0) return details
  return decodeConversationTokenDetails(occupancyByConversationId.get(conversationId)) ?? details
}

/** Drop a conversation's checkpoint (tests / explicit reset). */
export function clearCheckpoint(conversationId: string): void {
  byConversationId.delete(conversationId)
  occupancyByConversationId.delete(conversationId)
}

/** Test helper — wipe all stored checkpoints. */
export function resetCheckpointsForTests(): void {
  byConversationId.clear()
  occupancyByConversationId.clear()
}
