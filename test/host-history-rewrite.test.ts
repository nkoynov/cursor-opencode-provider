import { afterEach, expect, test } from "bun:test"
import { cpSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
  acknowledgeHostHistoryRewrite, awaitHostHistoryRewrite, hasHostHistoryRewrite,
  noteHostHistoryRewrite, resetHostHistoryRewritesForTests,
} from "../src/host-history-rewrite.js"
import {
  bindConversationId, peekConversationId, resetConversationBindingsForTests,
} from "../src/protocol/conversation-bind.js"
import {
  getPersistedConversation, resetConversationPersistenceForTests, setConversationPersistenceHookForTests,
} from "../src/protocol/conversation-persistence.js"
import {
  hydrateConversationState, onCopyStateReplaced, persistConversationState, resetSnapshotGenerationsForTests,
} from "../src/protocol/conversation-state.js"
import { getTurnProvenance, resetTurnProvenanceForTests, restoreTurnProvenance } from "../src/protocol/turn-provenance.js"
import { dropLostRequest, hasLostRequest, rememberLostRequest } from "../src/lost-request.js"
import {
  recordSessionEditsGuidance, resetSessionEditsGuidanceForTests, sessionEditsGuidance,
} from "../src/protocol/session-edits.js"
import { getConversationBlob, resetConversationBlobsForTests, setConversationBlob } from "../src/protocol/blob-store.js"
import { clearCheckpoint, getCheckpoint, resetCheckpointsForTests, setCheckpoint } from "../src/protocol/checkpoint.js"
import { encodeMessage } from "../src/protocol/messages.js"

const roots: string[] = []
const root = () => {
  const value = mkdtempSync(join(tmpdir(), "cursor-module-graph-rewrite-"))
  roots.push(value)
  return value
}
afterEach(() => {
  resetHostHistoryRewritesForTests()
  resetConversationPersistenceForTests()
  resetConversationBindingsForTests()
  resetSnapshotGenerationsForTests()
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true })
})

test("a save queued behind a slow write keeps blobs a later Run stores before its checkpoint", async () => {
  const cache = root()
  const sessionKey = "queued"
  const conversationId = peekConversationId(sessionKey)
  setCheckpoint(conversationId, encodeMessage("ConversationStateStructure", {
    token_details: { used_tokens: 1, max_tokens: 2 },
  }))
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let writes = 0
  setConversationPersistenceHookForTests(async phase => {
    if (phase === "before-write" && writes++ === 0) await gate
  })
  try {
    const input = { sessionKey, conversationId, requestContext: { rules_info_complete: true } }
    const first = persistConversationState(cache, input)
    const second = persistConversationState(cache, input)
    const blobId = Uint8Array.from({ length: 32 }, (_, i) => i)
    setConversationBlob(conversationId, blobId, Uint8Array.of(1, 2, 3))
    release()
    await Promise.all([first, second])
    expect(getConversationBlob(conversationId, blobId)).toEqual(Uint8Array.of(1, 2, 3))
  } finally {
    setConversationPersistenceHookForTests()
    resetConversationBlobsForTests()
    resetCheckpointsForTests()
  }
})

test("a rewrite without saved Cursor state leaves restart free to build its full context", async () => {
  const cache = root()
  await noteHostHistoryRewrite(cache, "empty", "evt_empty")
  resetHostHistoryRewritesForTests()
  resetConversationPersistenceForTests()
  expect(await getPersistedConversation(cache, "empty")).toBeUndefined()
})

test("a failed receipt save fails the request barrier and can be retried", async () => {
  const cache = root()
  await persistConversationState(cache, { sessionKey: "retry", conversationId: peekConversationId("retry"),
    requestContext: { rules_info_complete: true } })
  setConversationPersistenceHookForTests(phase => {
    if (phase === "before-write") throw new Error("disk unavailable")
  })
  await expect(noteHostHistoryRewrite(cache, "retry", "evt_retry")).rejects.toThrow("disk unavailable")
  await expect(awaitHostHistoryRewrite(cache, "retry")).rejects.toThrow("disk unavailable")
  expect(hasHostHistoryRewrite(cache, "retry")).toBe(true)
  setConversationPersistenceHookForTests()
  expect(await awaitHostHistoryRewrite(cache, "retry")).toBe(true)
  expect((await getPersistedConversation(cache, "retry"))?.postCompactionRebase).toBe(true)
  acknowledgeHostHistoryRewrite(cache, "absent")
})

test("separate module graphs share committed receipts and fence late saves", async () => {
  const cache = root()
  const graph = root()
  cpSync(resolve(import.meta.dir, "../src"), join(graph, "src"), { recursive: true })
  symlinkSync(resolve(import.meta.dir, "../node_modules"), join(graph, "node_modules"), "dir")
  const other = await import(pathToFileURL(join(graph, "src/host-history-rewrite.ts")).href) as typeof import("../src/host-history-rewrite.js")
  const otherState = await import(pathToFileURL(join(graph, "src/protocol/conversation-state.ts")).href) as typeof import("../src/protocol/conversation-state.js")
  const otherBinding = await import(pathToFileURL(join(graph, "src/protocol/conversation-bind.ts")).href) as typeof import("../src/protocol/conversation-bind.js")
  const otherPersistence = await import(pathToFileURL(join(graph, "src/protocol/conversation-persistence.ts")).href) as typeof import("../src/protocol/conversation-persistence.js")
  expect(other.noteHostHistoryRewrite).not.toBe(noteHostHistoryRewrite)
  expect(otherState.persistConversationState).not.toBe(persistConversationState)
  expect(otherBinding.bindConversationId).not.toBe(bindConversationId)
  try {
    const sessionKey = "copies"
    const old = peekConversationId(sessionKey)
    await persistConversationState(cache, { sessionKey, conversationId: old, requestContext: { rules_info_complete: true } })
    await Promise.all([
      noteHostHistoryRewrite(cache, sessionKey, "evt_copies"),
      other.noteHostHistoryRewrite(cache, sessionKey, "evt_copies"),
      otherState.persistConversationState(cache, { sessionKey, conversationId: old, requestContext: { rules_info_complete: true }, runInProgress: true }),
    ])
    expect(await other.awaitHostHistoryRewrite(cache, sessionKey)).toBe(true)
    expect((await getPersistedConversation(cache, sessionKey))?.postCompactionRebase).toBe(true)
    const next = bindConversationId(sessionKey, { reset: true }).conversationId
    acknowledgeHostHistoryRewrite(cache, sessionKey)
    expect(otherBinding.peekConversationId(sessionKey)).toBe(next)
    await persistConversationState(cache, { sessionKey, conversationId: next, requestContext: { rules_info_complete: true } })
    await otherState.persistConversationState(cache, { sessionKey, conversationId: old, requestContext: { rules_info_complete: true }, runInProgress: true })
    expect((await getPersistedConversation(cache, sessionKey))?.conversationId).toBe(next)
    expect((await getPersistedConversation(cache, sessionKey))?.postCompactionRebase).toBe(false)
    await other.noteHostHistoryRewrite(cache, sessionKey, "evt_copies")
    expect(await awaitHostHistoryRewrite(cache, sessionKey)).toBe(false)
    await other.noteHostHistoryRewrite(cache, sessionKey, "evt_copies_second")
    expect(await awaitHostHistoryRewrite(cache, sessionKey)).toBe(true)
  } finally {
    otherPersistence.resetConversationPersistenceForTests()
  }
})

// A moved session, or a Location loaded again after an idle eviction, runs in a copy that never served it.
const otherGraph = async () => {
  const graph = root()
  cpSync(resolve(import.meta.dir, "../src"), join(graph, "src"), { recursive: true })
  symlinkSync(resolve(import.meta.dir, "../node_modules"), join(graph, "node_modules"), "dir")
  const load = (file: string) => import(pathToFileURL(join(graph, "src", file)).href)
  return {
    state: await load("protocol/conversation-state.ts") as typeof import("../src/protocol/conversation-state.js"),
    checkpoint: await load("protocol/checkpoint.ts") as typeof import("../src/protocol/checkpoint.js"),
    frozen: await load("context/frozen.ts") as typeof import("../src/context/frozen.js"),
    persistence: await load("protocol/conversation-persistence.ts") as typeof import("../src/protocol/conversation-persistence.js"),
    sessionEdits: await load("protocol/session-edits.ts") as typeof import("../src/protocol/session-edits.js"),
    provenance: await load("protocol/turn-provenance.ts") as typeof import("../src/protocol/turn-provenance.js"),
  }
}
const checkpointBytes = encodeMessage("ConversationStateStructure", { token_details: { used_tokens: 1, max_tokens: 2 } })

test("a module copy that never served the bound conversation restores its snapshot", async () => {
  const cache = root()
  const other = await otherGraph()
  const sessionKey = "moved"
  const conversationId = peekConversationId(sessionKey)
  setCheckpoint(conversationId, checkpointBytes)
  try {
    await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    expect(other.checkpoint.getCheckpoint(conversationId)).toBeUndefined()
    expect((await other.state.hydrateConversationState(cache, sessionKey))?.conversationId).toBe(conversationId)
    expect(other.checkpoint.getCheckpoint(conversationId)).toEqual(checkpointBytes)
    expect(other.frozen.getFrozenRequestContext(conversationId)).toEqual({ rules_info_complete: true })
    // Each copy keeps its live state once it has served the conversation.
    expect(await other.state.hydrateConversationState(cache, sessionKey)).toBeUndefined()
    expect(await hydrateConversationState(cache, sessionKey)).toBeUndefined()
  } finally {
    other.persistence.resetConversationPersistenceForTests()
    resetCheckpointsForTests()
  }
})

test("a copy that wrote the latest snapshot keeps its live state after its own stores drop the conversation", async () => {
  const cache = root()
  const sessionKey = "evicted-locally"
  const conversationId = peekConversationId(sessionKey)
  setCheckpoint(conversationId, checkpointBytes)
  try {
    await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    // A checkpoint dropped on purpose and a frozen context the LRU evicted leave nothing to recognize the copy by.
    clearCheckpoint(conversationId)
    expect(await hydrateConversationState(cache, sessionKey)).toBeUndefined()
  } finally {
    resetCheckpointsForTests()
  }
})

test("a copy behind another copy's newer save restores it", async () => {
  const cache = root()
  const other = await otherGraph()
  const sessionKey = "moved-back"
  const conversationId = peekConversationId(sessionKey)
  const newer = encodeMessage("ConversationStateStructure", { token_details: { used_tokens: 7, max_tokens: 9 } })
  setCheckpoint(conversationId, checkpointBytes)
  try {
    await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    expect((await other.state.hydrateConversationState(cache, sessionKey))?.conversationId).toBe(conversationId)
    setCheckpoint(conversationId, newer)
    await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    expect((await other.state.hydrateConversationState(cache, sessionKey))?.replacesCopyState).toBe(true)
    expect(other.checkpoint.getCheckpoint(conversationId)).toEqual(newer)
  } finally {
    other.persistence.resetConversationPersistenceForTests()
    resetCheckpointsForTests()
  }
})

test("a copy at the latest snapshot waits for another copy's save still being written", async () => {
  const cache = root()
  const other = await otherGraph()
  const sessionKey = "queued-elsewhere"
  const conversationId = peekConversationId(sessionKey)
  const newer = encodeMessage("ConversationStateStructure", { token_details: { used_tokens: 7, max_tokens: 9 } })
  setCheckpoint(conversationId, checkpointBytes)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  try {
    await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    expect((await other.state.hydrateConversationState(cache, sessionKey))?.conversationId).toBe(conversationId)
    setConversationPersistenceHookForTests(async phase => { if (phase === "before-write") await gate })
    setCheckpoint(conversationId, newer)
    const save = persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    let settled = false
    const hydrated = other.state.hydrateConversationState(cache, sessionKey).finally(() => { settled = true })
    await Bun.sleep(30)
    expect(settled).toBe(false)
    release()
    await save
    expect((await hydrated)?.replacesCopyState).toBe(true)
    expect(other.checkpoint.getCheckpoint(conversationId)).toEqual(newer)
  } finally {
    release()
    setConversationPersistenceHookForTests()
    other.persistence.resetConversationPersistenceForTests()
    resetCheckpointsForTests()
  }
})

test("a copy reading the snapshot while another copy saves a newer one restores the newer one", async () => {
  const cache = root()
  const other = await otherGraph()
  const sessionKey = "saved-during-read"
  const conversationId = peekConversationId(sessionKey)
  const newer = encodeMessage("ConversationStateStructure", { token_details: { used_tokens: 7, max_tokens: 9 } })
  setCheckpoint(conversationId, checkpointBytes)
  try {
    await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    let saved = false
    other.persistence.setConversationPersistenceHookForTests(async phase => {
      if (phase !== "full-decode" || saved) return
      saved = true
      setCheckpoint(conversationId, newer)
      await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    })
    expect((await other.state.hydrateConversationState(cache, sessionKey))?.conversationId).toBe(conversationId)
    expect(saved).toBe(true)
    expect(other.checkpoint.getCheckpoint(conversationId)).toEqual(newer)
  } finally {
    other.persistence.setConversationPersistenceHookForTests()
    other.persistence.resetConversationPersistenceForTests()
    resetCheckpointsForTests()
  }
})

test("a returning copy takes the edit-deny record of the snapshot it restores", async () => {
  const cache = root()
  const other = await otherGraph()
  const sessionKey = "deny-elsewhere"
  const conversationId = peekConversationId(sessionKey)
  setCheckpoint(conversationId, checkpointBytes)
  try {
    recordSessionEditsGuidance(conversationId, false)
    await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    await other.state.hydrateConversationState(cache, sessionKey)
    other.sessionEdits.recordSessionEditsGuidance(conversationId, true)
    await other.state.persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    expect((await hydrateConversationState(cache, sessionKey))?.replacesCopyState).toBe(true)
    // The restored checkpoint holds the other copy's deny, so lifting it needs the no-deny note.
    expect(sessionEditsGuidance(conversationId, false, { carriesEarlierState: true })).toBe(false)
  } finally {
    other.persistence.resetConversationPersistenceForTests()
    resetSessionEditsGuidanceForTests()
    resetCheckpointsForTests()
  }
})

test("a copy behind takes what is on disk, also a delete or a snapshot without provenance", async () => {
  const cache = root()
  const other = await otherGraph()
  const sessionKey = "behind"
  const conversationId = peekConversationId(sessionKey)
  const stale = { conversationId, toolCallIds: [], text: "Older answer", textWithReasoning: "Older answer" }
  const replaced: string[] = []
  onCopyStateReplaced(key => replaced.push(key))
  setCheckpoint(conversationId, checkpointBytes)
  try {
    restoreTurnProvenance(sessionKey, stale)
    await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    await other.state.hydrateConversationState(cache, sessionKey)
    other.provenance.forgetTurnProvenance(sessionKey)
    await other.state.persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    expect((await hydrateConversationState(cache, sessionKey))?.conversationId).toBe(conversationId)
    expect(getTurnProvenance(sessionKey)).toBeUndefined()
    expect(replaced).toEqual([sessionKey])
    restoreTurnProvenance(sessionKey, stale)
    await other.state.clearPersistedConversationState(cache, sessionKey)
    expect(await hydrateConversationState(cache, sessionKey)).toBeUndefined()
    expect(getTurnProvenance(sessionKey)).toBeUndefined()
    expect(replaced).toEqual([sessionKey, sessionKey])
  } finally {
    other.persistence.resetConversationPersistenceForTests()
    resetTurnProvenanceForTests()
    resetCheckpointsForTests()
  }
})

test("a copy's own save requested during its read wins over the older snapshot", async () => {
  const cache = root()
  const other = await otherGraph()
  const sessionKey = "own-save-during-read"
  const conversationId = peekConversationId(sessionKey)
  const middle = encodeMessage("ConversationStateStructure", { token_details: { used_tokens: 5, max_tokens: 9 } })
  const own = encodeMessage("ConversationStateStructure", { token_details: { used_tokens: 7, max_tokens: 9 } })
  setCheckpoint(conversationId, checkpointBytes)
  let save: Promise<void> | undefined
  try {
    await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    await other.state.hydrateConversationState(cache, sessionKey)
    other.checkpoint.setCheckpoint(conversationId, middle)
    await other.state.persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    setConversationPersistenceHookForTests(phase => {
      if (phase !== "full-decode" || save) return
      setCheckpoint(conversationId, own)
      save = persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    })
    expect(await hydrateConversationState(cache, sessionKey)).toBeUndefined()
    await save
    expect(getCheckpoint(conversationId)).toEqual(own)
    expect(await hydrateConversationState(cache, sessionKey)).toBeUndefined()
    expect(getCheckpoint(conversationId)).toEqual(own)
  } finally {
    setConversationPersistenceHookForTests()
    await save
    other.persistence.resetConversationPersistenceForTests()
    resetCheckpointsForTests()
  }
})

test("a copy behind leaves its state alone when its own request moves the binding during the read", async () => {
  const cache = root()
  const other = await otherGraph()
  const sessionKey = "rebound-during-read"
  const conversationId = peekConversationId(sessionKey)
  const replaced: string[] = []
  onCopyStateReplaced(key => replaced.push(key))
  setCheckpoint(conversationId, checkpointBytes)
  try {
    await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    await other.state.hydrateConversationState(cache, sessionKey)
    await other.state.persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    let next: string | undefined
    setConversationPersistenceHookForTests(phase => {
      if (phase === "full-decode" && !next) next = bindConversationId(sessionKey, { reset: true }).conversationId
    })
    expect(await hydrateConversationState(cache, sessionKey)).toBeUndefined()
    expect(next).toBeDefined()
    expect(replaced).toEqual([])
    expect(peekConversationId(sessionKey)).toBe(next!)
  } finally {
    setConversationPersistenceHookForTests()
    other.persistence.resetConversationPersistenceForTests()
    resetCheckpointsForTests()
  }
})

test("no copy resumes an older snapshot while the latest save failed", async () => {
  const cache = root()
  const other = await otherGraph()
  const sessionKey = "unsaved"
  const conversationId = peekConversationId(sessionKey)
  setCheckpoint(conversationId, checkpointBytes)
  try {
    await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    setConversationPersistenceHookForTests(phase => {
      if (phase === "before-write") throw new Error("disk full")
    })
    await expect(persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } }))
      .rejects.toThrow("disk full")
    setConversationPersistenceHookForTests()
    expect(await other.state.hydrateConversationState(cache, sessionKey)).toBeUndefined()
    expect(other.checkpoint.getCheckpoint(conversationId)).toBeUndefined()
    await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    expect((await other.state.hydrateConversationState(cache, sessionKey))?.conversationId).toBe(conversationId)
  } finally {
    setConversationPersistenceHookForTests()
    other.persistence.resetConversationPersistenceForTests()
    resetCheckpointsForTests()
  }
})

test("a module copy leaves a snapshot alone once the binding has moved past it", async () => {
  const cache = root()
  const other = await otherGraph()
  const sessionKey = "moved-on"
  const conversationId = peekConversationId(sessionKey)
  setCheckpoint(conversationId, checkpointBytes)
  try {
    await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    const next = bindConversationId(sessionKey, { reset: true }).conversationId
    expect(await other.state.hydrateConversationState(cache, sessionKey)).toBeUndefined()
    expect(other.checkpoint.getCheckpoint(conversationId)).toBeUndefined()
    expect(peekConversationId(sessionKey)).toBe(next)
  } finally {
    other.persistence.resetConversationPersistenceForTests()
    resetCheckpointsForTests()
  }
})

test("a module copy restoring a snapshot keeps process-shared state and a pending rewrite", async () => {
  const cache = root()
  const other = await otherGraph()
  const sessionKey = "moved-shared"
  const conversationId = peekConversationId(sessionKey)
  setCheckpoint(conversationId, checkpointBytes)
  try {
    rememberLostRequest({ sessionKey, conversationId, checkpoint: checkpointBytes, text: "Sent once" })
    await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    // Cursor kept the turn after the save; the snapshot's copy is stale.
    dropLostRequest(sessionKey)
    await noteHostHistoryRewrite(cache, sessionKey, "evt_moved")
    const restored = await other.state.hydrateConversationState(cache, sessionKey)
    expect(restored?.postCompactionRebase).toBe(true)
    expect(hasHostHistoryRewrite(cache, sessionKey)).toBe(true)
    expect(hasLostRequest(sessionKey)).toBe(false)
  } finally {
    dropLostRequest(sessionKey)
    other.persistence.resetConversationPersistenceForTests()
    resetCheckpointsForTests()
  }
})
