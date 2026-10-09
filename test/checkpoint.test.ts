import { describe, it, expect, beforeEach } from "bun:test"
import {
  setCheckpoint,
  getCheckpoint,
  clearCheckpoint,
  resetCheckpointsForTests,
} from "../src/protocol/checkpoint.js"
import { buildRunRequest } from "../src/protocol/request.js"
import { decodeMessage } from "../src/protocol/messages.js"

describe("checkpoint store", () => {
  beforeEach(() => resetCheckpointsForTests())

  it("stores and returns opaque bytes by conversation id", () => {
    const bytes = Uint8Array.from([0x0a, 0x03, 0x61, 0x62, 0x63])
    setCheckpoint("conv-1", bytes)
    expect(getCheckpoint("conv-1")).toEqual(bytes)
    expect(getCheckpoint("conv-other")).toBeUndefined()
  })

  it("replaces on subsequent set (CLI handleCheckpoint)", () => {
    setCheckpoint("conv-1", Uint8Array.from([1]))
    setCheckpoint("conv-1", Uint8Array.from([2, 3]))
    expect(getCheckpoint("conv-1")).toEqual(Uint8Array.from([2, 3]))
  })

  it("copies bytes so later mutations of the source buffer do not corrupt the store", () => {
    const src = Uint8Array.from([9, 9, 9])
    setCheckpoint("conv-1", src)
    src[0] = 0
    expect(getCheckpoint("conv-1")![0]).toBe(9)
  })

  it("ignores empty bytes", () => {
    setCheckpoint("conv-1", new Uint8Array(0))
    expect(getCheckpoint("conv-1")).toBeUndefined()
  })

  it("clearCheckpoint removes an entry", () => {
    setCheckpoint("conv-1", Uint8Array.from([1]))
    clearCheckpoint("conv-1")
    expect(getCheckpoint("conv-1")).toBeUndefined()
  })
})

describe("buildRunRequest checkpoint echo", () => {
  beforeEach(() => resetCheckpointsForTests())

  it("echoes opaque conversationState bytes instead of inventing a seed", () => {
    // Arbitrary opaque checkpoint payload (CLI blob-ref structure, not our seed).
    const checkpoint = Uint8Array.from([0x0a, 0x20, ...Array(32).fill(0xab)])
    const data = buildRunRequest({
      text: "follow up",
      modelId: "m",
      conversationId: "c",
      conversationState: checkpoint,
    })
    const decoded = decodeMessage<any>("AgentClientMessage", data)
    const state = decoded.run_request.conversation_state as Uint8Array
    expect(Buffer.from(state)).toEqual(Buffer.from(checkpoint))
    expect(decoded.run_request.action.user_message_action.user_message.text).toBe(
      "follow up",
    )
  })

  it("carries seed history in the user text, never in root_prompt_messages_json", () => {
    const data = buildRunRequest({
      text: "hi",
      modelId: "m",
      conversationId: "c",
      history: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "earlier" },
        { role: "assistant", content: "noted" },
      ],
    })
    const decoded = decodeMessage<any>("AgentClientMessage", data)
    const cs = decodeMessage<any>(
      "ConversationStateStructure",
      decoded.run_request.conversation_state,
    )
    // A client root prompt stops Cursor rendering RequestContext rules.
    expect(cs.root_prompt_messages_json ?? []).toEqual([])
    expect(decoded.run_request.action.user_message_action.user_message.text).toBe(
      "<conversation_history>\n<user>\nearlier\n</user>\n\n<assistant>\nnoted\n</assistant>\n" +
        "</conversation_history>\n\nhi",
    )
  })

  it("keeps a checkpointed Run's user text free of seed history", () => {
    const data = buildRunRequest({
      text: "follow up",
      modelId: "m",
      conversationId: "c",
      conversationState: Uint8Array.from([0x0a, 0x01, 0x7f]),
      history: [{ role: "user", content: "earlier" }],
    })
    const decoded = decodeMessage<any>("AgentClientMessage", data)
    expect(decoded.run_request.action.user_message_action.user_message.text).toBe("follow up")
  })

  it("encodes checkpoint recovery as ResumeAction without replaying user text", () => {
    const checkpoint = Uint8Array.from([0x0a, 0x01, 0x7f])
    const data = buildRunRequest({
      text: "must not be replayed",
      modelId: "m",
      conversationId: "c",
      conversationState: checkpoint,
      action: "resume",
    })
    const runRequest = decodeMessage<any>("AgentClientMessage", data).run_request

    expect(runRequest.action.resume_action).toEqual({ request_context: null })
    expect(runRequest.action.user_message_action).toBeUndefined()
    expect(Buffer.from(runRequest.conversation_state)).toEqual(Buffer.from(checkpoint))
    expect(runRequest.conversation_id).toBe("c")
  })
})
