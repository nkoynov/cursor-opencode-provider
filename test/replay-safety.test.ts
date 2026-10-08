import { describe, expect, it } from "bun:test"
import { analyzeReplayFrame, describeFrameLayout } from "../src/replay-safety.js"

function varint(value: number): number[] {
  const out: number[] = []
  while (value > 0x7f) {
    out.push((value & 0x7f) | 0x80)
    value >>>= 7
  }
  out.push(value)
  return out
}

function lengthDelimited(field: number, bytes: Uint8Array = new Uint8Array()): number[] {
  return [...varint((field << 3) | 2), ...varint(bytes.length), ...bytes]
}

function kvFrame(...fields: number[][]): Uint8Array {
  return Uint8Array.from(lengthDelimited(4, Uint8Array.from(fields.flat())))
}

const id = [...varint(1 << 3), 7]
const getBlob = lengthDelimited(2, Uint8Array.from(lengthDelimited(1, new TextEncoder().encode("blob"))))
// `KvServerMessage.span_context` (#4): Cursor sends it on live KV requests.
const span = lengthDelimited(4, Uint8Array.from(lengthDelimited(1, new TextEncoder().encode("trace"))))
const kv = { id: 7, get_blob_args: { blob_id: new TextEncoder().encode("blob") } }

describe("replay frame analysis", () => {
  it("treats a KV request with its span context as a control frame", () => {
    expect(analyzeReplayFrame(kvFrame(id, getBlob, span), { kv })).toEqual({ semanticProgress: true, barrier: undefined })
    expect(analyzeReplayFrame(kvFrame(id, getBlob), { kv }).barrier).toBeUndefined()
  })

  it("keeps the barrier for unknown or repeated KV fields", () => {
    const unknown = [...varint((20 << 3) | 0), 1]
    expect(analyzeReplayFrame(kvFrame(id, getBlob, unknown), { kv }).barrier).toBe("unknown-or-malformed-frame")
    expect(analyzeReplayFrame(kvFrame(id, getBlob, span, span), { kv }).barrier).toBe("unknown-or-malformed-frame")
  })
})

function updateFrame(field: number, body: number[]): Uint8Array {
  return Uint8Array.from(lengthDelimited(1, Uint8Array.from(lengthDelimited(field, Uint8Array.from(body)))))
}

describe("interaction update analysis", () => {
  const text = lengthDelimited(1, new TextEncoder().encode("hm"))

  it("accepts Cursor's informational updates and styled thinking", () => {
    // thinking_completed{thinking_duration_ms} #5, token_delta{tokens} #8.
    expect(analyzeReplayFrame(updateFrame(5, [...varint(1 << 3), 42]), { interactionUpdate: {} }).barrier).toBeUndefined()
    expect(analyzeReplayFrame(updateFrame(8, [...varint(1 << 3), 3]), { interactionUpdate: {} }).barrier).toBeUndefined()
    // thinking_delta{text, thinking_style} #4.
    const styled = updateFrame(4, [...text, ...varint(2 << 3), 1])
    expect(analyzeReplayFrame(styled, { interactionUpdate: { thinking_delta: { text: "hm" } } }))
      .toEqual({ semanticProgress: true, barrier: undefined })
  })

  it("keeps the barrier for undeclared updates and unknown delta fields", () => {
    // shell_output_delta #12 is not a member this client declares.
    expect(analyzeReplayFrame(updateFrame(12, text), { interactionUpdate: {} }).barrier).toBe("unknown-or-malformed-frame")
    const textWithUnknown = updateFrame(1, [...text, ...varint(3 << 3), 1])
    expect(analyzeReplayFrame(textWithUnknown, { interactionUpdate: { text_delta: { text: "hm" } } }).barrier)
      .toBe("unknown-or-malformed-frame")
    // A second top-level oneof member, or a repeated timing field, is not a frame this client knows.
    const twoMembers = Uint8Array.from([...updateFrame(13, []), ...lengthDelimited(4, Uint8Array.from(id))])
    expect(analyzeReplayFrame(twoMembers, { interactionUpdate: { heartbeat: {} } }).barrier).toBe("unknown-or-malformed-frame")
  })
})

describe("frame layout", () => {
  it("names field numbers and wire types without payload bytes", () => {
    const frame = updateFrame(16, [...varint(1 << 3), 5])
    expect(describeFrameLayout(frame)).toBe("1:2{16:2{1:0}}")
    expect(describeFrameLayout(kvFrame(id, getBlob))).toBe("4:2{1:0,2:2{1:2}}")
  })
})

function fixed64(field: number): number[] {
  return [...varint((field << 3) | 1), 1, 0, 0, 0, 0, 0, 0, 0]
}

describe("Cursor CLI 2026.09.28 frame shapes", () => {
  const text = lengthDelimited(1, new TextEncoder().encode("hm"))
  const startedAt = [...varint(25 << 3), ...varint(1_791_275_000)]
  const update = (field: number, body: number[], extra: number[] = startedAt): number[] =>
    lengthDelimited(1, Uint8Array.from([...lengthDelimited(field, Uint8Array.from(body)), ...extra]))
  const ttft = lengthDelimited(8, Uint8Array.from([...fixed64(1), ...fixed64(2), ...fixed64(3), ...fixed64(4)]))
  const callId = lengthDelimited(1, new TextEncoder().encode("call-1"))
  const nested = lengthDelimited(2, Uint8Array.from(lengthDelimited(1, new TextEncoder().encode("x"))))

  // Layouts logged live by `replay frame unknown: layout=…`.
  const cases: Array<[string, number[], Record<string, unknown>]> = [
    ["1:2{4:2{1:2,2:0},25:0},8:2{1:1,2:1,3:1,4:1}", [...update(4, [...text, ...varint(2 << 3), 1]), ...ttft], { thinking_delta: { text: "hm" } }],
    ["1:2{4:2{1:2,2:0},25:0}", update(4, [...text, ...varint(2 << 3), 1]), { thinking_delta: { text: "hm" } }],
    ["1:2{5:2{1:0},25:0}", update(5, [...varint(1 << 3), 42]), {}],
    ["1:2{1:2{1:2},25:0}", update(1, text), { text_delta: { text: "hm" } }],
    ["1:2{27:2{1:0}}", update(27, [...varint(1 << 3), 2], []), {}],
    ["1:2{7:2{1:2,2:2,4:2},25:0}", update(7, [...callId, ...nested, ...lengthDelimited(4, new TextEncoder().encode("m"))]), { partial_tool_call: {} }],
    ["1:2{15:2{1:2,2:2,3:2},25:0}", update(15, [...callId, ...nested, ...lengthDelimited(3, new TextEncoder().encode("m"))]), {}],
  ]

  for (const [layout, bytes, interactionUpdate] of cases) {
    it(`accepts ${layout}`, () => {
      const frame = Uint8Array.from(bytes)
      expect(describeFrameLayout(frame)).toBe(layout)
      expect(analyzeReplayFrame(frame, { interactionUpdate }).barrier).toBeUndefined()
    })
  }

  it("keeps the barrier for an undeclared member or a repeated timing field", () => {
    // `grok_bot_nudge` #26 is not one this client accepts.
    expect(analyzeReplayFrame(Uint8Array.from(update(26, text)), { interactionUpdate: {} }).barrier).toBe("unknown-or-malformed-frame")
    expect(analyzeReplayFrame(Uint8Array.from([...update(1, text), ...ttft, ...ttft]), { interactionUpdate: { text_delta: { text: "hm" } } }).barrier)
      .toBe("unknown-or-malformed-frame")
  })
})
