import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pump, resetTurnStateForTests } from "../src/language-model.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { toolsToDescriptors } from "../src/protocol/tools.js"
import { sessionManager, type Frame } from "../src/session.js"
import { sessionFixture } from "./session-fixture.js"

afterEach(() => { sessionManager.dispose(); resetTurnStateForTests() })

function fixture(root: string, edit: boolean, existing: boolean) {
  const target = path.join(root, "file.txt")
  if (existing) fs.writeFileSync(target, "original\n")
  const messages = [
    ...(edit ? [{ interaction_update: { tool_call_started: {
      call_id: "edit", tool_call: { edit_tool_call: { args: { path: target } } },
    } } }] : []),
    { exec_server_message: { id: 1, read_args: { path: target, ...(edit ? { tool_call_id: "edit" } : {}) } } },
    { interaction_update: { turn_ended: { input_tokens: 1, output_tokens: 1 } } },
  ]
  const frames: Frame[] = messages.map((message) => ({ flags: 0, payload: encodeMessage("AgentServerMessage", message) }))
  let reads = 0
  const writes: Uint8Array[] = []
  const parts: Array<{ type: string }> = []
  const iterator = { next: async () => {
    reads++
    return frames.length ? { done: false as const, value: frames.shift()! } : { done: true as const, value: undefined }
  } }
  const tools = [{ name: "read", description: "Read" }, { name: "write", description: "Write" }]
  const session = sessionFixture({
    sessionId: "read-drain", conversationId: "read-drain-conversation",
    pending: new Map(), blobs: new Map(), displayToolCalls: new Map(), editToolCalls: new Map(),
    nextBridgedExecId: 900_000, pumpActive: false, heartbeat: null,
    usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
    stream: {
      write: (message) => { writes.push(message); return writes.length !== 1 },
      end() {}, destroy() {}, isClosed: () => false, onTerminal: () => () => {},
      frames: () => ({ [Symbol.asyncIterator]: () => iterator }),
    },
    frames: iterator, allowTools: true, toolCatalog: tools,
    toolDescriptors: toolsToDescriptors(tools), requestContext: { env: { workspace_paths: [root] } },
  })
  const controller = {
    enqueue(part: { type: string }) { parts.push(part) }, error(error: Error) { throw error },
  } as unknown as ReadableStreamDefaultController<any>
  return { session, writes, parts, controller, reads: () => reads }
}

describe("provider-owned read replies", () => {
  for (const [name, edit, existing] of [
    ["complete edit read", true, true], ["missing edit target", true, false], ["missing read target", false, false],
  ] as const) {
    it(`awaits drain before consuming another frame after a ${name}`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-read-drain-"))
      try {
        const f = fixture(root, edit, existing)
        let release!: () => void
        f.session.stream.waitForDrain = () => new Promise<void>((resolve) => { release = resolve })
        const pumping = pump(f.session, f.controller, { textId: "t", reasoningId: "r" })
        await new Promise((resolve) => setTimeout(resolve, 0))
        const whileBackpressured = { writes: f.writes.length, reads: f.reads(), waiting: typeof release === "function" }
        release?.()
        await pumping
        expect(whileBackpressured).toEqual({ writes: 1, reads: edit ? 2 : 1, waiting: true })
        expect(f.writes).toHaveLength(2)
        expect(decodeMessage<any>("AgentClientMessage", f.writes[1]!).exec_client_control_message.stream_close.id).toBe(1)
        expect(f.parts.some((part) => part.type === "tool-call")).toBe(false)
      } finally { fs.rmSync(root, { recursive: true, force: true }) }
    })
  }

  it("does not emit a host read after a buffered complete edit read fails to drain", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-read-failed-"))
    try {
      const f = fixture(root, true, true)
      f.session.stream.waitForDrain = async () => { throw new Error("stream closed during drain") }
      await expect(pump(f.session, f.controller, { textId: "t", reasoningId: "r" }))
        .rejects.toThrow("backpressure drain failed")
      expect(f.writes).toHaveLength(1)
      expect(f.parts.some((part) => part.type === "tool-call")).toBe(false)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
})
