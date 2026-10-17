import { beforeEach, describe, expect, it } from "bun:test"
import {
  checkpointFingerprint,
  confirmHistoryImagesAtTurnEnd,
  forgetHeldHistoryImages,
  heldHistoryImageHashes,
  heldHistoryImagesSnapshot,
  noteHistoryImageCheckpoint,
  noteHistoryImagesSent,
  rebindHeldHistoryImages,
  resetHeldHistoryImagesForTests,
  restoreHeldHistoryImages,
  runHistoryImages,
} from "../src/protocol/sent-history-images.js"

const SESSION = "ses_images"
const CONVERSATION = "conversation-images"
const C1 = Uint8Array.from([1])
const C2 = Uint8Array.from([2])
const C3 = Uint8Array.from([3])

const held = (checkpoint: Uint8Array, conversationId = CONVERSATION) =>
  [...heldHistoryImageHashes(SESSION, conversationId, checkpoint) ?? []]

/** A Run on `start` that sends `hashes` and ends its turn on `end`. */
function turn(start: Uint8Array | undefined, hashes: string[], end: Uint8Array | undefined) {
  const run = runHistoryImages(start ? heldHistoryImageHashes(SESSION, CONVERSATION, start) : undefined)
  noteHistoryImagesSent(run, hashes)
  if (end) noteHistoryImageCheckpoint(run, SESSION, CONVERSATION, end)
  confirmHistoryImagesAtTurnEnd(run, SESSION, CONVERSATION, end)
  return run
}

describe("history images a checkpoint holds", () => {
  beforeEach(resetHeldHistoryImagesForTests)

  it("counts an image as held only by the checkpoint its turn ended on", () => {
    turn(undefined, ["a"], C1)
    expect(held(C1)).toEqual(["a"])
    expect(held(C2)).toEqual([])
    expect(held(C1, "another-conversation")).toEqual([])
  })

  it("keeps the older checkpoint's set when a turn ends without a checkpoint of its own", () => {
    turn(undefined, ["a"], C1)
    turn(C1, ["b"], undefined)
    expect(held(C1)).toEqual(["a"])
    expect(heldHistoryImagesSnapshot(SESSION, CONVERSATION, C1)).toEqual({ checkpoint: checkpointFingerprint(C1), hashes: ["a"] })
  })

  it("gives a checkpoint before the turn ends only what the Run's first checkpoint held", () => {
    turn(undefined, ["a"], C1)
    const run = runHistoryImages(heldHistoryImageHashes(SESSION, CONVERSATION, C1))
    noteHistoryImagesSent(run, ["b"])
    noteHistoryImageCheckpoint(run, SESSION, CONVERSATION, C2)
    // The Run fails or is stopped here: nothing confirms "b", and a rollback to C1 still skips "a".
    expect(held(C2)).toEqual(["a"])
    expect(held(C1)).toEqual(["a"])
  })

  it("does not confirm an image sent after the turn's last checkpoint", () => {
    const run = runHistoryImages()
    noteHistoryImagesSent(run, ["a"])
    noteHistoryImageCheckpoint(run, SESSION, CONVERSATION, C1)
    noteHistoryImagesSent(run, ["tool-image"])
    confirmHistoryImagesAtTurnEnd(run, SESSION, CONVERSATION, C1)
    expect(held(C1)).toEqual(["a"])
    expect(run).toEqual({ held: ["a"], checkpointed: [], sent: [] })
  })

  it("gives a checkpoint only the images written before its frame arrived", () => {
    const run = runHistoryImages()
    noteHistoryImagesSent(run, ["a"], 10)
    noteHistoryImagesSent(run, ["tool-image"], 12)
    noteHistoryImageCheckpoint(run, SESSION, CONVERSATION, C1, 12)
    confirmHistoryImagesAtTurnEnd(run, SESSION, CONVERSATION, C1)
    expect(held(C1)).toEqual(["a"])

    const next = runHistoryImages(heldHistoryImageHashes(SESSION, CONVERSATION, C1))
    noteHistoryImagesSent(next, ["b"], 20)
    noteHistoryImageCheckpoint(next, SESSION, CONVERSATION, C2, 21)
    noteHistoryImagesSent(next, ["c"], 25)
    noteHistoryImageCheckpoint(next, SESSION, CONVERSATION, C3, 26)
    confirmHistoryImagesAtTurnEnd(next, SESSION, CONVERSATION, C3)
    expect(held(C3)).toEqual(["a", "b", "c"])
  })

  it("carries what a turn confirmed into a follow-up Run on the same Cursor session", () => {
    const run = turn(undefined, ["a"], C1)
    noteHistoryImageCheckpoint(run, SESSION, CONVERSATION, C2)
    confirmHistoryImagesAtTurnEnd(run, SESSION, CONVERSATION, C2)
    expect(held(C2)).toEqual(["a"])
  })

  it("restores a saved set only for the checkpoint it belongs to", () => {
    restoreHeldHistoryImages(SESSION, CONVERSATION, { checkpoint: checkpointFingerprint(C1), hashes: ["a", "b"] })
    expect(held(C2)).toEqual([])
    expect(held(C1)).toEqual(["a", "b"])
    restoreHeldHistoryImages(SESSION, CONVERSATION, { hashes: ["a"] })
    expect(held(C1)).toEqual([])
  })

  it("follows a rekey to the same checkpoint bytes and drops on forget", () => {
    turn(undefined, ["a"], C1)
    rebindHeldHistoryImages(SESSION, CONVERSATION, "rekeyed")
    expect(held(C1)).toEqual([])
    expect(held(C1, "rekeyed")).toEqual(["a"])
    forgetHeldHistoryImages(SESSION)
    expect(held(C1, "rekeyed")).toEqual([])
  })

  it("keeps the newest 256 hashes", () => {
    const hashes = Array.from({ length: 300 }, (_, index) => `h${index}`)
    turn(undefined, hashes, C3)
    const kept = held(C3)
    expect(kept).toHaveLength(256)
    expect(kept[0]).toBe("h44")
    expect(kept.at(-1)).toBe("h299")
  })
})
