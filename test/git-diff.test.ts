import { describe, expect, it } from "bun:test"
import { buildGitDiffUnavailableMessages } from "../src/protocol/git-diff.js"
import { readAllFields } from "../src/protocol/struct.js"

/** AgentClientMessage.exec_client_control_message (#5) → its single control member. */
function control(frame: Uint8Array): { fn: number; fields: ReturnType<typeof readAllFields> } {
  const outer = readAllFields(frame)
  expect(outer.map((field) => [field.fn, field.wt])).toEqual([[5, 2]])
  const inner = readAllFields(outer[0]!.bytes!)
  expect(inner).toHaveLength(1)
  return { fn: inner[0]!.fn, fields: readAllFields(inner[0]!.bytes!) }
}

describe("buildGitDiffUnavailableMessages", () => {
  it("refuses exec #44 with throw then stream_close, without running Git", () => {
    const frames = buildGitDiffUnavailableMessages(44)
    expect(frames).toHaveLength(2)
    // ExecClientControlMessage.throw (#2): id=1, error=2.
    const thrown = control(frames[0]!)
    expect(thrown.fn).toBe(2)
    expect(thrown.fields.find((field) => field.fn === 1)?.varint).toBe(44)
    const error = new TextDecoder().decode(thrown.fields.find((field) => field.fn === 2)!.bytes)
    expect(error).toContain("advertised shell tool")
    // ExecClientControlMessage.stream_close (#1): id=1.
    const close = control(frames[1]!)
    expect(close.fn).toBe(1)
    expect(close.fields.find((field) => field.fn === 1)?.varint).toBe(44)
  })

  it("carries a caller's reason verbatim", () => {
    const thrown = control(buildGitDiffUnavailableMessages(7, "End this turn.")[0]!)
    expect(new TextDecoder().decode(thrown.fields.find((field) => field.fn === 2)!.bytes)).toBe("End this turn.")
  })
})
