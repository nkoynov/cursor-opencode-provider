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
import { persistConversationState } from "../src/protocol/conversation-state.js"

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
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true })
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
