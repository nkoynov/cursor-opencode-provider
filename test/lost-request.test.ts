import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  carryLostRequest,
  dropLostRequest,
  noteCheckpoint,
  hasLostRequest,
  rememberLostRequest,
  resetLostRequestsForTests,
  restoreLostRequest,
} from "../src/lost-request.js"
import {
  hydrateConversationState,
  persistConversationState,
} from "../src/protocol/conversation-state.js"
import { resetConversationBindingsForTests, restoreConversationBinding } from "../src/protocol/conversation-bind.js"
import { resetCheckpointsForTests, setCheckpoint } from "../src/protocol/checkpoint.js"
import { resetConversationBlobsForTests } from "../src/protocol/blob-store.js"
import { resetConversationPersistenceForTests } from "../src/protocol/conversation-persistence.js"
import { resetFrozenRequestContextsForTests, setFrozenRequestContext } from "../src/context/frozen.js"

const roots: string[] = []

afterEach(() => {
  resetLostRequestsForTests()
})

function remember(sessionKey: string, conversationId: string, checkpoint: Uint8Array | undefined, text: string): void {
  rememberLostRequest({ sessionKey, conversationId, checkpoint, text })
}

/** Failed attempts on one checkpoint, recorded as `startSession` does: what was sent, and the attempt's own text. */
function attempts(checkpoint: Uint8Array): (text: string) => string {
  return (text) => {
    const sent = carryLostRequest({ sessionKey: "ses", conversationId: "conv", checkpoint, text, rebuildFromHistory: false })
    rememberLostRequest({ sessionKey: "ses", conversationId: "conv", checkpoint, text: sent, latest: text })
    return sent
  }
}

describe("lost requests", () => {
  it("prepends text Cursor never checkpointed, and drops it on a newer checkpoint, stop, or history rebuild", () => {
    const checkpoint = Uint8Array.from([1, 2, 3])
    remember("ses", "conv", checkpoint, "first request")
    expect(carryLostRequest({
      sessionKey: "ses",
      conversationId: "conv",
      checkpoint,
      text: "second request",
      rebuildFromHistory: false,
    })).toBe("first request\n\nsecond request")
    remember("ses", "conv", checkpoint, "first request\n\nsecond request")

    noteCheckpoint("ses", Uint8Array.from([9]))
    expect(carryLostRequest({
      sessionKey: "ses",
      conversationId: "conv",
      checkpoint,
      text: "third",
      rebuildFromHistory: false,
    })).toBe("third")

    remember("ses", "conv", checkpoint, "kept")
    dropLostRequest("ses")
    expect(carryLostRequest({
      sessionKey: "ses",
      conversationId: "conv",
      checkpoint,
      text: "after stop",
      rebuildFromHistory: false,
    })).toBe("after stop")

    remember("ses", "conv", checkpoint, "in history")
    expect(carryLostRequest({
      sessionKey: "ses",
      conversationId: "conv",
      checkpoint,
      text: "rebuilt",
      rebuildFromHistory: true,
    })).toBe("rebuilt")
    expect(carryLostRequest({
      sessionKey: "ses",
      conversationId: "conv",
      checkpoint,
      text: "again",
      rebuildFromHistory: false,
    })).toBe("again")
  })

  it("does not double an exact retry, and keeps both messages across a second failure", () => {
    const checkpoint = Uint8Array.from([4])
    remember("ses", "conv", checkpoint, "hello")
    expect(carryLostRequest({
      sessionKey: "ses",
      conversationId: "conv",
      checkpoint,
      text: "hello",
      rebuildFromHistory: false,
    })).toBe("hello")
    const combined = carryLostRequest({
      sessionKey: "ses",
      conversationId: "conv",
      checkpoint,
      text: "next",
      rebuildFromHistory: false,
    })
    expect(combined).toBe("hello\n\nnext")
    remember("ses", "conv", checkpoint, combined)
    expect(carryLostRequest({
      sessionKey: "ses",
      conversationId: "conv",
      checkpoint,
      text: "third",
      rebuildFromHistory: false,
    })).toBe("hello\n\nnext\n\nthird")
  })

  it("does not pile up a note the host repeats on every failed retry", () => {
    const checkpoint = Uint8Array.from([5])
    const note = "The previous response was interrupted. Continue from where you left off."
    const carry = attempts(checkpoint)
    expect(carry("the request")).toBe("the request")
    for (let attempt = 0; attempt < 10; attempt++) expect(carry(note)).toBe(`the request\n\n${note}`)
    expect(carry("next message")).toBe(`the request\n\n${note}\n\nnext message`)
    // Only a repeat of the previous attempt is a retry.
    expect(carry("next message")).toBe(`the request\n\n${note}\n\nnext message`)
  })

  it("keeps a repeated request that follows a different one", () => {
    const carry = attempts(Uint8Array.from([8]))
    expect(carry("Use red")).toBe("Use red")
    expect(carry("Use blue")).toBe("Use red\n\nUse blue")
    // The user changed their mind back; Cursor must see red last.
    expect(carry("Use red")).toBe("Use red\n\nUse blue\n\nUse red")
    // A new message equal to the last paragraph of a longer one is new too.
    expect(carry("Plan it.\n\nShip it.")).toBe("Use red\n\nUse blue\n\nUse red\n\nPlan it.\n\nShip it.")
    expect(carry("Ship it.")).toBe("Use red\n\nUse blue\n\nUse red\n\nPlan it.\n\nShip it.\n\nShip it.")
  })

  it("keeps at most 1,024 sessions, dropping the least recently written", () => {
    const checkpoint = Uint8Array.from([6])
    for (let index = 0; index <= 1_024; index++) remember(`ses-${index}`, "conv", checkpoint, `request ${index}`)
    expect(hasLostRequest("ses-0")).toBe(false)
    expect(hasLostRequest("ses-1")).toBe(true)
    expect(hasLostRequest("ses-1024")).toBe(true)
    // Rewriting a record makes it the newest.
    remember("ses-1", "conv", checkpoint, "request 1 again")
    remember("ses-extra", "conv", checkpoint, "extra")
    expect(hasLostRequest("ses-1")).toBe(true)
    expect(hasLostRequest("ses-2")).toBe(false)
  })

  it("ignores a corrupt or incomplete snapshot record", () => {
    restoreLostRequest("ses-corrupt", "{not json")
    restoreLostRequest("ses-partial", JSON.stringify({ conversationId: "conv", checkpointKey: "none" }))
    restoreLostRequest("ses-empty", JSON.stringify({ conversationId: "conv", checkpointKey: "none", text: "" }))
    restoreLostRequest("ses-missing", undefined)
    expect(hasLostRequest("ses-corrupt")).toBe(false)
    expect(hasLostRequest("ses-partial")).toBe(false)
    expect(hasLostRequest("ses-empty")).toBe(false)
    expect(hasLostRequest("ses-missing")).toBe(false)

    // A record already in memory is newer than the snapshot and is kept.
    remember("ses-live", "conv", Uint8Array.from([7]), "live text")
    restoreLostRequest("ses-live", JSON.stringify({ conversationId: "conv", checkpointKey: "none", text: "stale" }))
    expect(carryLostRequest({
      sessionKey: "ses-live",
      conversationId: "conv",
      checkpoint: Uint8Array.from([7]),
      text: "next",
      rebuildFromHistory: false,
    })).toBe("live text\n\nnext")
  })

  it("restores the record from the conversation snapshot", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cursor-lost-request-"))
    roots.push(root)
    const sessionKey = "ses_lost"
    const conversationId = "conv-lost"
    const checkpoint = Uint8Array.from([7, 7])
    const requestContext = { rules_info_complete: true }
    restoreConversationBinding(sessionKey, conversationId)
    setCheckpoint(conversationId, checkpoint)
    setFrozenRequestContext(conversationId, requestContext)
    remember(sessionKey, conversationId, checkpoint, "uncheckpointed")
    await persistConversationState(root, { sessionKey, conversationId, requestContext })

    resetLostRequestsForTests()
    resetConversationBindingsForTests()
    resetCheckpointsForTests()
    resetConversationBlobsForTests()
    resetConversationPersistenceForTests()
    resetFrozenRequestContextsForTests()
    const hydrated = await hydrateConversationState(root, sessionKey)
    expect(hydrated?.conversationId).toBe(conversationId)
    expect(carryLostRequest({
      sessionKey,
      conversationId,
      checkpoint,
      text: "after restart",
      rebuildFromHistory: false,
    })).toBe("uncheckpointed\n\nafter restart")
    await rm(root, { recursive: true, force: true })
  })
})
