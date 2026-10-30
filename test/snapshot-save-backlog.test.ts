import { afterEach, expect, test } from "bun:test"
import { cpSync, existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { resetHostHistoryRewritesForTests } from "../src/host-history-rewrite.js"
import { peekConversationId, resetConversationBindingsForTests } from "../src/protocol/conversation-bind.js"
import {
  conversationCacheFilePath, getPersistedConversation, getPersistedTurnProvenance, resetConversationPersistenceForTests,
  setConversationPersistenceHookForTests,
} from "../src/protocol/conversation-persistence.js"
import {
  clearPersistedConversationState, persistConversationState, resetSnapshotGenerationsForTests,
  setSnapshotBlobLimitForTests, setSnapshotCaptureHookForTests,
} from "../src/protocol/conversation-state.js"
import {
  compactConversationBlobs, conversationBlobCount, getConversationBlob, resetConversationBlobsForTests,
  setConversationBlob,
} from "../src/protocol/blob-store.js"
import { resetCheckpointsForTests, setCheckpoint } from "../src/protocol/checkpoint.js"
import { encodeMessage } from "../src/protocol/messages.js"

const roots: string[] = []
const root = () => {
  const value = mkdtempSync(join(tmpdir(), "cursor-snapshot-backlog-"))
  roots.push(value)
  return value
}
afterEach(() => {
  setConversationPersistenceHookForTests()
  setSnapshotBlobLimitForTests()
  setSnapshotCaptureHookForTests()
  resetHostHistoryRewritesForTests()
  resetConversationPersistenceForTests()
  resetConversationBindingsForTests()
  resetSnapshotGenerationsForTests()
  resetConversationBlobsForTests()
  resetCheckpointsForTests()
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true })
})

const blobId = (seed: number) => Uint8Array.from({ length: 32 }, (_, i) => (seed * 31 + i) & 0xff)
const checkpoint = () => encodeMessage("ConversationStateStructure", { token_details: { used_tokens: 1, max_tokens: 2 } })

test("saves requested while a write runs leave one waiting save, which writes the newest state", async () => {
  const cache = root()
  const sessionKey = "backlog"
  const conversationId = peekConversationId(sessionKey)
  setCheckpoint(conversationId, checkpoint())
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let writes = 0
  setConversationPersistenceHookForTests(async phase => {
    if (phase === "before-write" && writes++ === 0) await gate
  })
  const save = (hostNote: string) =>
    persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true }, hostNote, runInProgress: true })
  const running = save("note-0")
  while (writes === 0) await new Promise(resolve => setTimeout(resolve, 1))
  const waiting = [1, 2, 3, 4, 5].map(n => save(`note-${n}`))
  release()
  await Promise.all([running, ...waiting])
  expect(writes).toBe(2)
  expect((await getPersistedConversation(cache, sessionKey))?.hostNote).toBe("note-5")
})

test("captures replaced while they wait are released before the running write ends", async () => {
  const cache = root()
  const sessionKey = "released"
  const conversationId = peekConversationId(sessionKey)
  setCheckpoint(conversationId, checkpoint())
  setConversationBlob(conversationId, blobId(8), new Uint8Array(1000))
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let writes = 0
  setConversationPersistenceHookForTests(async phase => {
    if (phase === "before-write" && writes++ === 0) await gate
  })
  const captures: WeakRef<object>[] = []
  setSnapshotCaptureHookForTests(blobs => captures.push(new WeakRef(blobs)))
  const save = (hostNote: string) =>
    persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true }, hostNote, runInProgress: true })
  const running = save("note-0")
  while (writes === 0) await new Promise(resolve => setTimeout(resolve, 1))
  const waiting = [1, 2, 3, 4, 5].map(n => save(`note-${n}`))
  for (let i = 0; i < 5; i++) {
    Bun.gc(true)
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  const alive = captures.map(capture => capture.deref() !== undefined)
  release()
  await Promise.all([running, ...waiting])
  expect(alive).toEqual([true, false, false, false, false, true])
})

test("a save queued after a delete still lands after it", async () => {
  const cache = root()
  const sessionKey = "ordered"
  const conversationId = peekConversationId(sessionKey)
  setCheckpoint(conversationId, checkpoint())
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let writes = 0
  setConversationPersistenceHookForTests(async phase => {
    if (phase === "before-write" && writes++ === 0) await gate
  })
  const save = (hostNote: string) =>
    persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true }, hostNote })
  const running = save("first")
  while (writes === 0) await new Promise(resolve => setTimeout(resolve, 1))
  const waiting = save("second")
  const cleared = clearPersistedConversationState(cache, sessionKey)
  const last = save("third")
  release()
  await Promise.all([running, waiting, cleared, last])
  expect(writes).toBe(3)
  expect((await getPersistedConversation(cache, sessionKey))?.hostNote).toBe("third")
})

test("a conversation whose blobs pass the restore limit drops its older snapshot instead of saving", async () => {
  const cache = root()
  const sessionKey = "oversized"
  const conversationId = peekConversationId(sessionKey)
  setSnapshotBlobLimitForTests(100)
  const input = { sessionKey, conversationId, requestContext: { rules_info_complete: true } }
  setConversationBlob(conversationId, blobId(1), new Uint8Array(40))
  await persistConversationState(cache, input)
  expect((await getPersistedConversation(cache, sessionKey))?.blobs.length).toBe(1)
  setConversationBlob(conversationId, blobId(2), new Uint8Array(80))
  let writes = 0
  setConversationPersistenceHookForTests(phase => {
    if (phase === "before-write") writes++
  })
  await persistConversationState(cache, { ...input, runInProgress: true })
  expect(writes).toBe(0)
  expect(await getPersistedConversation(cache, sessionKey)).toBeUndefined()
  expect(getConversationBlob(conversationId, blobId(2))).toEqual(new Uint8Array(80))
})

test("an oversized save drops a snapshot another module copy wrote after this copy found none", async () => {
  const cache = root()
  const graph = root()
  cpSync(resolve(import.meta.dir, "../src"), join(graph, "src"), { recursive: true })
  symlinkSync(resolve(import.meta.dir, "../node_modules"), join(graph, "node_modules"), "dir")
  const otherState = await import(pathToFileURL(join(graph, "src/protocol/conversation-state.ts")).href) as typeof import("../src/protocol/conversation-state.js")
  const otherBlobs = await import(pathToFileURL(join(graph, "src/protocol/blob-store.ts")).href) as typeof import("../src/protocol/blob-store.js")
  const sessionKey = "copies"
  const conversationId = peekConversationId(sessionKey)
  const input = { sessionKey, conversationId, requestContext: { rules_info_complete: true } }
  expect(await getPersistedTurnProvenance(cache, sessionKey)).toBeUndefined()
  otherBlobs.setConversationBlob(conversationId, blobId(6), new Uint8Array(10))
  await otherState.persistConversationState(cache, input)
  expect(existsSync(conversationCacheFilePath(cache, sessionKey))).toBe(true)
  setSnapshotBlobLimitForTests(5)
  setConversationBlob(conversationId, blobId(7), new Uint8Array(10))
  let decodes = 0
  setConversationPersistenceHookForTests(phase => {
    if (phase === "full-decode") decodes++
  })
  await persistConversationState(cache, { ...input, runInProgress: true })
  expect(existsSync(conversationCacheFilePath(cache, sessionKey))).toBe(false)
  expect(decodes).toBe(0)
})

test("compaction over maxBytes copies no blobs and still compacts the store", () => {
  const conversationId = "compact-oversized"
  setConversationBlob(conversationId, blobId(3), new Uint8Array(60))
  setConversationBlob(conversationId, blobId(4), new Uint8Array(60))
  const unreachable = compactConversationBlobs(conversationId, checkpoint(), { maxBytes: 10 })
  expect(unreachable.oversized).toBeUndefined()
  expect(unreachable.afterCount).toBe(0)
  expect(conversationBlobCount(conversationId)).toBe(0)
  setConversationBlob(conversationId, blobId(5), new Uint8Array(60))
  const fallback = compactConversationBlobs(conversationId, undefined, { maxBytes: 10, keepInMemory: true })
  expect(fallback).toMatchObject({ oversized: true, blobs: [], beforeBytes: 60 })
  expect(conversationBlobCount(conversationId)).toBe(1)
})
