import { hasHostHistoryRewrite, noteHostHistoryRewrite, resetHostHistoryRewritesForTests } from "../src/host-history-rewrite.js"
import { onCopyStateReplaced } from "../src/protocol/conversation-state.js"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import fs from "node:fs"
import http2 from "node:http2"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { APICallError, type LanguageModelV3, type LanguageModelV3CallOptions, type LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { createCursor } from "../src/index.js"
import { CursorAuthError, CursorRetryExhaustedError, CursorServerError, CursorTransportError } from "../src/errors.js"
import { decodeFramePayload } from "../src/protocol/framing.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { encodeJsonAsValue, readAllFields } from "../src/protocol/struct.js"
import { cacheHttp2SessionForTests, closeCachedHttp2SessionsForTests, CursorRunInterruptedError, frameArrival, lastFrameArrival } from "../src/transport/connect.js"
import { setHostCacheDirOverride } from "../src/context/paths.js"
import { sessionManager } from "../src/session.js"
import {
  releaseHostNoteInjectionsForTests, resetTurnStateForTests, restorePersistedHostNotes, settleRunSavesForTests,
} from "../src/language-model.js"
import { encodePersistedHostNotes } from "../src/protocol/host-notes.js"
import { resetConversationBindingsForTests } from "../src/protocol/conversation-bind.js"
import { resetCheckpointsForTests } from "../src/protocol/checkpoint.js"
import { resetConversationPersistenceForTests } from "../src/protocol/conversation-persistence.js"
import { recordPlanOperation, resetPlanOperationsForTests } from "../src/protocol/plan-operations.js"
import { notifyHostInterrupt } from "../src/host-interrupt.js"
import { resetActiveCursorModesForTests, setActiveCursorMode, takeActiveCursorModeReminder } from "../src/protocol/switch-mode.js"
import { CURSOR_COMPACTION_OPTION } from "../src/shared.js"

const ORIGIN = "https://agentn.run-error-test.cursor.sh"
const PROXY_KEYS = ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"] as const
// ErrorDetails{error:13, details{title, detail, is_retryable:false, analytics}, is_expected:true}, as Cursor sent it.
const POLICY_BLOCK = "CA0SlgEKHFJlcXVlc3QgYmxvY2tlZCBieSBBbnRocm9waWMSXVdlIGFyZSB1bmFibGUgdG8gY29tcGxldGUgdGhpcyByZXF1ZXN0IGJlY2F1c2UgaXQgd2FzIGJsb2NrZWQgdW5kZXIgQW50aHJvcGljJ3MgVXNhZ2UgUG9saWN5LiAAUhUKE2N5YmVyX3BvbGljeV9yZXZpZXcYAQ"

let server: http2.Http2Server
let client: http2.ClientHttp2Session
let trailer: Record<string, unknown> = {}
let runs = 0
let partialOutput = false
let bareEof = false
let scripted: ((stream: http2.ServerHttp2Stream, message: Record<string, unknown>) => void) | undefined
const savedProxy: Record<string, string | undefined> = {}

function varint(value: number): number[] {
  const out: number[] = []
  while (value > 0x7f) {
    out.push((value & 0x7f) | 0x80)
    value >>>= 7
  }
  out.push(value)
  return out
}

function frame(payload: Uint8Array, flags = 0): Buffer {
  const header = Buffer.alloc(5)
  header[0] = flags
  header.writeUInt32BE(payload.length, 1)
  return Buffer.concat([header, Buffer.from(payload)])
}

beforeAll(async () => {
  for (const key of PROXY_KEYS) {
    savedProxy[key] = process.env[key]
    delete process.env[key]
  }
  server = http2.createServer()
  server.on("stream", (stream) => {
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" })
    stream.on("error", () => {})
    let pending = Buffer.alloc(0)
    stream.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk])
      while (pending.length >= 5) {
        const length = pending.readUInt32BE(1)
        if (pending.length < 5 + length) break
        const message = decodeMessage<Record<string, unknown>>("AgentClientMessage", decodeFramePayload({ flags: pending[0]!, payload: pending.subarray(5, 5 + length) }))
        pending = pending.subarray(5 + length)
        if (scripted) { scripted(stream, message); continue }
        if (!message.run_request) continue
        runs++
        if (partialOutput) {
          stream.write(frame(encodeMessage("AgentServerMessage", {
            interaction_update: { thinking_delta: { text: "Already delivered" } },
          })))
        }
        if (!bareEof) stream.write(frame(Buffer.from(JSON.stringify(trailer)), 2))
        stream.end()
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address() as net.AddressInfo
  client = http2.connect(`http://127.0.0.1:${address.port}`)
  await new Promise<void>((resolve, reject) => {
    client.once("connect", () => resolve())
    client.once("error", reject)
  })
})

afterAll(async () => {
  closeCachedHttp2SessionsForTests()
  client?.destroy()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  for (const key of PROXY_KEYS) {
    if (savedProxy[key] === undefined) delete process.env[key]
    else process.env[key] = savedProxy[key]
  }
})

afterEach(() => {
  setHostCacheDirOverride(undefined)
  sessionManager.dispose()
  resetTurnStateForTests()
  resetHostHistoryRewritesForTests()
  resetConversationPersistenceForTests()
  resetConversationBindingsForTests()
  resetCheckpointsForTests()
  runs = 0
  partialOutput = false
  bareEof = false
  scripted = undefined
})

async function streamError(sessionKey: string): Promise<unknown> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-run-error-"))
  cacheHttp2SessionForTests(ORIGIN, client)
  try {
    const model = createCursor({
      name: "cursor", accessToken: "example-token", agentBaseURL: ORIGIN, cacheDir: root,
      retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
    })
      .languageModel("composer-2.5")
    const { stream } = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      headers: { "x-opencode-session-id": sessionKey },
    } as LanguageModelV3CallOptions)
    const reader = stream.getReader()
    for (;;) {
      const { done } = await reader.read()
      if (done) return undefined
    }
  } catch (error) {
    return error
  } finally {
    await settleRunSavesForTests()
    fs.rmSync(root, { recursive: true, force: true })
  }
}

describe("a Run resumed from a checkpoint", () => {
  it("records the checkpoint it started from, so Cursor sending it back is no progress", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-seeded-resume-"))
    const checkpoint = Uint8Array.of(10, 1, 9)
    const key = "ses_seeded_resume"
    let sentState: Uint8Array | undefined
    let recorded: Uint8Array | undefined
    scripted = (stream, message) => {
      if (!message.run_request) return
      const send = (value: Record<string, unknown>) => stream.write(frame(encodeMessage("AgentServerMessage", value)))
      runs++
      if (runs === 1) {
        send({ conversation_checkpoint_update: checkpoint })
        stream.end(frame(Buffer.from('{"error":{"code":"unavailable"}}'), 2))
        return
      }
      sentState = (message.run_request as { conversation_state?: Uint8Array }).conversation_state
      void (async () => {
        for (let i = 0; i < 200 && !recorded; i++) {
          recorded = sessionManager.findOpenByOpenCodeSessionId(key)?.resumedFromCheckpoint
          if (!recorded) await new Promise(resolve => setTimeout(resolve, 10))
        }
        send({ interaction_update: { turn_ended: {} } })
        stream.end()
      })()
    }
    cacheHttp2SessionForTests(ORIGIN, client)
    try {
      const model = createCursor({ name: "cursor", accessToken: "example-token", agentBaseURL: ORIGIN, cacheDir: root,
        retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 } }).languageModel("composer-2.5")
      const turn = async (prompt: LanguageModelV3CallOptions["prompt"]) => {
        const { stream } = await model.doStream({ prompt, headers: { "x-opencode-session-id": key } } as LanguageModelV3CallOptions)
        const reader = stream.getReader()
        while (!(await reader.read()).done) { /* drain */ }
      }
      await turn([{ role: "user", content: [{ type: "text", text: "Hello" }] }])
    } finally {
      await settleRunSavesForTests()
      fs.rmSync(root, { recursive: true, force: true })
    }
    expect(runs).toBe(2)
    expect(Array.from(sentState ?? [])).toEqual([10, 1, 9])
    expect(Array.from(recorded ?? [])).toEqual([10, 1, 9])
  })
})

describe("checkpoint eligibility across host results", () => {
  const readParts = async (model: LanguageModelV3, options: LanguageModelV3CallOptions) => {
    const parts: LanguageModelV3StreamPart[] = []
    const { stream } = await model.doStream(options)
    const reader = stream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return parts
      parts.push(value)
    }
  }
  const appendResult = (prompt: LanguageModelV3CallOptions["prompt"], parts: LanguageModelV3StreamPart[], output: string) => {
    const call = parts.find(part => part.type === "tool-call")
    if (!call || call.type !== "tool-call") throw new Error("Expected a host tool call")
    prompt.push({ role: "assistant", content: [{ type: "tool-call", toolCallId: call.toolCallId, toolName: call.toolName, input: JSON.parse(call.input) }] })
    prompt.push({ role: "tool", content: [{ type: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, output: { type: "text", value: output } }] })
  }

  for (const scenario of ["finished", "held", "restart"] as const) {
    it(`rebases committed foreign compaction from ${scenario} and keeps the next turn warm`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-foreign-compaction-"))
      const key = `ses_foreign_compaction_${scenario}`
      const checkpoint = Uint8Array.of(0x2a, 5, 8, 42, 16, 0x80, 2)
      type Request = { conversation_id: string; conversation_group_id: string; conversation_state?: Uint8Array;
        action: { resume_action?: unknown; user_message_action?: { user_message: { text: string } } } }
      const requests: Request[] = []
      scripted = (stream, message) => {
        if (!message.run_request) return
        requests.push(message.run_request as Request)
        const send = (value: Record<string, unknown>) => stream.write(frame(encodeMessage("AgentServerMessage", value)))
        send({ conversation_checkpoint_update: checkpoint })
        if (scenario === "held" && requests.length === 1) {
          send({ exec_server_message: { id: 1, shell_args: { command: "echo done", tool_call_id: "command" } } })
        } else {
          send({ interaction_update: { text_delta: { text: "Cursor answer" } } })
          send({ interaction_update: { turn_ended: {} } })
          stream.end()
        }
      }
      cacheHttp2SessionForTests(ORIGIN, client)
      try {
        const model = createCursor({ name: "cursor", accessToken: "example-token", agentBaseURL: ORIGIN,
          cacheDir: root, workspaceRoot: root }).languageModel("composer-2.5")
        const prompt: LanguageModelV3CallOptions["prompt"] = [{ role: "user", content: [{ type: "text", text: "Original large history" }] }]
        const options: LanguageModelV3CallOptions = { prompt, headers: { "x-opencode-session-id": key },
          tools: [{ type: "function", name: "bash", inputSchema: { type: "object", properties: { command: { type: "string" } } } }] }
        // Fork: a note the held Run carries is not in the compacted history and must reach the replacement Run.
        if (scenario === "held") restorePersistedHostNotes(key, encodePersistedHostNotes(["<system-update>Use bazel for builds.</system-update>"]))
        const parts = await readParts(model, options)
        if (scenario === "held") expect(requests[0]!.action.user_message_action!.user_message.text).toContain("Use bazel for builds.")
        if (scenario === "held") {
          appendResult(prompt, parts, "COMPLETED_HOST_RESULT")
          await notifyHostInterrupt(key, "shutdown")
        } else prompt.push({ role: "assistant", content: [{ type: "text", text: "Cursor answer" }] })
        await noteHostHistoryRewrite(root, key, "evt_compacted")
        if (scenario === "restart") {
          sessionManager.dispose()
          await settleRunSavesForTests()
          resetTurnStateForTests()
          resetHostHistoryRewritesForTests()
          resetConversationPersistenceForTests()
          resetConversationBindingsForTests()
          resetCheckpointsForTests()
        }
        if (scenario === "restart") {
          // A title request can hydrate the snapshot before the main request.
          await readParts(model, { ...options, tools: [], prompt: [
            { role: "user", content: [{ type: "text", text: "Generate a title" }] },
          ] })
        }
        const replacementIndex = requests.length
        // Native compaction replaces the prefix while retaining a recent tail.
        prompt[0] = { role: "user", content: [{ type: "text", text: "COMPACTED_HOST_SUMMARY" }] }
        if (scenario !== "held") prompt.push({ role: "user", content: [{ type: "text", text: "Continue" }] })
        expect((await readParts(model, options)).some(part => part.type === "finish")).toBe(true)
        expect(requests).toHaveLength(replacementIndex + 1)
        expect(requests[replacementIndex]!.conversation_id).not.toBe(requests[0]!.conversation_id)
        expect(requests[replacementIndex]!.conversation_group_id).toBe(requests[0]!.conversation_group_id)
        expect(requests[replacementIndex]!.conversation_state?.length ?? 0).toBe(0)
        expect(requests[replacementIndex]!.action.resume_action).toBeUndefined()
        const seed = requests[replacementIndex]!.action.user_message_action!.user_message.text
        expect(seed).toContain("COMPACTED_HOST_SUMMARY")
        expect(seed).not.toContain("Original large history")
        if (scenario === "held") expect(seed).toContain("COMPLETED_HOST_RESULT")
        if (scenario === "held") expect(seed.split("Use bazel for builds.")).toHaveLength(2)
        expect(hasHostHistoryRewrite(root, key)).toBe(false)
        prompt.push({ role: "assistant", content: [{ type: "text", text: "Cursor answer" }] },
          { role: "user", content: [{ type: "text", text: "Next warm turn" }] })
        await readParts(model, options)
        expect(requests).toHaveLength(replacementIndex + 2)
        expect(requests[replacementIndex + 1]!.conversation_id).toBe(requests[replacementIndex]!.conversation_id)
        expect(requests[replacementIndex + 1]!.conversation_state).toEqual(checkpoint)
      } finally {
        sessionManager.dispose()
        await settleRunSavesForTests()
        setHostCacheDirOverride(undefined)
        fs.rmSync(root, { recursive: true, force: true })
      }
    })
  }

  for (const checkpointAt of ["prefix-drain", "final-drain"] as const) {
    it(`uses the actual result write cutoff when a checkpoint arrives during ${checkpointAt}`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-result-drain-"))
      const checkpoint = Uint8Array.of(10, 1, 8)
      let resumed = false
      let resumedState: Uint8Array | undefined
      let blocked = false
      let checkpointSent = false
      let checkpointArrivedDuringDrain = false
      let boundary = 0
      let drainDone!: () => void
      const drained = new Promise<void>(resolve => { drainDone = resolve })
      scripted = (stream, message) => {
        const send = (value: Record<string, unknown>) => stream.write(frame(encodeMessage("AgentServerMessage", value)))
        if (message.run_request) {
          runs++
          resumed = !!(message.run_request as { action?: { resume_action?: unknown } }).action?.resume_action
          resumedState = (message.run_request as { conversation_state?: Uint8Array }).conversation_state
          if (runs > 1) {
            send({ interaction_update: { turn_ended: {} } })
            stream.end()
          } else send({ exec_server_message: { id: 1, shell_stream_args: { command: "echo done", tool_call_id: "command" } } })
          return
        }
        const control = message.exec_client_control_message as { stream_close?: { id: number } } | undefined
        const result = message.exec_client_message as { shell_stream?: { start?: unknown } } | undefined
        if (!checkpointSent && (checkpointAt === "final-drain" ? control?.stream_close?.id === 1 : result?.shell_stream?.start)) {
          checkpointSent = true
          if (checkpointAt === "final-drain") send({ interaction_update: { tool_call_completed: { call_id: "command" } } })
          send({ conversation_checkpoint_update: checkpoint })
        }
        if (control?.stream_close?.id === 1) {
          void drained.then(() => new Promise<void>(resolve => setImmediate(resolve))).then(() => {
            send({ interaction_update: { thinking_delta: { text: "after the result" } } })
            stream.end(frame(Buffer.from('{"error":{"code":"unavailable"}}'), 2))
          })
        }
      }
      cacheHttp2SessionForTests(ORIGIN, client)
      try {
        const key = `ses_checkpoint_${checkpointAt}`
        const model = createCursor({ name: "cursor", accessToken: "example-token", agentBaseURL: ORIGIN, cacheDir: root,
          workspaceRoot: root, retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 } }).languageModel("composer-2.5")
        const prompt: LanguageModelV3CallOptions["prompt"] = [{ role: "user", content: [{ type: "text", text: "Run the command" }] }]
        const options: LanguageModelV3CallOptions = { prompt, headers: { "x-opencode-session-id": key },
          tools: [{ type: "function", name: "bash", inputSchema: { type: "object", properties: { command: { type: "string" } } } }] }
        appendResult(prompt, await readParts(model, options), "done")
        const held = sessionManager.findOpenByOpenCodeSessionId(key)!
        const write = held.stream.write.bind(held.stream)
        const waitForDrain = held.stream.waitForDrain?.bind(held.stream)
        held.stream.write = bytes => {
          const message = decodeMessage<{ exec_client_message?: { shell_stream?: { start?: unknown } }; exec_client_control_message?: { stream_close?: { id: number } } }>("AgentClientMessage", bytes)
          const block = checkpointAt === "final-drain"
            ? message.exec_client_control_message?.stream_close?.id === 1
            : !!message.exec_client_message?.shell_stream?.start
          if (block) { blocked = true; boundary = lastFrameArrival() }
          const accepted = write(bytes)
          return block ? false : accepted
        }
        held.stream.waitForDrain = async () => {
          if (!blocked) { await waitForDrain?.(); return }
          const arrived = () => held.heldFrames?.some(queued => {
            if ((frameArrival(queued) ?? 0) <= boundary) return false
            const message = decodeMessage<{ conversation_checkpoint_update?: Uint8Array }>("AgentServerMessage", queued.payload)
            return message.conversation_checkpoint_update?.every((byte, index) => byte === checkpoint[index])
              && message.conversation_checkpoint_update.length === checkpoint.length
          }) ?? false
          for (let i = 0; i < 200 && !arrived(); i++) await new Promise(resolve => setTimeout(resolve, 1))
          checkpointArrivedDuringDrain = arrived()
          expect(checkpointArrivedDuringDrain).toBe(true)
          blocked = false
          drainDone()
        }
        if (checkpointAt === "final-drain") {
          expect((await readParts(model, options)).some(part => part.type === "finish" && part.finishReason.unified === "stop")).toBe(true)
          expect(resumed).toBe(true)
          expect(resumedState).toEqual(checkpoint)
          expect(runs).toBe(2)
        } else {
          // The checkpoint predates the delivered result, so the turn is rebuilt from history instead.
          expect((await readParts(model, options)).some(part => part.type === "finish" && part.finishReason.unified === "stop")).toBe(true)
          expect(resumed).toBe(false)
          expect(runs).toBe(2)
        }
        expect(checkpointArrivedDuringDrain).toBe(true)
      } finally {
        drainDone()
        sessionManager.dispose()
        await settleRunSavesForTests()
        setHostCacheDirOverride(undefined)
        fs.rmSync(root, { recursive: true, force: true })
      }
    }, 30_000)
  }

  for (const [nextId, incomplete, opaque, lateCompletion] of [
    [1, false, false, false], [2, false, false, false], [2, true, false, false],
    [2, false, true, false], [2, false, false, true],
  ] as const) {
    it(`recovers after a resumed Run's completed exec (id=${nextId}, incomplete=${incomplete}, opaque=${opaque}, lateCompletion=${lateCompletion})`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-resumed-result-"))
      const requests: Array<{ conversation_id: string; action: { resume_action?: unknown; user_message_action?: { user_message: { text: string } } } }> = []
      const contexts: Uint8Array[] = []
      const delivered = new Set<string>()
      scripted = (stream, message) => {
        const send = (value: Record<string, unknown>) => stream.write(frame(encodeMessage("AgentServerMessage", value)))
        if (message.run_request) {
          requests.push(message.run_request as typeof requests[number])
          if (requests.length === 3) { send({ interaction_update: { turn_ended: {} } }); stream.end(); return }
          send({ exec_server_message: { id: 90, request_context_args: {} } })
          if (requests.length === 1 && opaque) stream.write(frame(Uint8Array.of(0xa2, 0x06, 0)))
          send({ interaction_update: { tool_call_started: { call_id: `command-${requests.length}` } } })
          send({ exec_server_message: { id: requests.length === 1 ? 1 : nextId,
            shell_args: { command: `echo step-${requests.length}`, tool_call_id: `command-${requests.length}` } } })
        } else if (message.exec_client_message) {
          const reply = message.exec_client_message as { request_context_result?: { success?: { request_context?: Record<string, unknown> } } }
          const context = reply.request_context_result?.success?.request_context
          if (context) contexts.push(encodeMessage("RequestContext", context))
        } else if (message.exec_client_control_message) {
          const close = (message.exec_client_control_message as { stream_close?: { id: number } }).stream_close
          const key = `${requests.length}:${close?.id}`
          if (!close || close.id !== (requests.length === 1 ? 1 : nextId) || delivered.has(key)) return
          delivered.add(key)
          send({ interaction_update: { tool_call_completed: { call_id: `command-${requests.length}` } } })
          if (requests.length === 1) {
            send({ conversation_checkpoint_update: Uint8Array.of(10, 1, 9) })
            send({ interaction_update: { thinking_delta: { text: "checkpointed first result" } } })
            stream.end(frame(Buffer.from('{"error":{"code":"unavailable"}}'), 2))
          } else {
            // A resumed conversation can still complete an older display call.
            if (lateCompletion) send({ interaction_update: { tool_call_completed: { call_id: "command-1" } } })
            stream.end()
          }
        }
      }
      cacheHttp2SessionForTests(ORIGIN, client)
      try {
        const model = createCursor({ name: "cursor", accessToken: "example-token", agentBaseURL: ORIGIN, cacheDir: root,
          workspaceRoot: root, retry: { baseDelayMs: 1, maxDelayMs: 1 } }).languageModel("composer-2.5")
        const prompt: LanguageModelV3CallOptions["prompt"] = [{ role: "user", content: [{ type: "text", text: "Run both commands" }] }]
        const options: LanguageModelV3CallOptions = { prompt, headers: { "x-opencode-session-id": `ses_resume_owners_${nextId}_${incomplete}_${opaque}_${lateCompletion}` },
          tools: [{ type: "function", name: "bash", inputSchema: { type: "object", properties: { command: { type: "string" } } } }] }
        appendResult(prompt, await readParts(model, options), "first command completed")
        appendResult(prompt, await readParts(model, options), "second command completed")
        expect(requests).toHaveLength(2)
        expect(requests[1]!.action.resume_action).toBeDefined()
        expect(requests[1]!.conversation_id).toBe(requests[0]!.conversation_id)
        for (let i = 0; i < 200 && contexts.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 1))
        expect(contexts).toHaveLength(2)
        const beforeContext = decodeMessage<Record<string, unknown>>("RequestContext", contexts[0]!)
        const afterContext = decodeMessage<Record<string, unknown>>("RequestContext", contexts[1]!)
        const changed = [...new Set([...Object.keys(beforeContext), ...Object.keys(afterContext)])]
          .filter(key => JSON.stringify(beforeContext[key]) !== JSON.stringify(afterContext[key]))
        expect(changed).toEqual([])
        if (incomplete) prompt.splice(1, 2)
        if (incomplete || opaque) {
          expect(await readParts(model, options).catch((error: unknown) => error)).toMatchObject({ isRetryable: false })
          expect(requests).toHaveLength(2)
        } else {
          expect((await readParts(model, options)).some(part => part.type === "finish" && part.finishReason.unified === "stop")).toBe(true)
          expect(requests).toHaveLength(3)
          expect(requests[2]!.action.resume_action).toBeUndefined()
          expect(requests[2]!.conversation_id).not.toBe(requests[0]!.conversation_id)
          const text = requests[2]!.action.user_message_action!.user_message.text
          expect(text.match(/first command completed/g)).toHaveLength(1)
          expect(text.match(/second command completed/g)).toHaveLength(1)
        }
        expect(delivered.size).toBe(2)
      } finally {
        sessionManager.dispose()
        await settleRunSavesForTests()
        setHostCacheDirOverride(undefined)
        fs.rmSync(root, { recursive: true, force: true })
      }
    }, 30_000)
  }

  for (const scenario of [
    "complete", "announced", "announced-shell", "missing-history", "unknown", "provider-answered-exec", "duplicate-exec",
    "followup-before-result", "new-output", "final-error", "cursor-run-call", "unannounced-completion", "oversized",
    "malformed-completion", "repeated-completion-id", "announced-open",
    "next-call-announced", "provider-exec-after-result", "edit-in-progress", "interaction-after-result",
    "inline-catalog", "spilled-catalog", "unfinished-catalog", "unacknowledged-checkpoint",
    "catalog-lookup", "catalog-lookup-open", "cursor-run-completed", "catalog-lookup-mismatch",
    "catalog-lookup-unknown-variant", "catalog-lookup-reused-id",
    "terminal-poll", "terminal-poll-after-result", "mcp-terminal-poll", "refusal-before-result", "refusal-after-result",
    "missing-read", "missing-read-after-result", "refused-read", "new-file-edit",
    "handshake-without-write", "task-attachment", "plan-refusal",
  ] as const) {
    it(`recovers a post-result drop only from represented completed work (${scenario})`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-result-history-"))
      type RunRequest = { conversation_id: string; action: { resume_action?: unknown; user_message_action?: { user_message: { text: string } } } }
      const requests: RunRequest[] = []
      const delivered: number[] = []
      // Cursor announces each host call before its exec and closes it after the result.
      const lifecycle = scenario === "announced" || scenario === "announced-shell" || scenario === "cursor-run-call"
        || scenario === "unannounced-completion" || scenario === "oversized"
        || scenario === "malformed-completion" || scenario === "repeated-completion-id" || scenario === "announced-open"
      const shellVariant = scenario === "announced-shell" ? "shell_args" : "shell_stream_args"
      const newFileEdit = scenario === "new-file-edit"
      const fileReads = newFileEdit || scenario === "missing-read" || scenario === "missing-read-after-result"
      scripted = (stream, message) => {
        const send = (value: Record<string, unknown>) => stream.write(frame(encodeMessage("AgentServerMessage", value)))
        const shell = (callId: string, command: string) => ({ shell_tool_call: { args: { command, tool_call_id: callId } } })
        const started = (callId: string, command: string) => {
          if (lifecycle) send({ interaction_update: { tool_call_started: { call_id: callId, tool_call: shell(callId, command) } } })
        }
        const completed = (callId: string, command: string) => {
          if (lifecycle) send({ interaction_update: { tool_call_completed: { call_id: callId, tool_call: shell(callId, command) } } })
        }
        if (message.run_request) {
          requests.push(message.run_request as RunRequest)
          if (requests.length > (scenario === "followup-before-result" ? 2 : 1)) {
            send({ interaction_update: { turn_ended: {} } })
            stream.end()
            return
          }
          if (requests.length === 1) send({ conversation_checkpoint_update: Uint8Array.of(10, 1, 7) })
          if (scenario === "followup-before-result" && requests.length === 1) {
            send({ interaction_update: { text_delta: { text: "Checking the workspace" } } })
            send({ interaction_update: { turn_ended: {} } })
            return
          }
          if (scenario === "unknown") stream.write(frame(Uint8Array.of(0xa2, 0x06, 0))) // unknown field 100
          if (scenario === "provider-answered-exec") send({ exec_server_message: { id: 90, list_mcp_resources_exec_args: {} } })
          if (scenario === "duplicate-exec") send({ exec_server_message: { id: 1, list_mcp_resources_exec_args: {} } })
          // A call Cursor runs itself: announced, never claimed by a host exec.
          if (scenario === "cursor-run-call") send({ interaction_update: { tool_call_started: { call_id: "cursor-internal" } } })
          if (scenario === "inline-catalog" || scenario === "spilled-catalog" || scenario === "unfinished-catalog") {
            const args = { server: "opencode", tool_name: "bash" }
            send({ interaction_update: { tool_call_started: { call_id: "catalog", tool_call: {
              get_mcp_tools_tool_call: { args },
            } } } })
            if (scenario !== "unfinished-catalog") send({ interaction_update: { tool_call_completed: { call_id: "catalog", tool_call: {
              get_mcp_tools_tool_call: { args, result: { success: {
                content: "bash: run a command", ...(scenario === "spilled-catalog" ? { output_file_path: "/catalog.json" } : {}),
              } } },
            } } } })
          }
          // Cursor looks up an MCP tool in the catalog the provider sent, on its own side.
          if (scenario === "catalog-lookup" || scenario === "catalog-lookup-open") {
            // As Cursor sends them: the lookup, its tool_call_id #57 and varints #59 (and #60 on completion).
            const args = { server: "opencode", tool_name: "slack_read" }
            const lifecycle = (field: 2 | 3, toolCall: Record<string, unknown>, scalars: number[]) => {
              const body = [...encodeMessage("ToolCall", { ...toolCall, tool_call_id: "lookup" }), ...scalars]
              const callId = [0x0a, 6, ...Buffer.from("lookup")]
              const update = [...callId, 0x12, ...varint(body.length), ...body]
              const iu = [(field << 3) | 2, ...varint(update.length), ...update]
              stream.write(frame(Uint8Array.from([0x0a, ...varint(iu.length), ...iu])))
            }
            lifecycle(2, { get_mcp_tools_tool_call: { args } }, [0xd8, 0x03, 0x01])
            if (scenario === "catalog-lookup") {
              lifecycle(3, { get_mcp_tools_tool_call: { args, result: { success: { content: "slack_read(channel: string)" } } } },
                [0xd8, 0x03, 0x01, 0xe0, 0x03, 0x02])
            }
          }
          if (scenario === "catalog-lookup-unknown-variant") {
            // ToolCall{get_mcp_tools #44, unknown variant #99}: the decoder keeps only the lookup.
            const lookup = encodeMessage("ToolCall", { get_mcp_tools_tool_call: { args: { server: "opencode", tool_name: "slack_read" } } })
            const toolCall = [...lookup, 0x9a, 0x06, 0]
            const callId = [0x0a, 6, ...Buffer.from("lookup")]
            for (const field of [2, 3]) {
              const update = [...callId, 0x12, toolCall.length, ...toolCall]
              const iu = [(field << 3) | 2, update.length, ...update]
              stream.write(frame(Uint8Array.from([0x0a, iu.length, ...iu])))
            }
          }
          if (scenario === "catalog-lookup-reused-id") {
            const fetch = { web_fetch_tool_call: { args: { url: "https://example.com" } } }
            const lookup = { get_mcp_tools_tool_call: { args: { server: "opencode", tool_name: "slack_read" } } }
            for (const toolCall of [fetch, lookup]) {
              send({ interaction_update: { tool_call_started: { call_id: "reused", tool_call: toolCall } } })
              send({ interaction_update: { tool_call_completed: { call_id: "reused", tool_call: toolCall } } })
            }
          }
          if (scenario === "cursor-run-completed" || scenario === "catalog-lookup-mismatch") {
            const fetch = { web_fetch_tool_call: { args: { url: "https://example.com" } } }
            send({ interaction_update: { tool_call_started: { call_id: "fetch", tool_call: fetch } } })
            // A completion naming another variant does not turn the fetch Cursor ran into a lookup.
            const done = scenario === "catalog-lookup-mismatch"
              ? { get_mcp_tools_tool_call: { args: { server: "opencode", tool_name: "slack_read" } } }
              : fetch
            send({ interaction_update: { tool_call_completed: { call_id: "fetch", tool_call: done } } })
          }
          started("first", "echo first")
          send({ exec_server_message: { id: 1, [shellVariant]: { command: "echo first", tool_call_id: "first" } } })
        } else if (message.exec_client_message) {
          const id = (message.exec_client_message as { id: number }).id
          // A result is complete with its exit; a large stdout arrives first.
          const hostReply = message.exec_client_message as {
            shell_stream?: { exit?: unknown }; shell_result?: unknown; write_result?: unknown; subagent_result?: unknown
          }
          if ((!hostReply.shell_stream?.exit && !hostReply.shell_result && !hostReply.write_result && !hostReply.subagent_result)
            || delivered.includes(id)) return
          delivered.push(id)
          if (id === 1) {
            completed("first", "echo first")
            // AwaitShell: Cursor polls the terminal record of a background shell; the provider answers each read.
            if (scenario === "terminal-poll") {
              const env = sessionManager.findOpenByOpenCodeSessionId(`ses_result_history_${scenario}`)!.requestContext.env as { project_folder: string }
              const record = path.join(env.project_folder, "terminals", "7.txt")
              fs.mkdirSync(path.dirname(record), { recursive: true })
              fs.writeFileSync(record, "running\n")
              for (const poll of [50, 51, 52]) {
                send({ exec_server_message: { id: poll, read_args: { path: record, tool_call_id: `poll-${poll}` } } })
              }
            }
            // Fork: the same poll through the advertised canonical read over MCP.
            if (scenario === "mcp-terminal-poll") {
              const env = sessionManager.findOpenByOpenCodeSessionId(`ses_result_history_${scenario}`)!.requestContext.env as { project_folder: string }
              const record = path.join(env.project_folder, "terminals", "7.txt")
              fs.mkdirSync(path.dirname(record), { recursive: true })
              fs.writeFileSync(record, "running\n")
              const struct = readAllFields(encodeJsonAsValue({ filePath: record })).find((field) => field.fn === 5)!.bytes!
              const args = readAllFields(struct).map((field) => field.bytes!)
              send({ exec_server_message: { id: 50, mcp_args: { name: "opencode-read", args, tool_call_id: "poll-mcp" } } })
            }
            // Fork: a refusal earlier in the Run (here of a tool the host does not offer) ran nothing on the host.
            if (scenario === "refusal-before-result") send({ exec_server_message: { id: 50, grep_args: { pattern: "first" } } })
            // The provider answers a read of a missing path itself, with a typed file_not_found.
            // Without an advertised `read` (`refused-read`) it refuses the call instead; fork: a refusal needs no result.
            if (scenario === "missing-read" || scenario === "refused-read") {
              send({ exec_server_message: { id: 60, read_args: { path: path.join(root, "absent.txt"), tool_call_id: "absent" } } })
            }
            // A new file's edit: the provider answers its read with an empty file, then the write goes to the host.
            if (newFileEdit) {
              const target = path.join(root, "created.txt")
              send({ interaction_update: { tool_call_started: { call_id: "edit", tool_call: { edit_tool_call: { args: { path: target } } } } } })
              send({ exec_server_message: { id: 61, read_args: { path: target, tool_call_id: "edit" } } })
              send({ exec_server_message: { id: 2, write_args: { path: target, file_text: "created\n", tool_call_id: "edit" } } })
            } else if (scenario === "handshake-without-write") {
              // Cursor ends the edit after its handshake read without a write: no host result stands for the read.
              const edit = { edit_tool_call: { args: { path: "created.txt" } } }
              send({ interaction_update: { tool_call_started: { call_id: "edit", tool_call: edit } } })
              send({ exec_server_message: { id: 60, read_args: { path: "created.txt", tool_call_id: "edit" } } })
              send({ interaction_update: { tool_call_completed: { call_id: "edit", tool_call: edit } } })
              started("second", "echo second")
              send({ exec_server_message: { id: 2, [shellVariant]: { command: "echo second", tool_call_id: "second" } } })
            } else if (scenario === "task-attachment") {
              // The provider answers a Task's attachment read; the Task's own result stands for it.
              const args = { description: "Describe the shot", prompt: "Describe the attached image.", attachments: ["shot.png"] }
              send({ interaction_update: { tool_call_started: { call_id: "second", tool_call: { task_tool_call: { args } } } } })
              send({ exec_server_message: { id: 60, read_args: { path: "shot.png", tool_call_id: "second" } } })
              send({ exec_server_message: { id: 2, subagent_args: { tool_call_id: "second", prompt: args.prompt, subagent_type: "generalPurpose" } } })
            } else {
              started("second", "echo second")
              send({ exec_server_message: { id: 2, [shellVariant]: { command: "echo second", tool_call_id: "second" } } })
            }
            // A refused plan exit ends the turn, so a cut after the step's result stays refused.
            if (scenario === "plan-refusal") send({ exec_server_message: { id: 50, mcp_args: { name: "opencode-plan_exit", args: [], tool_call_id: "plan" } } })
          } else {
            // The Run can drop before Cursor closes the last call.
            if (scenario !== "announced-open") completed("second", "echo second")
            // A poll after the last result belongs to the cut step itself, so the rebuild would lose it.
            if (scenario === "terminal-poll-after-result") {
              const env = sessionManager.findOpenByOpenCodeSessionId(`ses_result_history_${scenario}`)!.requestContext.env as { project_folder: string }
              send({ exec_server_message: { id: 50, read_args: { path: path.join(env.project_folder, "terminals", "7.txt") } } })
            }
            // Fork: a refusal in the cut step is as final as a poll there.
            if (scenario === "refusal-after-result") send({ exec_server_message: { id: 51, grep_args: { pattern: "second" } } })
            // A provider answer after the last result belongs to the cut attempt.
            if (scenario === "missing-read-after-result") {
              send({ exec_server_message: { id: 60, read_args: { path: path.join(root, "absent.txt"), tool_call_id: "absent" } } })
            }
            if (scenario === "malformed-completion" || scenario === "repeated-completion-id") {
              // Independent lifecycle wire: completion #3, call_id #1.
              // The decoder discards the unknown field or duplicate call id.
              const callId = [0x0a, 5, ...Buffer.from("first")]
              const body = [...callId, ...(scenario === "malformed-completion" ? [0x9a, 0x06, 0] : callId)]
              stream.write(frame(Uint8Array.from([0x0a, body.length + 2, 0x1a, body.length, ...body])))
            }
            if (scenario === "unannounced-completion") send({ interaction_update: { tool_call_completed: { call_id: "never-started" } } })
            if (scenario === "new-output") send({ interaction_update: { text_delta: { text: "new output" } } })
            // The next step had begun when the Run dropped; nothing of it ran on the host.
            if (scenario === "edit-in-progress") send({ interaction_update: { text_delta: { text: "Fixing the test next." } } })
            if (scenario === "next-call-announced" || scenario === "edit-in-progress") {
              send({ interaction_update: { tool_call_started: { call_id: "third", tool_call: shell("third", "echo third") } } })
            }
            if (scenario === "provider-exec-after-result" || scenario === "edit-in-progress") {
              send({ exec_server_message: { id: 3, list_mcp_resources_exec_args: {} } })
            }
            if (scenario === "interaction-after-result") send({ interaction_query: { id: 4, web_search_request_query: new Uint8Array() } })
            // Arrival after a local write does not prove the checkpoint holds its result.
            if (scenario === "unacknowledged-checkpoint") send({ conversation_checkpoint_update: Uint8Array.of(10, 1, 7) })
            if (scenario === "final-error") stream.end(frame(Buffer.from('{"error":{"code":"permission_denied"}}'), 2))
            else stream.end() // no checkpoint after either completed result
          }
        }
      }
      cacheHttp2SessionForTests(ORIGIN, client)
      try {
        const model = createCursor({ name: "cursor", accessToken: "example-token", agentBaseURL: ORIGIN,
          workspaceRoot: root, cacheDir: root, retry: { baseDelayMs: 1, maxDelayMs: 1 } }).languageModel("composer-2.5")
        const prompt: LanguageModelV3CallOptions["prompt"] = [{ role: "user", content: [{ type: "text", text: "Run both commands" }] }]
        // Fork: the tools of the fork's own scenarios.
        const tool = (name: string) => ({ type: "function" as const, name, inputSchema: { type: "object", properties: {
          ...name === "read" || name === "write" || name === "edit" ? { filePath: { type: "string" } } : {},
          ...name === "write" ? { content: { type: "string" } } : {},
          ...name === "task" ? { description: { type: "string" }, prompt: { type: "string" } } : {},
        } } })
        const extraTools = scenario === "mcp-terminal-poll" ? ["read"]
          : scenario === "handshake-without-write" ? ["read", "write", "edit"]
          : scenario === "task-attachment" ? ["task"]
          : scenario === "plan-refusal" ? ["plan_exit"]
          : []
        if (scenario === "task-attachment") fs.writeFileSync(path.join(root, "shot.png"), "shot bytes")
        const options = { prompt, headers: { "x-opencode-session-id": `ses_result_history_${scenario}` },
          ...scenario === "plan-refusal" ? { providerOptions: { cursor: { opencodeSessionEditsDenied: true } } } : {},
          tools: [
            { type: "function" as const, name: "bash", inputSchema: { type: "object", properties: { command: { type: "string" } } } },
            // Without an advertised `read` the provider refuses the read instead of answering it.
            ...(fileReads ? [{ type: "function" as const, name: "read", inputSchema: { type: "object",
              properties: { filePath: { type: "string" } }, required: ["filePath"] } }] : []),
            ...(newFileEdit ? [{ type: "function" as const, name: "write", inputSchema: { type: "object",
              properties: { filePath: { type: "string" }, content: { type: "string" } }, required: ["filePath", "content"] } }] : []),
            ...extraTools.map(tool),
          ] }
        const read = async () => {
          const parts: LanguageModelV3StreamPart[] = []
          const { stream } = await model.doStream(options)
          const reader = stream.getReader()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            parts.push(value)
          }
          return parts
        }
        // The rebuild seeds every result; this one cannot fit composer-2.5's window.
        const secondOutput = scenario === "oversized" ? `second completed ${"z".repeat(1_000_000)}` : "second completed"
        for (const output of ["first completed", secondOutput]) {
          const parts = await read()
          const call = parts.find(part => part.type === "tool-call")
          if (!call || call.type !== "tool-call") throw new Error("Expected a host command")
          prompt.push({ role: "assistant", content: [{ type: "tool-call", toolCallId: call.toolCallId, toolName: call.toolName, input: JSON.parse(call.input) }] })
          prompt.push({ role: "tool", content: [{ type: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, output: { type: "text", value: output } }] })
        }
        if (scenario === "missing-history") prompt.splice(1, 2)
        // Terminal and missing-target reads need no host result, nor do an edit handshake or Task attachment read whose
        // call's result is in history (#174); fork: nor do refusals. Every answer in the interrupted step refuses.
        if (scenario === "complete" || scenario === "announced" || scenario === "announced-shell" || scenario === "announced-open"
          || scenario === "new-output" || scenario === "next-call-announced" || scenario === "interaction-after-result"
          || scenario === "inline-catalog" || scenario === "unacknowledged-checkpoint" || scenario === "catalog-lookup"
          || scenario === "terminal-poll" || scenario === "mcp-terminal-poll" || scenario === "refusal-before-result"
          || scenario === "missing-read" || scenario === "refused-read" || scenario === "new-file-edit" || scenario === "task-attachment") {
          const parts = await read()
          expect(parts.some(part => part.type === "finish" && part.finishReason.unified === "stop")).toBe(true)
          expect(parts.some(part => part.type === "tool-call")).toBe(false)
          expect(requests).toHaveLength(2)
          expect(requests[1]!.action.resume_action).toBeUndefined()
          expect(requests[1]!.conversation_id).not.toBe(requests[0]!.conversation_id)
          const text = requests[1]!.action.user_message_action!.user_message.text
          expect(text.match(/first completed/g)).toHaveLength(1)
          expect(text.match(/second completed/g)).toHaveLength(1)
          expect(text).toContain("Do not repeat completed work")
          // Shown output stays on screen; the rebuilt step continues it.
          if (scenario === "new-output") expect(text).toContain("<interrupted_reply>\nnew output\n</interrupted_reply>")
          else expect(text).not.toContain("<interrupted_reply>")
        } else if (scenario === "oversized") {
          // The host compacts on this context overflow instead of retrying.
          const error = await read().catch((caught: unknown) => caught)
          expect(APICallError.isInstance(error)).toBe(true)
          expect(error).toMatchObject({ statusCode: 413, isRetryable: false })
          expect((error as APICallError).message).toMatch(/^prompt is too long/)
          expect(requests).toHaveLength(1)
        } else {
          expect(await read().catch((error: unknown) => error)).toMatchObject({ isRetryable: false,
            responseHeaders: { "x-should-retry": "false" } })
          expect(requests).toHaveLength(scenario === "followup-before-result" ? 2 : 1)
        }
        expect(delivered).toEqual([1, 2])
      } finally {
        sessionManager.dispose()
        await settleRunSavesForTests()
        setHostCacheDirOverride(undefined)
        fs.rmSync(root, { recursive: true, force: true })
      }
    }, 30_000)
  }

  it("rebuilds a dropped Run whose step only mirrored a Cursor todo update to the host", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-bridged-history-"))
    type RunRequest = { conversation_id: string; action: { resume_action?: unknown; user_message_action?: { user_message: { text: string } } } }
    const requests: RunRequest[] = []
    const todo = { update_todos_tool_call: { args: { todos: [{ id: "todo", content: "Review the logs", status: 1 }] } } }
    let firstRun: http2.ServerHttp2Stream | undefined
    scripted = (stream, message) => {
      if (!message.run_request) return
      requests.push(message.run_request as RunRequest)
      const send = (value: Record<string, unknown>) => stream.write(frame(encodeMessage("AgentServerMessage", value)))
      if (requests.length > 1) {
        send({ interaction_update: { turn_ended: {} } })
        stream.end()
        return
      }
      firstRun = stream
      send({ conversation_checkpoint_update: Uint8Array.of(10, 1, 7) })
      send({ interaction_update: { tool_call_started: { call_id: "todo-call", tool_call: todo } } })
      send({ interaction_update: { tool_call_completed: { call_id: "todo-call", tool_call: todo } } })
    }
    cacheHttp2SessionForTests(ORIGIN, client)
    try {
      const model = createCursor({ name: "cursor", accessToken: "test-token", agentBaseURL: ORIGIN,
        workspaceRoot: root, cacheDir: root, retry: { baseDelayMs: 1, maxDelayMs: 1 } }).languageModel("composer-2.5")
      const prompt: LanguageModelV3CallOptions["prompt"] = [{ role: "user", content: [{ type: "text", text: "Plan the review" }] }]
      const options = { prompt, headers: { "x-opencode-session-id": "ses_bridged_history" }, tools: [
        { type: "function" as const, name: "bash", inputSchema: { type: "object", properties: { command: { type: "string" } } } },
        { type: "function" as const, name: "todowrite", inputSchema: { type: "object", properties: { todos: { type: "array" } } } },
      ] }
      const read = async (afterStart?: () => void) => {
        const parts: LanguageModelV3StreamPart[] = []
        const { stream } = await model.doStream(options)
        afterStart?.()
        const reader = stream.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          parts.push(value)
        }
        return parts
      }
      const first = await read()
      const call = first.find(part => part.type === "tool-call")
      if (!call || call.type !== "tool-call") throw new Error("Expected the mirrored todo call")
      expect(call.toolName).toBe("todowrite")
      prompt.push({ role: "assistant", content: [{ type: "tool-call", toolCallId: call.toolCallId, toolName: call.toolName, input: JSON.parse(call.input) }] })
      prompt.push({ role: "tool", content: [{ type: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, output: { type: "text", value: "todos updated" } }] })
      // The Run drops after the host's result, with no checkpoint after it.
      const parts = await read(() => setTimeout(() => firstRun?.end(), 50))
      expect(parts.some(part => part.type === "finish" && part.finishReason.unified === "stop")).toBe(true)
      expect(requests).toHaveLength(2)
      expect(requests[1]!.action.resume_action).toBeUndefined()
      expect(requests[1]!.conversation_id).not.toBe(requests[0]!.conversation_id)
      expect(requests[1]!.action.user_message_action!.user_message.text).toContain("todos updated")
    } finally {
      sessionManager.dispose()
      await settleRunSavesForTests()
      setHostCacheDirOverride(undefined)
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)

  for (const todoInHistory of [true, false]) {
    it(`rebuilds only when history holds a mirrored call's result too (in history: ${todoInHistory})`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-bridged-missing-"))
      type RunRequest = { conversation_id: string; action: { user_message_action?: { user_message: { text: string } } } }
      const requests: RunRequest[] = []
      const todo = { update_todos_tool_call: { args: { todos: [{ id: "todo", content: "Review the logs", status: 1 }] } } }
      let firstRun: http2.ServerHttp2Stream | undefined
      const send = (stream: http2.ServerHttp2Stream, value: Record<string, unknown>) =>
        stream.write(frame(encodeMessage("AgentServerMessage", value)))
      scripted = (stream, message) => {
        if (message.run_request) {
          requests.push(message.run_request as RunRequest)
          if (requests.length > 1) {
            send(stream, { interaction_update: { turn_ended: {} } })
            stream.end()
            return
          }
          firstRun = stream
          send(stream, { conversation_checkpoint_update: Uint8Array.of(10, 1, 7) })
          send(stream, { interaction_update: { tool_call_started: { call_id: "todo-call", tool_call: todo } } })
          send(stream, { interaction_update: { tool_call_completed: { call_id: "todo-call", tool_call: todo } } })
          return
        }
        const reply = message.exec_client_message as { id?: number; shell_stream?: { exit?: unknown } } | undefined
        // The Run drops after the shell's result, before any checkpoint.
        if (reply?.id === 1 && reply.shell_stream?.exit) setTimeout(() => firstRun?.end(), 20)
      }
      cacheHttp2SessionForTests(ORIGIN, client)
      try {
        const model = createCursor({ name: "cursor", accessToken: "test-token", agentBaseURL: ORIGIN,
          workspaceRoot: root, cacheDir: root, retry: { baseDelayMs: 1, maxDelayMs: 1 } }).languageModel("composer-2.5")
        const prompt: LanguageModelV3CallOptions["prompt"] = [{ role: "user", content: [{ type: "text", text: "Plan the review" }] }]
        const options = { prompt, headers: { "x-opencode-session-id": `ses_bridged_missing_${todoInHistory}` }, tools: [
          { type: "function" as const, name: "bash", inputSchema: { type: "object", properties: { command: { type: "string" } } } },
          { type: "function" as const, name: "todowrite", inputSchema: { type: "object", properties: { todos: { type: "array" } } } },
        ] }
        const read = async (afterStart?: () => void) => {
          const parts: LanguageModelV3StreamPart[] = []
          const { stream } = await model.doStream(options)
          afterStart?.()
          const reader = stream.getReader()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            parts.push(value)
          }
          return parts
        }
        const push = (parts: LanguageModelV3StreamPart[], output: string) => {
          const call = parts.find(part => part.type === "tool-call")
          if (!call || call.type !== "tool-call") throw new Error("Expected a host call")
          prompt.push({ role: "assistant", content: [{ type: "tool-call", toolCallId: call.toolCallId, toolName: call.toolName, input: JSON.parse(call.input) }] })
          prompt.push({ role: "tool", content: [{ type: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, output: { type: "text", value: output } }] })
          return call
        }
        expect(push(await read(), "todos updated").toolName).toBe("todowrite")
        const shell = await read(() => setTimeout(() => send(firstRun!, {
          exec_server_message: { id: 1, shell_stream_args: { command: "echo done", tool_call_id: "shell-call" } },
        }), 20))
        expect(push(shell, "done").toolName).toBe("bash")
        // A rewritten history that lost the mirrored call's result.
        if (!todoInHistory) prompt.splice(1, 2)
        if (todoInHistory) {
          expect((await read()).some(part => part.type === "finish" && part.finishReason.unified === "stop")).toBe(true)
          expect(requests).toHaveLength(2)
          expect(requests[1]!.action.user_message_action!.user_message.text).toContain("todos updated")
        } else {
          expect(await read().catch((error: unknown) => error)).toMatchObject({ isRetryable: false })
          expect(requests).toHaveLength(1)
        }
      } finally {
        sessionManager.dispose()
        await settleRunSavesForTests()
        setHostCacheDirOverride(undefined)
        fs.rmSync(root, { recursive: true, force: true })
      }
    }, 30_000)
  }

  // Cursor answers a delivered injection with `user_message_appended` echoing its
  // `message_id` (#159). Independent bytes: InteractionUpdate #6 → user_message #1 →
  // text #1, message_id #2, then a flag and two timestamps (#24–#26).
  const appendedEcho = (text: string, messageId: string, extra: number[] = []) => {
    const field = (fn: number, bytes: Uint8Array) => {
      const tag: number[] = []
      for (let value = (fn << 3) | 2; ; value >>>= 7) {
        if (value < 0x80) { tag.push(value); break }
        tag.push((value & 0x7f) | 0x80)
      }
      const length: number[] = []
      for (let value = bytes.length; ; value >>>= 7) {
        if (value < 0x80) { length.push(value); break }
        length.push((value & 0x7f) | 0x80)
      }
      return Uint8Array.from([...tag, ...length, ...bytes])
    }
    const message = Uint8Array.from([
      ...field(1, Buffer.from(text)), ...field(2, Buffer.from(messageId)),
      0xc0, 0x01, 0x01, 0xc8, 0x01, 0x05, 0xd0, 0x01, 0x06, ...extra,
    ])
    return field(1, field(6, field(1, message)))
  }

  for (const scenario of [
    "echo", "checkpointed", "unmatched-id", "duplicate", "extra-field", "undelivered", "checkpointed-missing",
    "carried-missing", "carried-missing-retry",
  ] as const) {
    it(`rebuilds a post-result drop past its own host note's echo only when history holds the note (${scenario})`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-note-echo-"))
      const requests: Array<{ conversation_id: string; action: { resume_action?: unknown; user_message_action?: { user_message: { text: string } } } }> = []
      const injections: Array<{ injection_id: string; user_context: { user_message: { text: string; message_id: string } } }> = []
      const delivered: number[] = []
      scripted = (stream, message) => {
        const send = (value: Record<string, unknown>) => stream.write(frame(encodeMessage("AgentServerMessage", value)))
        if (message.run_request) {
          requests.push(message.run_request as typeof requests[number])
          if (requests.length > 1) {
            send({ interaction_update: { turn_ended: {} } })
            stream.end()
            return
          }
          send({ conversation_checkpoint_update: Uint8Array.of(10, 1, 7) })
          send({ exec_server_message: { id: 1, shell_stream_args: { command: "echo first", tool_call_id: "first" } } })
          return
        }
        const injection = (message.conversation_action as { inject_context_action?: typeof injections[number] } | undefined)?.inject_context_action
        if (injection) {
          injections.push(injection)
          const { text, message_id } = injection.user_context.user_message
          if (scenario !== "undelivered") {
            send({ interaction_update: { context_injection_state: { injection_id: injection.injection_id, state: { delivered: {} } } } })
          }
          const echo = appendedEcho(text, scenario === "unmatched-id" ? "another-message" : message_id,
            scenario === "extra-field" ? [0x20, 0x01] : [])
          stream.write(frame(echo))
          if (scenario === "duplicate") stream.write(frame(echo))
          // Cursor stores the note; the result written next revokes this checkpoint.
          if (scenario === "checkpointed" || scenario === "checkpointed-missing") {
            send({ conversation_checkpoint_update: Uint8Array.of(10, 1, 8) })
          }
          send({ exec_server_message: { id: 2, shell_stream_args: { command: "echo second", tool_call_id: "second" } } })
          return
        }
        const reply = message.exec_client_message as { id: number; shell_stream?: { exit?: unknown } } | undefined
        if (!reply?.shell_stream?.exit || delivered.includes(reply.id)) return
        delivered.push(reply.id)
        // Cut right after the second result, before any later checkpoint.
        if (reply.id === 2) stream.end()
      }
      cacheHttp2SessionForTests(ORIGIN, client)
      try {
        let tokenRequests = 0
        const model = createCursor({ name: "cursor", getAccessToken: async () => {
          if (++tokenRequests === 2 && scenario === "carried-missing-retry") {
            throw new CursorTransportError("Credential service connection reset", { transient: true, replaySafe: true })
          }
          return "example-token"
        }, agentBaseURL: ORIGIN,
          workspaceRoot: root, cacheDir: root, retry: { baseDelayMs: 1, maxDelayMs: 1 } }).languageModel("composer-2.5")
        const prompt: LanguageModelV3CallOptions["prompt"] = [{ role: "user", content: [{ type: "text", text: "Run both commands" }] }]
        const options = { prompt, headers: { "x-opencode-session-id": `ses_note_echo_${scenario}` },
          tools: [{ type: "function" as const, name: "bash", inputSchema: { type: "object", properties: { command: { type: "string" } } } }] }
        const read = async () => {
          const parts: LanguageModelV3StreamPart[] = []
          const { stream } = await model.doStream(options)
          const reader = stream.getReader()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            parts.push(value)
          }
          return parts
        }
        // OpenCode 2.x's notice that a background shell finished, after the first result.
        const notice = `<shell id="job-1" state="completed" command="sleep 1">\nbackground job finished\n</shell>`
        for (const output of ["first completed", "second completed"]) {
          const parts = await read()
          const call = parts.find(part => part.type === "tool-call")
          if (!call || call.type !== "tool-call") throw new Error("Expected a host command")
          prompt.push({ role: "assistant", content: [{ type: "tool-call", toolCallId: call.toolCallId, toolName: call.toolName, input: JSON.parse(call.input) }] })
          prompt.push({ role: "tool", content: [{ type: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, output: { type: "text", value: output } }] })
          if (output === "first completed") prompt.push({ role: "user", content: [{ type: "text", text: notice }] })
        }
        expect(injections.map(injection => injection.user_context.user_message.text)).toEqual([notice])
        // Host history no longer holds the note Cursor already stored.
        if (scenario === "checkpointed-missing" || scenario === "carried-missing" || scenario === "carried-missing-retry") {
          prompt.splice(prompt.findIndex(message => message.role === "user" && message.content.some(part => part.type === "text" && part.text === notice)), 1)
        }
        if (scenario === "echo" || scenario === "checkpointed" || scenario === "carried-missing" || scenario === "carried-missing-retry") {
          const parts = await read()
          expect(parts.some(part => part.type === "finish" && part.finishReason.unified === "stop")).toBe(true)
          expect(requests).toHaveLength(2)
          expect(requests[1]!.action.resume_action).toBeUndefined()
          expect(requests[1]!.conversation_id).not.toBe(requests[0]!.conversation_id)
          const text = requests[1]!.action.user_message_action!.user_message.text
          expect(text.match(/first completed/g)).toHaveLength(1)
          expect(text.match(/second completed/g)).toHaveLength(1)
          expect(text.match(/background job finished/g)).toHaveLength(1)
          expect(text).toContain("Do not repeat completed work")
          expect(injections).toHaveLength(1)
          expect(tokenRequests).toBe(scenario === "carried-missing-retry" ? 3 : 2)
        } else {
          expect(await read().catch((error: unknown) => error)).toMatchObject({ isRetryable: false,
            responseHeaders: { "x-should-retry": "false" } })
          expect(requests).toHaveLength(1)
        }
        expect(delivered).toEqual([1, 2])
      } finally {
        sessionManager.dispose()
        await settleRunSavesForTests()
        setHostCacheDirOverride(undefined)
        fs.rmSync(root, { recursive: true, force: true })
      }
    }, 30_000)
  }

  for (const echo of ["matched", "unmatched"] as const) {
    it(`${echo === "matched" ? "rebuilds from history" : "refuses"} a cut right after a result past an earlier note echo (${echo})`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-echo-fallback-"))
      const requests: Array<{ conversation_id: string; action: { resume_action?: unknown; user_message_action?: { user_message: { text: string } } } }> = []
      const replies: Array<{ id: number; text: string }> = []
      let injections = 0
      scripted = (stream, message) => {
        const send = (value: Record<string, unknown>) => stream.write(frame(encodeMessage("AgentServerMessage", value)))
        if (message.run_request) {
          requests.push(message.run_request as typeof requests[number])
          if (requests.length === 1) {
            send({ conversation_checkpoint_update: Uint8Array.of(10, 1, 7) })
            send({ exec_server_message: { id: 1, shell_stream_args: { command: "echo first", tool_call_id: "first" } } })
          } else if (requests[1]!.action.resume_action) {
            // The resumed Run asks again for the call whose result it lacks.
            send({ exec_server_message: { id: 7, shell_stream_args: { command: "echo second", tool_call_id: "second" } } })
          } else {
            send({ interaction_update: { turn_ended: {} } })
            stream.end()
          }
          return
        }
        const injection = (message.conversation_action as { inject_context_action?: { injection_id: string; user_context: { user_message: { text: string; message_id: string } } } } | undefined)?.inject_context_action
        if (injection) {
          injections++
          send({ interaction_update: { context_injection_state: { injection_id: injection.injection_id, state: { delivered: {} } } } })
          const { text, message_id } = injection.user_context.user_message
          stream.write(frame(appendedEcho(text, echo === "matched" ? message_id : "another-message")))
          send({ interaction_update: { tool_call_completed: { call_id: "first" } } })
          send({ exec_server_message: { id: 2, shell_stream_args: { command: "echo second", tool_call_id: "second" } } })
          // Cursor's checkpoint right after the step lists its call.
          send({ conversation_checkpoint_update: Uint8Array.of(10, 1, 9) })
          return
        }
        const reply = message.exec_client_message as { id: number; shell_stream?: { exit?: unknown; stdout?: { data?: string } } } | undefined
        if (!reply) return
        if (reply.shell_stream?.stdout?.data) replies.push({ id: reply.id, text: reply.shell_stream.stdout.data })
        if (!reply.shell_stream?.exit) return
        if (reply.id === 2) stream.end()
        if (reply.id === 7) {
          send({ interaction_update: { turn_ended: {} } })
          stream.end()
        }
      }
      cacheHttp2SessionForTests(ORIGIN, client)
      try {
        const model = createCursor({ name: "cursor", accessToken: "example-token", agentBaseURL: ORIGIN,
          workspaceRoot: root, cacheDir: root, retry: { baseDelayMs: 1, maxDelayMs: 1 } }).languageModel("composer-2.5")
        const prompt: LanguageModelV3CallOptions["prompt"] = [{ role: "user", content: [{ type: "text", text: "Run both commands" }] }]
        const options = { prompt, headers: { "x-opencode-session-id": `ses_echo_fallback_${echo}` },
          tools: [{ type: "function" as const, name: "bash", inputSchema: { type: "object", properties: { command: { type: "string" } } } }] }
        const read = async () => {
          const parts: LanguageModelV3StreamPart[] = []
          const { stream } = await model.doStream(options)
          const reader = stream.getReader()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            parts.push(value)
          }
          return parts
        }
        const notice = `<shell id="job-1" state="completed" command="sleep 1">\nbackground job finished\n</shell>`
        for (const output of ["first completed", "second completed"]) {
          const parts = await read()
          const call = parts.find(part => part.type === "tool-call")
          if (!call || call.type !== "tool-call") throw new Error("Expected a host command")
          prompt.push({ role: "assistant", content: [{ type: "tool-call", toolCallId: call.toolCallId, toolName: call.toolName, input: JSON.parse(call.input) }] })
          prompt.push({ role: "tool", content: [{ type: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, output: { type: "text", value: output } }] })
          if (output === "first completed") prompt.push({ role: "user", content: [{ type: "text", text: notice }] })
        }
        const outcome = await read().then(parts => parts, (error: Error) => error)
        expect(injections).toBe(1)
        if (echo === "matched") {
          if (outcome instanceof Error) throw outcome
          expect(outcome.some(part => part.type === "finish" && part.finishReason.unified === "stop")).toBe(true)
          expect(outcome.some(part => part.type === "tool-call")).toBe(false)
          expect(requests).toHaveLength(2)
          expect(requests[1]!.action.resume_action).toBeUndefined()
          expect(requests[1]!.conversation_id).not.toBe(requests[0]!.conversation_id)
          expect(requests[1]!.action.user_message_action!.user_message.text.match(/background job finished/g)).toHaveLength(1)
        } else {
          expect(outcome).toBeInstanceOf(Error)
          expect((outcome as Error).message).toContain("automatic retry unsafe")
          expect(requests).toHaveLength(1)
          expect(replies.some(reply => reply.id === 7)).toBe(false)
        }
      } finally {
        sessionManager.dispose()
        await settleRunSavesForTests()
        setHostCacheDirOverride(undefined)
        fs.rmSync(root, { recursive: true, force: true })
      }
    }, 30_000)
  }

  it("reports a foreign-history rebase that cannot fit as a context overflow, not a setup failure", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-rebase-overflow-"))
    let requests = 0
    scripted = (stream, message) => {
      if (!message.run_request) return
      requests++
      const send = (value: Record<string, unknown>) => stream.write(frame(encodeMessage("AgentServerMessage", value)))
      send({ interaction_update: { text_delta: { text: "Cursor answer" } } })
      send({ conversation_checkpoint_update: Uint8Array.of(10, 1, 7) })
      send({ interaction_update: { turn_ended: {} } })
      stream.end()
    }
    cacheHttp2SessionForTests(ORIGIN, client)
    try {
      const model = createCursor({ name: "cursor", accessToken: "example-token", agentBaseURL: ORIGIN,
        workspaceRoot: root, cacheDir: root }).languageModel("composer-2.5")
      // A tool-less call would be a lifecycle helper, which never rebases.
      const headers = { "x-opencode-session-id": "ses_rebase_overflow" }
      const tools = [{ type: "function" as const, name: "bash", inputSchema: { type: "object", properties: { command: { type: "string" } } } }]
      const first = await model.doStream({ headers, tools, prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }] })
      for (const reader = first.stream.getReader(); !(await reader.read()).done;) { /* drain */ }
      setActiveCursorMode("ses_rebase_overflow", "plan")
      // Another model answered since, at a length the 200k window cannot hold.
      const error = await Promise.resolve(model.doStream({ headers, tools, prompt: [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        { role: "assistant", content: [{ type: "text", text: `Other model ${"x".repeat(1_000_000)}` }] },
        { role: "user", content: [{ type: "text", text: "Continue" }] },
      ] })).catch((caught: unknown) => caught)
      expect(APICallError.isInstance(error)).toBe(true)
      expect(error).toMatchObject({ statusCode: 413, isRetryable: false })
      expect((error as APICallError).message).toMatch(/^prompt is too long/)
      expect(requests).toBe(1)
      // No Run took that request, so the turn after compaction still gets the first-turn mode reminder.
      expect(takeActiveCursorModeReminder("ses_rebase_overflow")).toContain("Plan mode is active")
    } finally {
      resetActiveCursorModesForTests()
      sessionManager.dispose()
      await settleRunSavesForTests()
      setHostCacheDirOverride(undefined)
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)

  for (const [afterResult, rejectReplacement] of [[false, false], [true, false], [true, true]] as const) {
    it(`only resumes a checkpoint received after the result (after: ${afterResult}, expired replacement: ${rejectReplacement})`, async () => {
      const checkpoint = Uint8Array.of(10, 1, 7)
      let resumed = false
      let renewals = 0
      scripted = (stream, message) => {
        const send = (message: Record<string, unknown>) => stream.write(frame(encodeMessage("AgentServerMessage", message)))
        if (message.run_request) {
          runs++
          resumed = !!(message.run_request as { action?: { resume_action?: unknown } }).action?.resume_action
          if (resumed) {
            if (rejectReplacement && runs === 2) {
              stream.end(frame(Buffer.from('{"error":{"code":"unauthenticated"}}'), 2))
              return
            }
            send({ interaction_update: { turn_ended: {} } })
            stream.end()
          } else if (runs > 1) {
            // A Run rebuilt from history, which already holds the command's result.
            send({ interaction_update: { turn_ended: {} } })
            stream.end()
          } else {
            send({ exec_server_message: { id: 1, shell_stream_args: { command: "echo done", tool_call_id: "command" } } })
            // This frame arrives while the host tool is outstanding. The held
            // reader may queue it until after the host has delivered its result.
            if (!afterResult) send({ conversation_checkpoint_update: checkpoint })
          }
        } else if (message.exec_client_message) {
          if (afterResult) {
            send({ interaction_update: { tool_call_completed: { call_id: "command" } } })
            send({ conversation_checkpoint_update: checkpoint })
          }
          send({ interaction_update: { thinking_delta: { text: "after the command" } } })
          stream.end(frame(Buffer.from('{"error":{"code":"unavailable"}}'), 2))
        }
      }
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-result-checkpoint-"))
      cacheHttp2SessionForTests(ORIGIN, client)
      try {
        const model = createCursor({
          name: "cursor", agentBaseURL: ORIGIN, cacheDir: root,
          getAccessToken: async request => {
            if (request?.forceRefresh) renewals++
            return renewals ? "renewed-test-token" : "example-token"
          },
          retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
        }).languageModel("composer-2.5")
        const prompt: LanguageModelV3CallOptions["prompt"] = [{ role: "user", content: [{ type: "text", text: "Run echo done" }] }]
        const options = {
          prompt,
          tools: [{ type: "function" as const, name: "bash", inputSchema: { type: "object", properties: { command: { type: "string" } } } }],
          headers: { "x-opencode-session-id": `ses_result_checkpoint_${afterResult}` },
        }
        const read = async (options: LanguageModelV3CallOptions) => {
          const parts: LanguageModelV3StreamPart[] = []
          const { stream } = await model.doStream(options)
          const reader = stream.getReader()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) return parts
            parts.push(value)
          }
        }
        const first = await read(options)
        const call = first.find(part => part.type === "tool-call")
        if (!call || call.type !== "tool-call") throw new Error("Expected the shell call")
        await new Promise<void>(resolve => setImmediate(resolve))
        prompt.push({ role: "assistant", content: [{ type: "tool-call", toolCallId: call.toolCallId, toolName: call.toolName, input: JSON.parse(call.input) }] })
        prompt.push({ role: "tool", content: [{ type: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, output: { type: "text", value: "done" } }] })
        if (afterResult) {
          const parts = await read(options)
          expect(parts.some(part => part.type === "finish" && part.finishReason.unified === "stop")).toBe(true)
          expect(resumed).toBe(true)
          expect(runs).toBe(rejectReplacement ? 3 : 2)
          expect(renewals).toBe(rejectReplacement ? 1 : 0)
        } else {
          // The checkpoint predates the delivered result, so the turn is rebuilt from history instead.
          const parts = await read(options)
          expect(parts.some(part => part.type === "finish" && part.finishReason.unified === "stop")).toBe(true)
          expect(resumed).toBe(false)
          expect(runs).toBe(2)
        }
      } finally {
        await settleRunSavesForTests()
        fs.rmSync(root, { recursive: true, force: true })
      }
    }, 30_000)
  }
})

describe("host calls still running when the Run dies", () => {
  type RunRequest = { conversation_id: string; action: { resume_action?: unknown; user_message_action?: { user_message: { text: string } } } }
  const command = "sleep 20; echo done >> ledger"
  const tools = [
    { type: "function" as const, name: "bash", inputSchema: { type: "object", properties: { command: { type: "string" } } } },
    { type: "function" as const, name: "read", inputSchema: { type: "object", properties: { filePath: { type: "string" } } } },
  ]

  /**
   * The step's first call is a command (`held`) or a read (`open`); either waits in its step for the next listed call.
   * `ordered`: the next call's exec comes at once, and step order holds it behind the command.
   */
  const setup = (step: "held" | "open" | "ordered",
    cut: "reset" | "clean-close" | "clean-end" | "trailers-end" | "null-error" | "reply-write" | "final" | "invalid-argument"
      | "kv-final" | "none", key: string,
    before?: "unknown-frame" | "cursor-run-call" | "catalog-lookup" | "catalog-started" | "provider-exec" | "terminal-poll"
      | "refusal" | "missing-read" | "soft-denied" | "handshake-without-write",
    queued?: "next-step" | "cursor-run-call" | "appended-user" | "unknown-frame" | "exec-abort" | "checkpoint"
      | "catalog-lookup" | "catalog-started" | "catalog-invalid" | "own-completion") => {
    const requests: RunRequest[] = []
    let firstRun: http2.ServerHttp2Stream | undefined
    scripted = (stream, message) => {
      if (!message.run_request) return
      requests.push(message.run_request as RunRequest)
      const send = (value: Record<string, unknown>) => stream.write(frame(encodeMessage("AgentServerMessage", value)))
      if (requests.length > 1) {
        send({ interaction_update: { text_delta: { text: "The command finished." } } })
        send({ interaction_update: { turn_ended: {} } })
        stream.end()
        return
      }
      firstRun = stream
      const shell = (callId: string) => ({ shell_tool_call: { args: { command, tool_call_id: callId } } })
      send({ conversation_checkpoint_update: Uint8Array.of(10, 1, 7) })
      send({ interaction_update: { text_delta: { text: "Running it now." } } })
      if (before === "unknown-frame") stream.write(frame(Uint8Array.of(0xa2, 0x06, 0)))
      if (before === "cursor-run-call" || before === "catalog-lookup") {
        const args = { server: "opencode", tool_name: "slack_read" }
        const own = before === "catalog-lookup"
          ? { get_mcp_tools_tool_call: { args } }
          : { web_fetch_tool_call: { args: { url: "https://example.com" } } }
        send({ interaction_update: { tool_call_started: { call_id: "own", tool_call: own } } })
        const done = before === "catalog-lookup"
          ? { get_mcp_tools_tool_call: { args, result: { success: { content: "slack_read(channel: string)" } } } }
          : own
        send({ interaction_update: { tool_call_completed: { call_id: "own", tool_call: done } } })
      }
      // Execs the provider answers itself in the pass the cut interrupts; history holds none of them.
      if (before === "provider-exec") send({ exec_server_message: { id: 90, list_mcp_resources_exec_args: {} } })
      if (before === "refusal") send({ exec_server_message: { id: 90, grep_args: { pattern: "first" } } })
      if (before === "missing-read") send({ exec_server_message: { id: 90, read_args: { path: "missing.txt" } } })
      // ExecServerMessage{id #1 = 90, force_background_shell_args #30}: a Cursor-native exec the host cannot run.
      if (before === "soft-denied") stream.write(frame(Uint8Array.of(0x12, 5, 0x08, 90, 0xf2, 0x01, 0)))
      if (before === "handshake-without-write") {
        // Cursor ends the edit after its handshake read without a write: no host result stands for the read.
        const edit = { edit_tool_call: { args: { path: "created.txt" } } }
        send({ interaction_update: { tool_call_started: { call_id: "edit", tool_call: edit } } })
        send({ exec_server_message: { id: 90, read_args: { path: "created.txt", tool_call_id: "edit" } } })
        send({ interaction_update: { tool_call_completed: { call_id: "edit", tool_call: edit } } })
      }
      if (before === "terminal-poll") {
        const env = sessionManager.findOpenByOpenCodeSessionId(key)!.requestContext.env as { project_folder: string }
        const record = path.join(env.project_folder, "terminals", "7.txt")
        fs.mkdirSync(path.dirname(record), { recursive: true })
        fs.writeFileSync(record, "running\n")
        send({ exec_server_message: { id: 90, read_args: { path: record, tool_call_id: "poll" } } })
      }
      if (step === "open") {
        send({ interaction_update: { tool_call_started: { call_id: "first", tool_call: { read_tool_call: { args: { path: "notes.txt" } } } } } })
      } else {
        send({ interaction_update: { tool_call_started: { call_id: "first", tool_call: shell("first") } } })
      }
      send({ interaction_update: { tool_call_started: { call_id: "second", tool_call: shell("second") } } })
      // A lookup Cursor starts after the host's call in this pass and completes while the host runs that call.
      if (before === "catalog-started") {
        send({ interaction_update: { tool_call_started: { call_id: "own", tool_call: {
          get_mcp_tools_tool_call: { args: { server: "opencode", tool_name: "slack_read" } } } } } })
      }
      send({ interaction_update: { tool_requests_listed: { call_count: 2 } } })
      send({ exec_server_message: step === "open"
        ? { id: 1, read_args: { path: "notes.txt", tool_call_id: "first" } }
        : { id: 1, shell_stream_args: { command, tool_call_id: "first" } } })
      if (step === "ordered") send({ exec_server_message: { id: 2, shell_stream_args: { command, tool_call_id: "second" } } })
      // Frames Cursor sends while the host runs the call; the held reader queues them for the next pump.
      setTimeout(() => {
        if (queued === "next-step") {
          send({ interaction_update: { text_delta: { text: "Next, the tests." } } })
          send({ interaction_update: { tool_call_started: { call_id: "third", tool_call: shell("third") } } })
        } else if (queued === "cursor-run-call") {
          const fetch = { web_fetch_tool_call: { args: { url: "https://example.com" } } }
          send({ interaction_update: { tool_call_started: { call_id: "late", tool_call: fetch } } })
          send({ interaction_update: { tool_call_completed: { call_id: "late", tool_call: fetch } } })
        } else if (queued === "appended-user") {
          send({ interaction_update: { user_message_appended: { user_message: { text: "also check the logs", message_id: "m1" } } } })
        } else if (queued === "unknown-frame") {
          stream.write(frame(Uint8Array.of(0xa2, 0x06, 0)))
        } else if (queued === "checkpoint") {
          // Cursor's checkpoint from before the running call's result; resuming it would ask for the call again.
          send({ conversation_checkpoint_update: Uint8Array.of(10, 1, 8) })
        } else if (queued === "own-completion") {
          send({ interaction_update: { tool_call_completed: { call_id: "own", tool_call: { get_mcp_tools_tool_call: {
            args: { server: "opencode", tool_name: "slack_read" }, result: { success: { content: "slack_read(channel: string)" } } } } } } })
        } else if (queued === "exec-abort") {
          // After the host step closed, Cursor sends the next call's exec and withdraws it; nothing ran it.
          send({ interaction_update: { text_delta: { text: "Next, the tests." } } })
          send({ exec_server_message: { id: 2, shell_stream_args: { command: "echo second", tool_call_id: "second" } } })
          send({ exec_server_control_message: { abort: { id: 2 } } })
        } else if (queued?.startsWith("catalog-")) {
          const args = { server: "opencode", tool_name: "slack_read" }
          send({ interaction_update: { tool_call_started: { call_id: "lookup", tool_call: { get_mcp_tools_tool_call: { args } } } } })
          if (queued !== "catalog-started") {
            const result = queued === "catalog-lookup" ? { result: { success: { content: "slack_read(channel: string)" } } } : {}
            send({ interaction_update: { tool_call_completed: { call_id: "lookup", tool_call: { get_mcp_tools_tool_call: { args, ...result } } } } })
          }
        }
      }, 30)
      setTimeout(() => {
        if (cut === "reset") stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR)
        else if (cut === "clean-close") stream.end()
        // Cursor's end-of-stream frame without an error, as production Runs close.
        else if (cut === "clean-end") stream.end(frame(Buffer.from("{}"), 2))
        else if (cut === "trailers-end") stream.end(frame(Buffer.from('{"metadata":{"x-request-id":["r1"]}}'), 2))
        else if (cut === "null-error") stream.end(frame(Buffer.from('{"error":null}'), 2))
        else if (cut === "final") stream.end(frame(Buffer.from('{"error":{"code":"permission_denied"}}'), 2))
        else if (cut === "invalid-argument") stream.end(frame(Buffer.from('{"error":{"code":"invalid_argument"}}'), 2))
        else if (cut === "reply-write" || cut === "kv-final") {
          send({ kv_server_message: { id: 5, set_blob_args: { blob_id: Uint8Array.of(5, 1, 2, 3), blob_data: Uint8Array.of(4, 5) } } })
          // Cursor's final verdict right behind the KV request whose reply is still draining.
          if (cut === "kv-final") stream.end(frame(Buffer.from('{"error":{"code":"permission_denied"}}'), 2))
        }
        cutSent()
      }, queued ? 80 : 50)
    }
    let cutSent!: () => void
    const cutDone = new Promise<void>((resolve) => { cutSent = resolve })
    /** Until the provider has closed the first Run on the cut, so the host's result goes to a lost Run. */
    const waitForCut = async () => {
      await cutDone
      if (cut === "none") return
      for (let i = 0; i < 500 && sessionManager.findOpenByOpenCodeSessionId(key); i++) await Bun.sleep(10)
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-held-tool-cut-"))
    fs.writeFileSync(path.join(root, "notes.txt"), "notes\n")
    // The cut retires the Run's connection, as a GOAWAY does; the rebuilt Run needs another.
    const connections: http2.ClientHttp2Session[] = []
    const connect = async () => {
      const current = connections.at(-1)
      if (current && !current.closed && !current.destroyed) return
      const next = http2.connect(`http://127.0.0.1:${(server.address() as net.AddressInfo).port}`)
      await new Promise<void>((resolve, reject) => {
        next.once("connect", () => resolve())
        next.once("error", reject)
      })
      connections.push(next)
      cacheHttp2SessionForTests(ORIGIN, next)
    }
    const model = createCursor({ name: "cursor", accessToken: "test-token", agentBaseURL: ORIGIN,
      workspaceRoot: root, cacheDir: root, retry: { baseDelayMs: 1, maxDelayMs: 1 } }).languageModel("composer-2.5")
    const prompt: LanguageModelV3CallOptions["prompt"] = [{ role: "user", content: [{ type: "text", text: "Run the slow command" }] }]
    const write = { type: "function" as const, name: "write", inputSchema: { type: "object",
      properties: { filePath: { type: "string" }, content: { type: "string" } }, required: ["filePath", "content"] } }
    const options = { prompt, tools: before === "handshake-without-write" ? [...tools, write] : tools,
      headers: { "x-opencode-session-id": key } }
    const read = async (abortSignal?: AbortSignal) => {
      const parts: LanguageModelV3StreamPart[] = []
      await connect()
      if (cut === "none" && prompt.at(-1)?.role === "tool") {
        // The result goes into the held Run's write buffer and its drain fails: Cursor may have it.
        const session = sessionManager.findOpenByOpenCodeSessionId(key)!
        const write = session.stream.write.bind(session.stream)
        session.stream.write = bytes =>
          decodeMessage<{ exec_client_message?: unknown }>("AgentClientMessage", bytes).exec_client_message ? false : write(bytes)
        session.stream.waitForDrain = async () => { throw new Error("stream reset while draining") }
      }
      const { stream } = await model.doStream({ ...options, abortSignal })
      if (cut === "kv-final" && prompt.at(-1)?.role === "user") {
        // The held reader's reply to Cursor's KV write drains until Cursor has sent its final verdict and closed.
        const session = sessionManager.findOpenByOpenCodeSessionId(key)!
        const write = session.stream.write.bind(session.stream)
        session.stream.write = bytes =>
          decodeMessage<{ kv_client_message?: unknown }>("AgentClientMessage", bytes).kv_client_message ? false : write(bytes)
        session.stream.waitForDrain = async () => {
          await Bun.sleep(20)
          throw new Error("stream reset while draining")
        }
      }
      if (cut === "reply-write" && requests.length === 0) {
        // The Run dies under the provider's reply to Cursor's KV write.
        const session = sessionManager.findOpenByOpenCodeSessionId(key)!
        const write = session.stream.write.bind(session.stream)
        session.stream.write = bytes => {
          if (decodeMessage<{ kv_client_message?: unknown }>("AgentClientMessage", bytes).kv_client_message) {
            firstRun?.close(http2.constants.NGHTTP2_INTERNAL_ERROR)
            throw new CursorRunInterruptedError("Cursor Run stream is no longer writable")
          }
          return write(bytes)
        }
      }
      const reader = stream.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return parts
        parts.push(value)
      }
    }
    const cleanup = async () => {
      sessionManager.dispose()
      await settleRunSavesForTests()
      for (const connection of connections) connection.destroy()
      setHostCacheDirOverride(undefined)
      fs.rmSync(root, { recursive: true, force: true })
    }
    return { requests, prompt, read, cleanup, waitForCut }
  }

  const hostCalls = (parts: LanguageModelV3StreamPart[]) =>
    parts.filter((part): part is Extract<LanguageModelV3StreamPart, { type: "tool-call" }> =>
      part.type === "tool-call" && !part.providerExecuted)

  const pushResult = (prompt: LanguageModelV3CallOptions["prompt"], call: Extract<LanguageModelV3StreamPart, { type: "tool-call" }>,
    output: { type: "text" | "error-text"; value: string }) => {
    prompt.push({ role: "assistant", content: [{ type: "text", text: "Running it now." },
      { type: "tool-call", toolCallId: call.toolCallId, toolName: call.toolName, input: JSON.parse(call.input) }] })
    prompt.push({ role: "tool", content: [{ type: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, output }] })
  }

  for (const [step, cut, before, queued] of [
    ["held", "reset", undefined, undefined], ["held", "clean-close", undefined, undefined], ["open", "reset", undefined, undefined],
    ["open", "clean-close", undefined, undefined], ["open", "reply-write", undefined, undefined],
    ["held", "reset", "catalog-lookup", undefined], ["held", "clean-close", undefined, "next-step"],
    // The provider's own answers in the held pass precede its calls' results, as earlier answers do.
    ["held", "reset", "terminal-poll", undefined], ["held", "reset", "refusal", undefined],
    ["held", "reset", "missing-read", undefined],
    ["held", "clean-close", undefined, "exec-abort"], ["held", "clean-close", undefined, "catalog-lookup"],
    ["held", "reset", undefined, "checkpoint"], ["open", "reset", undefined, "checkpoint"],
    ["held", "clean-close", "catalog-started", "own-completion"],
    ["held", "clean-end", undefined, undefined], ["open", "clean-end", undefined, undefined],
    ["held", "clean-end", undefined, "next-step"], ["held", "trailers-end", undefined, undefined],
    ["open", "trailers-end", undefined, undefined],
    // Fork: nothing ran the call step order still held, and the soft-denied exec ran nothing on the host.
    ["ordered", "reset", undefined, undefined], ["ordered", "clean-close", undefined, undefined],
    ["held", "reset", "soft-denied", undefined],
  ] as const) {
    it(`ends the step on its running host call and rebuilds from its result (${step} step, ${cut}${before ? `, ${before}` : ""}${queued ? `, queued ${queued}` : ""})`, async () => {
      const { requests, prompt, read, cleanup, waitForCut } = setup(step, cut, `ses_held_tool_cut_${step}_${cut}_${before}_${queued}`, before, queued)
      try {
        const first = await read()
        const calls = hostCalls(first)
        expect(calls).toHaveLength(1)
        expect(calls[0]!.toolName).toBe(step === "open" ? "read" : "bash")
        expect(first.some(part => part.type === "finish" && part.finishReason.unified === "tool-calls")).toBe(true)
        expect(first.some(part => part.type === "error")).toBe(false)
        // Nothing reopens while the host is still running the call.
        await waitForCut()
        expect(requests).toHaveLength(1)
        pushResult(prompt, calls[0]!, { type: "text", value: "ledger line written" })
        const second = await read()
        expect(hostCalls(second)).toHaveLength(0)
        expect(second.some(part => part.type === "finish" && part.finishReason.unified === "stop")).toBe(true)
        expect(requests).toHaveLength(2)
        expect(requests[1]!.action.resume_action).toBeUndefined()
        expect(requests[1]!.conversation_id).not.toBe(requests[0]!.conversation_id)
        const text = requests[1]!.action.user_message_action!.user_message.text
        expect(text.match(/ledger line written/g)).toHaveLength(1)
        expect(text.match(/Running it now\./g)).toHaveLength(1)
      } finally {
        await cleanup()
      }
    }, 30_000)
  }

  for (const [step, cut, before, queued] of [
    ["held", "reset", "unknown-frame", undefined], ["held", "reset", "cursor-run-call", undefined],
    ["open", "reply-write", "cursor-run-call", undefined], ["held", "final", undefined, undefined],
    ["open", "final", undefined, undefined], ["held", "invalid-argument", undefined, undefined],
    ["held", "clean-close", undefined, "cursor-run-call"], ["held", "clean-close", undefined, "appended-user"],
    ["held", "clean-close", undefined, "unknown-frame"], ["held", "clean-close", undefined, "catalog-started"],
    ["held", "clean-close", undefined, "catalog-invalid"], ["held", "final", undefined, "appended-user"],
    ["held", "kv-final", undefined, undefined], ["held", "none", undefined, undefined],
    ["held", "null-error", undefined, undefined], ["open", "null-error", undefined, undefined],
    ["held", "reset", "provider-exec", undefined], ["ordered", "reset", "provider-exec", undefined],
    ["held", "reset", "handshake-without-write", undefined],
  ] as const) {
    it(`ends the turn once the running call's result is in when the Run cannot be rebuilt (${step} step, ${cut}${before ? `, ${before}` : ""}${queued ? `, queued ${queued}` : ""})`, async () => {
      const { requests, prompt, read, cleanup, waitForCut } = setup(step, cut, `ses_held_tool_refuse_${step}_${cut}_${before}_${queued}`, before, queued)
      try {
        const calls = hostCalls(await read())
        expect(calls).toHaveLength(1)
        await waitForCut()
        pushResult(prompt, calls[0]!, { type: "text", value: "ledger line written" })
        const error = await read().catch((caught: unknown) => caught)
        if (cut === "invalid-argument" || cut === "null-error") {
          // As the pump ends on it: Cursor's error without a retry verdict reaches the host as it is.
          expect(APICallError.isInstance(error)).toBe(false)
          expect(error).toBeInstanceOf(CursorServerError)
          expect((error as Error).message)
            .toBe(`Cursor API error (code=${cut === "null-error" ? "unknown" : "invalid_argument"})`)
        } else {
          expect(APICallError.isInstance(error)).toBe(true)
          expect(error).toMatchObject({ isRetryable: false, responseHeaders: { "x-should-retry": "false" } })
        }
        // Cursor's own final error wins over the provider's refusal.
        if (cut === "final" || cut === "kv-final") expect((error as APICallError).message).not.toContain("continue")
        else if (cut !== "invalid-argument" && cut !== "null-error") expect((error as APICallError).message).toContain("continue")
        const why = { "provider-exec": "provider-answered-exec id=90", "handshake-without-write": "provider-answered-exec id=90" }
        if (before && before in why) expect((error as APICallError).message).toContain(why[before as keyof typeof why])
        expect(requests).toHaveLength(1)
      } finally {
        await cleanup()
      }
    }, 30_000)
  }

  // Fork: the lost held Run's check applies #174's rule to the provider's own answers.
  for (const shape of ["held-new-file-write", "prior-missing-read", "prior-new-file-edit"] as const) {
    it(`rebuilds a lost held Run past the provider's own answers (${shape})`, async () => {
      const key = `ses_held_tool_answers_${shape}`
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-held-tool-answers-"))
      const target = path.join(root, "created.txt")
      const requests: RunRequest[] = []
      let cutSent!: () => void
      const cutDone = new Promise<void>((resolve) => { cutSent = resolve })
      scripted = (stream, message) => {
        const send = (value: Record<string, unknown>) => stream.write(frame(encodeMessage("AgentServerMessage", value)))
        const newFileEdit = (id: number) => {
          send({ interaction_update: { tool_call_started: { call_id: "edit", tool_call: { edit_tool_call: { args: { path: target } } } } } })
          send({ interaction_update: { tool_requests_listed: { call_count: 1 } } })
          send({ exec_server_message: { id: 60, read_args: { path: target, tool_call_id: "edit" } } })
          send({ exec_server_message: { id, write_args: { path: target, file_text: "created\n", tool_call_id: "edit" } } })
        }
        const heldStep = () => {
          if (shape === "held-new-file-write") newFileEdit(2)
          else {
            send({ interaction_update: { tool_call_started: { call_id: "first", tool_call: { shell_tool_call: { args: { command, tool_call_id: "first" } } } } } })
            send({ interaction_update: { tool_requests_listed: { call_count: 1 } } })
            send({ exec_server_message: { id: 2, shell_stream_args: { command, tool_call_id: "first" } } })
          }
          setTimeout(() => {
            stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR)
            cutSent()
          }, 50)
        }
        if (message.run_request) {
          requests.push(message.run_request as RunRequest)
          if (requests.length > 1) {
            send({ interaction_update: { text_delta: { text: "Done." } } })
            send({ interaction_update: { turn_ended: {} } })
            stream.end()
            return
          }
          send({ conversation_checkpoint_update: Uint8Array.of(10, 1, 7) })
          send({ interaction_update: { text_delta: { text: "Running it now." } } })
          if (shape === "held-new-file-write") return heldStep()
          // An earlier step whose host result reaches the Run before the held step.
          if (shape === "prior-missing-read") {
            send({ exec_server_message: { id: 50, read_args: { path: path.join(root, "absent.txt"), tool_call_id: "absent" } } })
            send({ interaction_update: { tool_call_started: { call_id: "zero", tool_call: { shell_tool_call: { args: { command: "echo zero", tool_call_id: "zero" } } } } } })
            send({ interaction_update: { tool_requests_listed: { call_count: 1 } } })
            send({ exec_server_message: { id: 1, shell_stream_args: { command: "echo zero", tool_call_id: "zero" } } })
          } else newFileEdit(1)
        } else if (message.exec_client_message) {
          const reply = message.exec_client_message as { id: number; shell_stream?: { exit?: unknown }; write_result?: unknown }
          if (reply.id === 1 && (reply.shell_stream?.exit || reply.write_result)) heldStep()
        }
      }
      const connections: http2.ClientHttp2Session[] = []
      const connect = async () => {
        const current = connections.at(-1)
        if (current && !current.closed && !current.destroyed) return
        const next = http2.connect(`http://127.0.0.1:${(server.address() as net.AddressInfo).port}`)
        await new Promise<void>((resolve, reject) => {
          next.once("connect", () => resolve())
          next.once("error", reject)
        })
        connections.push(next)
        cacheHttp2SessionForTests(ORIGIN, next)
      }
      const model = createCursor({ name: "cursor", accessToken: "test-token", agentBaseURL: ORIGIN,
        workspaceRoot: root, cacheDir: root, retry: { baseDelayMs: 1, maxDelayMs: 1 } }).languageModel("composer-2.5")
      const prompt: LanguageModelV3CallOptions["prompt"] = [{ role: "user", content: [{ type: "text", text: "Run it" }] }]
      const options = { prompt, headers: { "x-opencode-session-id": key }, tools: [
        ...tools,
        { type: "function" as const, name: "write", inputSchema: { type: "object",
          properties: { filePath: { type: "string" }, content: { type: "string" } }, required: ["filePath", "content"] } },
      ] }
      const read = async () => {
        const parts: LanguageModelV3StreamPart[] = []
        await connect()
        const { stream } = await model.doStream(options)
        const reader = stream.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) return parts
          parts.push(value)
        }
      }
      try {
        const outputs = shape === "held-new-file-write" ? ["write landed"] : ["first step done", "ledger line written"]
        for (const [index, output] of outputs.entries()) {
          const calls = hostCalls(await read())
          expect(calls).toHaveLength(1)
          if (index === outputs.length - 1) {
            await cutDone
            for (let i = 0; i < 500 && sessionManager.findOpenByOpenCodeSessionId(key); i++) await Bun.sleep(10)
            expect(requests).toHaveLength(1)
          }
          pushResult(prompt, calls[0]!, { type: "text", value: output })
        }
        const rebuilt = await read()
        expect(hostCalls(rebuilt)).toHaveLength(0)
        expect(rebuilt.some(part => part.type === "finish" && part.finishReason.unified === "stop")).toBe(true)
        expect(requests).toHaveLength(2)
        expect(requests[1]!.action.resume_action).toBeUndefined()
        const text = requests[1]!.action.user_message_action!.user_message.text
        for (const output of outputs) expect(text.match(new RegExp(output, "g"))).toHaveLength(1)
      } finally {
        sessionManager.dispose()
        await settleRunSavesForTests()
        for (const connection of connections) connection.destroy()
        setHostCacheDirOverride(undefined)
        fs.rmSync(root, { recursive: true, force: true })
      }
    }, 30_000)
  }

  // Fork: a generated image's write names no call; the host's save of it stands for its GenerateImage call.
  for (const images of ["one", "two-open"] as const) {
    it(`${images === "one" ? "rebuilds" : "refuses"} a lost held Run of parallel Task calls after an earlier GenerateImage (${images})`, async () => {
      const key = `ses_held_tool_generated_image_${images}`
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-held-tool-image-"))
      const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52])
      const generate = (callId: string) => ({ generate_image_tool_call: { args: { description: `sprite ${callId}` } } })
      const generations = images === "one" ? ["gen"] : ["gen-1", "gen-2"]
      const reviewers = ["opus", "gpt", "grok"]
      const requests: RunRequest[] = []
      let cutSent!: () => void
      const cutDone = new Promise<void>((resolve) => { cutSent = resolve })
      scripted = (stream, message) => {
        const send = (value: Record<string, unknown>) => stream.write(frame(encodeMessage("AgentServerMessage", value)))
        if (message.run_request) {
          requests.push(message.run_request as RunRequest)
          if (requests.length > 1) {
            send({ interaction_update: { text_delta: { text: "Reviews are in." } } })
            send({ interaction_update: { turn_ended: {} } })
            stream.end()
            return
          }
          send({ conversation_checkpoint_update: Uint8Array.of(10, 1, 7) })
          for (const callId of generations) {
            send({ interaction_update: { tool_call_started: { call_id: callId, tool_call: generate(callId) } } })
          }
          send({ exec_server_message: { id: 1, write_args: { path: "/elsewhere/assets/sprite.png", file_bytes: png } } })
        } else if (message.exec_client_message) {
          const reply = message.exec_client_message as { id: number; write_result?: unknown }
          if (reply.id !== 1 || !reply.write_result) return
          for (const callId of generations) {
            send({ interaction_update: { tool_call_completed: { call_id: callId, tool_call: generate(callId) } } })
          }
          send({ interaction_update: { text_delta: { text: "Asking three reviewers." } } })
          for (const [index, agent] of reviewers.entries()) {
            const args = { description: `Review (${agent})`, prompt: `Review the sprite as ${agent}.` }
            send({ interaction_update: { tool_call_started: { call_id: agent, tool_call: { task_tool_call: { args } } } } })
            send({ interaction_update: { tool_requests_listed: { call_count: reviewers.length } } })
            send({ exec_server_message: { id: 2 + index, subagent_args: { tool_call_id: agent, prompt: args.prompt, subagent_type: agent } } })
          }
          setTimeout(() => {
            stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR)
            cutSent()
          }, 50)
        }
      }
      const connections: http2.ClientHttp2Session[] = []
      const connect = async () => {
        const current = connections.at(-1)
        if (current && !current.closed && !current.destroyed) return
        const next = http2.connect(`http://127.0.0.1:${(server.address() as net.AddressInfo).port}`)
        await new Promise<void>((resolve, reject) => {
          next.once("connect", () => resolve())
          next.once("error", reject)
        })
        connections.push(next)
        cacheHttp2SessionForTests(ORIGIN, next)
      }
      setHostCacheDirOverride(root)
      const model = createCursor({ name: "cursor", accessToken: "test-token", agentBaseURL: ORIGIN,
        workspaceRoot: root, cacheDir: root, retry: { baseDelayMs: 1, maxDelayMs: 1 } }).languageModel("composer-2.5")
      const prompt: LanguageModelV3CallOptions["prompt"] = [{ role: "user", content: [{ type: "text", text: "Draw it, then get it reviewed" }] }]
      const options = { prompt, headers: { "x-opencode-session-id": key }, tools: [
        { type: "function" as const, name: "cursor_image_save", inputSchema: { type: "object", properties: { image_id: { type: "string" } } } },
        { type: "function" as const, name: "subagent", inputSchema: { type: "object",
          properties: { description: { type: "string" }, prompt: { type: "string" }, agent: { type: "string" } } } },
      ] }
      const read = async () => {
        const parts: LanguageModelV3StreamPart[] = []
        await connect()
        const { stream } = await model.doStream(options)
        const reader = stream.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) return parts
          parts.push(value)
        }
      }
      const pushResults = (calls: Extract<LanguageModelV3StreamPart, { type: "tool-call" }>[], output: (index: number) => string) => {
        prompt.push({ role: "assistant", content: calls.map((call) =>
          ({ type: "tool-call" as const, toolCallId: call.toolCallId, toolName: call.toolName, input: JSON.parse(call.input) })) })
        prompt.push({ role: "tool", content: calls.map((call, index) => ({ type: "tool-result" as const, toolCallId: call.toolCallId,
          toolName: call.toolName, output: { type: "text" as const, value: output(index) } })) })
      }
      try {
        const save = hostCalls(await read())
        expect(save.map((call) => call.toolName)).toEqual(["cursor_image_save"])
        pushResults(save, () => "Saved the image to assets/sprite.png")
        const tasks = hostCalls(await read())
        expect(tasks.map((call) => call.toolName)).toEqual(["subagent", "subagent", "subagent"])
        await cutDone
        for (let i = 0; i < 500 && sessionManager.findOpenByOpenCodeSessionId(key); i++) await Bun.sleep(10)
        expect(requests).toHaveLength(1)
        pushResults(tasks, (index) => `<subagent state="completed">${reviewers[index]} approves</subagent>`)
        if (images === "two-open") {
          // Neither GenerateImage call can be told to be the one the write served: each stays Cursor's own.
          const error = await read().catch((caught: unknown) => caught)
          expect(APICallError.isInstance(error)).toBe(true)
          expect((error as APICallError).message).toContain("after a call Cursor ran itself")
          expect(requests).toHaveLength(1)
          return
        }
        const rebuilt = await read()
        expect(hostCalls(rebuilt)).toHaveLength(0)
        expect(rebuilt.some(part => part.type === "finish" && part.finishReason.unified === "stop")).toBe(true)
        expect(requests).toHaveLength(2)
        expect(requests[1]!.action.resume_action).toBeUndefined()
        const text = requests[1]!.action.user_message_action!.user_message.text
        expect(text.match(/Saved the image to assets\/sprite\.png/g)).toHaveLength(1)
        for (const agent of reviewers) expect(text.match(new RegExp(`${agent} approves`, "g"))).toHaveLength(1)
      } finally {
        sessionManager.dispose()
        await settleRunSavesForTests()
        for (const connection of connections) connection.destroy()
        setHostCacheDirOverride(undefined)
        fs.rmSync(root, { recursive: true, force: true })
      }
    }, 30_000)
  }

  // Fork: an AwaitShell Cursor ran on a background shell has no side effect, whether or not a poll named its call.
  for (const earlier of ["await-unnamed-polls", "await-no-polls", "await-named-polls", "web-fetch"] as const) {
    const rebuilds = earlier !== "web-fetch"
    it(`${rebuilds ? "rebuilds" : "refuses"} a lost held Run of parallel Task calls after an earlier Cursor-run call (${earlier})`, async () => {
      const key = `ses_held_tool_await_${earlier}`
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-held-tool-await-"))
      const reviewers = ["opus", "gpt", "grok"]
      const shell = "make assets > build.log 2>&1"
      const notice = `<shell id="545432" state="completed" command="${shell}">\nbuild finished\n</shell>`
      const requests: RunRequest[] = []
      const injections: string[] = []
      let cutSent!: () => void
      const cutDone = new Promise<void>((resolve) => { cutSent = resolve })
      scripted = (stream, message) => {
        const send = (value: Record<string, unknown>) => stream.write(frame(encodeMessage("AgentServerMessage", value)))
        const call = (id: number, callId: string, variant: Record<string, unknown>) => {
          const [kind, args] = Object.entries(variant)[0]!
          const display = kind === "read_args" ? { read_tool_call: { args } }
            : kind === "subagent_args" ? { task_tool_call: { args: { description: callId, prompt: (args as { prompt: string }).prompt } } }
            : { shell_tool_call: { args } }
          send({ interaction_update: { tool_call_started: { call_id: callId, tool_call: display } } })
          send({ exec_server_message: { id, [kind]: { ...args as object, tool_call_id: callId } } })
        }
        if (message.run_request) {
          requests.push(message.run_request as RunRequest)
          if (requests.length > 1) {
            send({ interaction_update: { text_delta: { text: "Reviews are in." } } })
            send({ interaction_update: { turn_ended: {} } })
            stream.end()
            return
          }
          send({ conversation_checkpoint_update: Uint8Array.of(10, 1, 7) })
          call(1, "build", { shell_stream_args: { command: `${shell} &` } })
          return
        }
        const injection = (message.conversation_action as { inject_context_action?: {
          injection_id: string; user_context: { user_message: { text: string; message_id: string } } } } | undefined)?.inject_context_action
        if (injection) {
          const { text, message_id } = injection.user_context.user_message
          injections.push(text)
          send({ interaction_update: { context_injection_state: { injection_id: injection.injection_id, state: { delivered: {} } } } })
          send({ interaction_update: { user_message_appended: { user_message: { text, message_id } } } })
          // The note follows the check's result; Cursor's next step comes after its echo.
          call(3, "log", { read_args: { path: "build.log" } })
          return
        }
        const reply = message.exec_client_message as { id: number; shell_stream?: { exit?: unknown }; read_result?: unknown } | undefined
        if (!reply || !(reply.shell_stream?.exit || reply.read_result)) return
        if (reply.id === 1) {
          if (earlier === "web-fetch") {
            const fetch = { web_fetch_tool_call: { args: { url: "https://example.com/status" } } }
            send({ interaction_update: { tool_call_started: { call_id: "fetch", tool_call: fetch } } })
            send({ interaction_update: { tool_call_completed: { call_id: "fetch", tool_call: fetch } } })
          } else {
            // Cursor waits on the background shell itself, polling its terminal record, and its wait times out.
            const wait = { await_tool_call: { args: { task_id: "545432", block_until_ms: 1_800_000 } } }
            send({ interaction_update: { tool_call_started: { call_id: "wait", tool_call: wait } } })
            if (earlier !== "await-no-polls") {
              const env = sessionManager.findOpenByOpenCodeSessionId(key)!.requestContext.env as { project_folder: string }
              const record = path.join(env.project_folder, "terminals", "545432.txt")
              fs.mkdirSync(path.dirname(record), { recursive: true })
              fs.writeFileSync(record, "running\n")
              for (const poll of [100, 101, 102]) {
                send({ exec_server_message: { id: poll, read_args: { path: record,
                  ...earlier === "await-named-polls" ? { tool_call_id: "wait" } : {} } } })
              }
            }
            send({ interaction_update: { tool_call_completed: { call_id: "wait", tool_call: wait } } })
          }
          call(2, "check", { shell_stream_args: { command: "tail -1 build.log" } })
        } else if (reply.id === 3) {
          send({ interaction_update: { text_delta: { text: "Asking three reviewers." } } })
          send({ interaction_update: { tool_requests_listed: { call_count: reviewers.length } } })
          for (const [index, agent] of reviewers.entries()) {
            call(4 + index, agent, { subagent_args: { prompt: `Review the build as ${agent}.`, subagent_type: agent } })
          }
          setTimeout(() => {
            stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR)
            cutSent()
          }, 50)
        }
      }
      const connections: http2.ClientHttp2Session[] = []
      const connect = async () => {
        const current = connections.at(-1)
        if (current && !current.closed && !current.destroyed) return
        const next = http2.connect(`http://127.0.0.1:${(server.address() as net.AddressInfo).port}`)
        await new Promise<void>((resolve, reject) => {
          next.once("connect", () => resolve())
          next.once("error", reject)
        })
        connections.push(next)
        cacheHttp2SessionForTests(ORIGIN, next)
      }
      fs.writeFileSync(path.join(root, "build.log"), "done\n")
      const model = createCursor({ name: "cursor", accessToken: "test-token", agentBaseURL: ORIGIN,
        workspaceRoot: root, cacheDir: root, retry: { baseDelayMs: 1, maxDelayMs: 1 } }).languageModel("composer-2.5")
      const prompt: LanguageModelV3CallOptions["prompt"] = [{ role: "user", content: [{ type: "text", text: "Build the assets, then get them reviewed" }] }]
      const options = { prompt, headers: { "x-opencode-session-id": key }, tools: [
        ...tools,
        { type: "function" as const, name: "subagent", inputSchema: { type: "object",
          properties: { description: { type: "string" }, prompt: { type: "string" }, agent: { type: "string" } } } },
      ] }
      const read = async () => {
        const parts: LanguageModelV3StreamPart[] = []
        await connect()
        const { stream } = await model.doStream(options)
        const reader = stream.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) return parts
          parts.push(value)
        }
      }
      const pushResults = (calls: Extract<LanguageModelV3StreamPart, { type: "tool-call" }>[], output: (index: number) => string) => {
        prompt.push({ role: "assistant", content: calls.map((call) =>
          ({ type: "tool-call" as const, toolCallId: call.toolCallId, toolName: call.toolName, input: JSON.parse(call.input) })) })
        prompt.push({ role: "tool", content: calls.map((call, index) => ({ type: "tool-result" as const, toolCallId: call.toolCallId,
          toolName: call.toolName, output: { type: "text" as const, value: output(index) } })) })
      }
      try {
        for (const [tool, output] of [["bash", "Started in the background (shell 545432, pid 1693562)"],
          ["bash", "done"], ["read", "done"]] as const) {
          const calls = hostCalls(await read())
          expect(calls.map((call) => call.toolName)).toEqual([tool])
          pushResults(calls, () => output)
          // OpenCode's note that the background shell finished, delivered into the Run as a host note.
          if (output === "done" && tool === "bash") prompt.push({ role: "user", content: [{ type: "text", text: notice }] })
        }
        const tasks = hostCalls(await read())
        expect(tasks.map((call) => call.toolName)).toEqual(["subagent", "subagent", "subagent"])
        expect(injections).toEqual([notice])
        await cutDone
        for (let i = 0; i < 500 && sessionManager.findOpenByOpenCodeSessionId(key); i++) await Bun.sleep(10)
        expect(requests).toHaveLength(1)
        pushResults(tasks, (index) => `<subagent state="completed">${reviewers[index]} approves</subagent>`)
        if (!rebuilds) {
          const error = await read().catch((caught: unknown) => caught)
          expect(APICallError.isInstance(error)).toBe(true)
          expect((error as APICallError).message).toContain("after a call Cursor ran itself")
          expect(requests).toHaveLength(1)
          return
        }
        const rebuilt = await read()
        expect(hostCalls(rebuilt)).toHaveLength(0)
        expect(rebuilt.some(part => part.type === "finish" && part.finishReason.unified === "stop")).toBe(true)
        expect(requests).toHaveLength(2)
        expect(requests[1]!.action.resume_action).toBeUndefined()
        const text = requests[1]!.action.user_message_action!.user_message.text
        expect(text.match(/build finished/g)).toHaveLength(1)
        for (const agent of reviewers) expect(text.match(new RegExp(`${agent} approves`, "g"))).toHaveLength(1)
      } finally {
        sessionManager.dispose()
        await settleRunSavesForTests()
        for (const connection of connections) connection.destroy()
        setHostCacheDirOverride(undefined)
        fs.rmSync(root, { recursive: true, force: true })
      }
    }, 30_000)
  }

  for (const cut of ["final", "none", "reset"] as const) {
    it(`reads a lost Run's verdict before the unfinished plan notice (${cut})`, async () => {
      const key = `ses_held_tool_plan_${cut}`
      const { requests, prompt, read, cleanup, waitForCut } = setup("held", cut, key)
      const note = "<system-update>Use bazel for builds.</system-update>"
      restorePersistedHostNotes(key, encodePersistedHostNotes([note]))
      try {
        const calls = hostCalls(await read())
        expect(requests[0]!.action.user_message_action!.user_message.text).toContain("Use bazel for builds.")
        expect(releaseHostNoteInjectionsForTests(key).undelivered).toEqual([])
        expect(calls).toHaveLength(1)
        expect(recordPlanOperation(key, {
          interactionId: 42, hostCallId: calls[0]!.toolCallId, planPath: "/workspace/plan.md",
          planUri: "file:///workspace/plan.md", markdown: "# Plan\n", phase: "write", bridgeKind: "approve",
          afterWrite: "review", reviewToolName: "question",
        }).ok).toBe(true)
        await waitForCut()
        pushResult(prompt, calls[0]!, { type: "text", value: "ledger line written" })
        const result = await read().catch((caught: unknown) => caught)
        if (cut === "final") {
          expect(APICallError.isInstance(result)).toBe(true)
          expect((result as APICallError).message).not.toContain("Plan saving or review was interrupted")
        } else if (cut === "none") {
          expect(APICallError.isInstance(result)).toBe(true)
          expect((result as APICallError).message).toContain("may already hold")
        } else {
          const parts = result as LanguageModelV3StreamPart[]
          expect(parts.flatMap(part => part.type === "text-delta" ? [part.delta] : []).join(""))
            .toContain("Plan saving or review was interrupted")
          expect(releaseHostNoteInjectionsForTests(key).undelivered).toEqual([note])
        }
        expect(requests).toHaveLength(1)
      } finally {
        resetPlanOperationsForTests()
        await cleanup()
      }
    }, 30_000)
  }

  for (const step of ["held", "open"] as const) {
    it(`opens no Run when the user stops while the host still runs the call (${step} step)`, async () => {
      const key = `ses_held_tool_cut_stop_${step}`
      const { requests, prompt, read, cleanup } = setup(step, "reset", key)
      try {
        const calls = hostCalls(await read())
        expect(calls).toHaveLength(1)
        await Bun.sleep(100)
        await notifyHostInterrupt(key, "user", Date.now())
        // The stopped step's late result arrives on an aborted call.
        pushResult(prompt, calls[0]!, { type: "error-text", value: "Tool execution aborted" })
        const stopped = await read(AbortSignal.abort()).then(() => undefined, (error: unknown) => error)
        expect(stopped).toBeInstanceOf(Error)
        await Bun.sleep(100)
        expect(requests).toHaveLength(1)
      } finally {
        await cleanup()
      }
    }, 30_000)
  }
})

describe("follow-up checkpoint arrival", () => {
  it("resumes a progress follow-up checkpoint received before reopen returns", async () => {
    const checkpoint = Uint8Array.of(10, 1, 8)
    let firstRun: http2.ServerHttp2Stream | undefined
    const requests: Record<string, unknown>[] = []
    scripted = (run, message) => {
      if (!message.run_request) return
      const request = message.run_request as Record<string, unknown>
      requests.push(request)
      const send = (message: Record<string, unknown>) => run.write(frame(encodeMessage("AgentServerMessage", message)))
      if (requests.length === 1) {
        firstRun = run
        send({ conversation_checkpoint_update: Uint8Array.of(10, 1, 7) })
        send({ interaction_update: { text_delta: { text: "Checking the workspace" } } })
      } else if (requests.length === 2) {
        send({ conversation_checkpoint_update: checkpoint })
        send({ interaction_update: { thinking_delta: { text: "Continuing the follow-up" } } })
        run.end(frame(Buffer.from('{"error":{"code":"unavailable"}}'), 2))
      } else {
        send({ interaction_update: { text_delta: { text: "Finished." } } })
        send({ interaction_update: { turn_ended: {} } })
        run.end()
      }
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-followup-checkpoint-"))
    cacheHttp2SessionForTests(ORIGIN, client)
    try {
      const key = "ses_progress_early_checkpoint"
      const model = createCursor({
        name: "cursor", accessToken: "example-token", agentBaseURL: ORIGIN, cacheDir: root, workspaceRoot: root,
        retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
      }).languageModel("composer-2.5")
      const { stream } = await model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "Check the workspace" }] }],
        tools: [{ type: "function", name: "bash", inputSchema: { type: "object", properties: { command: { type: "string" } } } }],
        headers: { "x-opencode-session-id": key },
      })
      let wrapped = false
      let arrivedBeforeReopenReturned = false
      const parts: LanguageModelV3StreamPart[] = []
      const reader = stream.getReader()
      for (;;) {
        const { done, value: part } = await reader.read()
        if (done) break
        parts.push(part)
        if (part.type !== "text-delta" || wrapped) continue
        wrapped = true
        const session = sessionManager.findOpenByOpenCodeSessionId(key)!
        const reopen = session.reopenWithUserMessage!
        session.reopenWithUserMessage = async (text, signal) => {
          const before = lastFrameArrival()
          await reopen(text, signal)
          // Force the replacement's frames into the transport queue while the
          // caller still awaits reopen (as while draining the previous stream).
          for (let i = 0; i < 100 && lastFrameArrival() === before; i++) await Bun.sleep(1)
          arrivedBeforeReopenReturned = lastFrameArrival() > before
          expect(arrivedBeforeReopenReturned).toBe(true)
        }
        firstRun!.write(frame(encodeMessage("AgentServerMessage", { interaction_update: { turn_ended: {} } })))
      }
      expect(arrivedBeforeReopenReturned).toBe(true)
      expect(requests).toHaveLength(3)
      expect(requests[2]).toMatchObject({ action: { resume_action: {} }, conversation_state: checkpoint,
        conversation_id: requests[0]!.conversation_id })
      expect(parts.some(part => part.type === "text-delta" && part.delta === "Finished.")).toBe(true)
    } finally {
      await settleRunSavesForTests()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
})

describe("Run errors as the host sees them", () => {
  for (const method of ["doStream", "doGenerate"] as const) {
    for (const failure of ["empty token", "rejected login"] as const) {
      it(`ends ${method} on a pre-stream ${failure} without opening a Run`, async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-run-auth-error-"))
        let requests = 0
        const authError = new CursorAuthError("Cursor login expired; sign in again")
        try {
          const model = createCursor({
            name: "cursor",
            cacheDir: root,
            getAccessToken: async () => {
              requests++
              if (failure === "rejected login") throw authError
              return ""
            },
          }).languageModel("composer-2.5")
          let caught: unknown
          try {
            await model[method]({
              prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
              headers: { "x-opencode-session-id": `ses_auth_${method}_${failure}` },
            })
          } catch (error) {
            caught = error
          }
          expect(APICallError.isInstance(caught)).toBe(true)
          expect(caught).toMatchObject({
            statusCode: 401,
            isRetryable: false,
            responseHeaders: { "x-should-retry": "false" },
          })
          expect((caught as APICallError).cause).toBeInstanceOf(CursorAuthError)
          if (failure === "rejected login") expect((caught as APICallError).cause).toBe(authError)
          expect(requests).toBe(1)
          expect(runs).toBe(0)
        } finally {
          await settleRunSavesForTests()
          fs.rmSync(root, { recursive: true, force: true })
        }
      })
    }
  }

  it("reports a request Cursor declared not retryable as a 400 APICallError, without a provider retry", async () => {
    trailer = {
      error: { code: "invalid_argument", message: "Error", details: [{ type: "aiserver.v1.ErrorDetails", value: POLICY_BLOCK }] },
    }
    const error = await streamError("ses_policy_block")

    expect(APICallError.isInstance(error)).toBe(true)
    expect(error).toMatchObject({ statusCode: 400, isRetryable: false })
    expect((error as Error).message).toBe("Cursor API error (code=invalid_argument): Request blocked by Anthropic " +
      "We are unable to complete this request because it was blocked under Anthropic's Usage Policy.")
    expect(runs).toBe(1)
  }, 30_000)

  it("keeps an error without a Cursor verdict as the provider error", async () => {
    trailer = { error: { code: "invalid_argument" } }
    const error = await streamError("ses_plain_error")

    expect(APICallError.isInstance(error)).toBe(false)
    expect(error).toBeInstanceOf(CursorServerError)
    expect((error as Error).message).toBe("Cursor API error (code=invalid_argument)")
    expect(runs).toBe(1)
  }, 30_000)

  it("stops host retries after the Run retry budget is spent", async () => {
    trailer = { error: { code: "unavailable" } }
    const error = await streamError("ses_terminal_budget")

    expect(APICallError.isInstance(error)).toBe(true)
    expect(error).toMatchObject({
      statusCode: 400,
      isRetryable: false,
      responseHeaders: { "x-should-retry": "false" },
    })
    const cause = (error as APICallError).cause
    expect(cause).toBeInstanceOf(CursorRetryExhaustedError)
    expect(cause).toMatchObject({ transient: false, replaySafe: false, code: "unavailable" })
    expect(runs).toBe(2)
  }, 30_000)

  // Cursor CLI sends the same action again. The provider cannot, because the
  // host already shows the reasoning, so the host retries the turn.
  it("leaves the retry to the host after output only, before any checkpoint", async () => {
    trailer = { error: { code: "unavailable" } }
    partialOutput = true
    const error = await streamError("ses_host_retry")

    expect(APICallError.isInstance(error)).toBe(true)
    expect(error).toMatchObject({
      statusCode: undefined,
      isRetryable: true,
      responseHeaders: { "x-should-retry": "true" },
    })
    expect((error as Error).message).not.toContain("automatic retry unsafe")
    const cause = (error as APICallError).cause
    expect(cause).toMatchObject({ hostRetryable: true, transient: false, replaySafe: false, code: "unavailable" })
    expect(runs).toBe(1)
  }, 30_000)
})

describe("retry limits across OpenCode calls", () => {
  it("also budgets transient setup errors and refuses ambiguous uploads", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-setup-retry-budget-"))
    let renewals = 0
    let ambiguous = false
    let transient = true
    const model = createCursor({
      name: "cursor", agentBaseURL: ORIGIN, cacheDir: root,
      getAccessToken: async () => {
        renewals++
        throw new CursorTransportError("connection reset", { transient, replaySafe: !ambiguous, code: "ECONNRESET" })
      },
    }).languageModel("composer-2.5")
    const attempt = async (): Promise<unknown> => {
      try {
        return await model.doStream({
          prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
          headers: { "x-opencode-session-id": "ses_setup_retries" },
        })
      } catch (error) { return error }
    }
    try {
      for (let i = 0; i < 10; i++) {
        const error = await attempt()
        expect(error).toMatchObject({ isRetryable: true })
        expect(error).toHaveProperty("message", expect.not.stringContaining("after visible output"))
      }
      expect(await attempt()).toMatchObject({ isRetryable: false, responseHeaders: { "x-should-retry": "false" } })
      expect(renewals).toBe(11)
      await notifyHostInterrupt("ses_setup_retries", "test-stop")
      ambiguous = true
      expect(await attempt()).toMatchObject({ isRetryable: false, responseHeaders: { "x-should-retry": "false" } })
      transient = false
      expect(await attempt()).toMatchObject({ isRetryable: false, responseHeaders: { "x-should-retry": "false" } })
      expect(runs).toBe(0)
    } finally {
      setHostCacheDirOverride(undefined)
      await settleRunSavesForTests()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  for (const [endless, maxAttempts, retries, reminderParts, incomplete] of [
    [false, undefined, 3, false, false], [false, 2, 1, false, false], [true, 2, 14, false, false],
    [false, undefined, 3, true, false], [false, 2, 1, true, false], [true, 2, 14, true, false],
    [false, undefined, 10, true, true],
  ] as const) {
    it(`bounds output-only host retries (endless=${endless}, maxAttempts=${maxAttempts}, reminderParts=${reminderParts}, bareEOF=${incomplete})`, async () => {
      const saved = process.env.CURSOR_ENDLESS_RETRIES
      if (endless) process.env.CURSOR_ENDLESS_RETRIES = "true"
      else delete process.env.CURSOR_ENDLESS_RETRIES
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-host-retry-budget-"))
      cacheHttp2SessionForTests(ORIGIN, client)
      trailer = { error: { code: "unavailable" } }
      partialOutput = true
      bareEof = incomplete
      const prompt: LanguageModelV3CallOptions["prompt"] = [{ role: "user", content: [{ type: "text", text: "Hello" }] }]
      const attempt = async () => {
        // Hosts may reload the SDK model between retries. State belongs to the turn.
        const model = createCursor({
          name: "cursor", accessToken: "example-token", agentBaseURL: ORIGIN, cacheDir: root,
          retry: { maxAttempts, baseDelayMs: 1, maxDelayMs: 1 },
        }).languageModel("composer-2.5")
        try {
          // A plugin transforms this request, not the host's stored history.
          const requestPrompt = structuredClone(prompt)
          const last = requestPrompt.at(-1)
          if (reminderParts && last?.role === "user") last.content.push({ type: "text",
            text: `<system-reminder>Pending task reminder ${runs}</system-reminder>` })
          const { stream } = await model.doStream({ prompt: requestPrompt, headers: { "x-opencode-session-id": "ses_repeated_output" } })
          const reader = stream.getReader()
          while (!(await reader.read()).done) { /* drain host-visible output */ }
        } catch (error) { return error }
        return undefined
      }
      try {
        for (let i = 0; i < retries; i++) {
          expect(await attempt()).toMatchObject({ isRetryable: true, responseHeaders: { "x-should-retry": "true" } })
          // Canonical OpenCode 2 runner/llm.ts Continue outcome, lowered by
          // runner/to-llm-message.ts as a plain user message (no reminder wrapper).
          prompt.push({ role: "assistant", content: [{ type: "text", text: `partial ${i}` }] })
          prompt.push({ role: "user", content: [{ type: "text", text: "The previous response was interrupted. Continue from where you left off without repeating completed content." }] })
        }
        expect(runs).toBe(retries)
        if (endless) {
          trailer = { error: { code: "permission_denied" } }
          expect(await attempt()).toMatchObject({ isRetryable: false, responseHeaders: { "x-should-retry": "false" } })
        } else {
          expect(await attempt()).toMatchObject({ isRetryable: false, statusCode: 400, responseHeaders: { "x-should-retry": "false" } })
          expect(runs).toBe(retries + 1)
          // After a final error, typing the exact same text is a genuine new
          // request: there is no pending provider-requested host retry.
          prompt.push({ role: "assistant", content: [{ type: "text", text: "final partial answer" }] })
          prompt.push({ role: "user", content: [{ type: "text", text: "The previous response was interrupted. Continue from where you left off without repeating completed content." }] })
          expect(await attempt()).toMatchObject({ isRetryable: true })
          for (let i = 1; i < retries; i++) {
            prompt.push({ role: "assistant", content: [{ type: "text", text: `literal request partial ${i}` }] })
            prompt.push({ role: "user", content: [{ type: "text", text: "The previous response was interrupted. Continue from where you left off without repeating completed content." }] })
            expect(await attempt()).toMatchObject({ isRetryable: true })
          }
          expect(await attempt()).toMatchObject({ isRetryable: false })
          // A later identical user message is a new turn, even in the same session.
          prompt.push({ role: "user", content: [{ type: "text", text: "Hello" }] })
          expect(await attempt()).toMatchObject({ isRetryable: true })
          // Stop also resets a failed turn when there is no longer an open Run.
          await notifyHostInterrupt("ses_repeated_output", "test-stop")
          expect(await attempt()).toMatchObject({ isRetryable: true })
          scripted = (stream, message) => {
            if (!message.run_request) return
            stream.end(frame(encodeMessage("AgentServerMessage", { interaction_update: { turn_ended: {} } })))
          }
          expect(await attempt()).toBeUndefined()
          scripted = undefined
          expect(await attempt()).toMatchObject({ isRetryable: true })
        }
      } finally {
        if (saved === undefined) delete process.env.CURSOR_ENDLESS_RETRIES
        else process.env.CURSOR_ENDLESS_RETRIES = saved
        sessionManager.dispose()
        setHostCacheDirOverride(undefined)
        await settleRunSavesForTests()
        fs.rmSync(root, { recursive: true, force: true })
      }
    }, 30_000)
  }
})

describe("a session that returns to a Location", () => {
  it("resumes the conversation another Location advanced, without that Location's stale turn state", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-location-return-"))
    const graph = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-location-graph-"))
    fs.cpSync(path.resolve(import.meta.dir, "../src"), path.join(graph, "src"), { recursive: true })
    fs.symlinkSync(path.resolve(import.meta.dir, "../node_modules"), path.join(graph, "node_modules"), "dir")
    const load = (file: string) => import(pathToFileURL(path.join(graph, "src", file)).href)
    const other = await load("index.ts") as typeof import("../src/index.js")
    const otherConnect = await load("transport/connect.ts") as typeof import("../src/transport/connect.js")
    const otherModel = await load("language-model.ts") as typeof import("../src/language-model.js")
    const otherSessions = await load("session.ts") as typeof import("../src/session.js")
    type Request = { conversation_id: string; conversation_state?: Uint8Array }
    const requests: Request[] = []
    scripted = (stream, message) => {
      if (!message.run_request) return
      requests.push(message.run_request as Request)
      const send = (value: Record<string, unknown>) => stream.write(frame(encodeMessage("AgentServerMessage", value)))
      send({ conversation_checkpoint_update: Uint8Array.of(0x2a, 5, 8, 42, 16, 0x80, requests.length) })
      send({ interaction_update: { text_delta: { text: "Cursor answer" } } })
      send({ interaction_update: { turn_ended: {} } })
      stream.end()
    }
    const read = async (model: LanguageModelV3, options: LanguageModelV3CallOptions) => {
      const reader = (await model.doStream(options)).stream.getReader()
      while (!(await reader.read()).done) { /* drain */ }
    }
    const user = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }] })
    const answer = { role: "assistant" as const, content: [{ type: "text" as const, text: "Cursor answer" }] }
    const headers = { "x-opencode-session-id": "ses_location_return" }
    const tools = [{ type: "function" as const, name: "bash", inputSchema: { type: "object", properties: { command: { type: "string" } } } }]
    cacheHttp2SessionForTests(ORIGIN, client)
    otherConnect.cacheHttp2SessionForTests(ORIGIN, client)
    const options = { name: "cursor", accessToken: "example-token", agentBaseURL: ORIGIN, cacheDir: root, workspaceRoot: root }
    try {
      const locationA = createCursor(options).languageModel("composer-2.5")
      const locationB = other.createCursor(options).languageModel("composer-2.5")
      await read(locationA, { headers, tools, prompt: [user("Hello")] })
      // Location A compacts on the Cursor model; its next Run would rebase from the summary.
      await read(locationA, { headers, tools, prompt: [user("Hello"), answer, user("Summarize")],
        providerOptions: { cursor: { opencodeCompaction: true } } })
      await settleRunSavesForTests()
      // The session moves to Location B, which rebases and continues there.
      await read(locationB, { headers, tools, prompt: [user("SUMMARY"), user("Continue")] })
      await otherModel.settleRunSavesForTests()
      const advanced = requests.at(-1)!
      expect(advanced.conversation_state?.length ?? 0).toBe(0)
      // Back in Location A, the next turn resumes B's conversation.
      await read(locationA, { headers, tools, prompt: [user("SUMMARY"), user("Continue"), answer, user("Next")] })
      const returned = requests.at(-1)!
      expect(requests).toHaveLength(4)
      expect(returned.conversation_id).toBe(advanced.conversation_id)
      expect(Array.from(returned.conversation_state ?? [])).toEqual([0x2a, 5, 8, 42, 16, 0x80, 3])
    } finally {
      otherSessions.sessionManager.dispose()
      await otherModel.settleRunSavesForTests()
      otherModel.resetTurnStateForTests()
      sessionManager.dispose()
      await settleRunSavesForTests()
      setHostCacheDirOverride(undefined)
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(graph, { recursive: true, force: true })
    }
  }, 30_000)

  it("leaves a Run it still holds alone when another Location advanced the conversation meanwhile", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-location-held-"))
    const graph = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-location-graph-"))
    fs.cpSync(path.resolve(import.meta.dir, "../src"), path.join(graph, "src"), { recursive: true })
    fs.symlinkSync(path.resolve(import.meta.dir, "../node_modules"), path.join(graph, "node_modules"), "dir")
    const load = (file: string) => import(pathToFileURL(path.join(graph, "src", file)).href)
    const other = await load("index.ts") as typeof import("../src/index.js")
    const otherConnect = await load("transport/connect.ts") as typeof import("../src/transport/connect.js")
    const otherModel = await load("language-model.ts") as typeof import("../src/language-model.js")
    const otherSessions = await load("session.ts") as typeof import("../src/session.js")
    const replaced: string[] = []
    onCopyStateReplaced(key => replaced.push(key))
    const requests: unknown[] = []
    let heldResult = false
    scripted = (stream, message) => {
      const send = (value: Record<string, unknown>) => stream.write(frame(encodeMessage("AgentServerMessage", value)))
      if (message.run_request) {
        requests.push(message.run_request)
        send({ conversation_checkpoint_update: Uint8Array.of(0x2a, 5, 8, 42, 16, 0x80, requests.length) })
        if (requests.length === 1) {
          send({ exec_server_message: { id: 1, shell_args: { command: "echo done", tool_call_id: "command" } } })
          return
        }
        send({ interaction_update: { text_delta: { text: "Cursor answer" } } })
        send({ interaction_update: { turn_ended: {} } })
        stream.end()
        return
      }
      if (message.exec_client_message && !heldResult) {
        heldResult = true
        send({ interaction_update: { tool_call_completed: { call_id: "command" } } })
        send({ conversation_checkpoint_update: Uint8Array.of(0x2a, 5, 8, 42, 16, 0x80, 9) })
        send({ interaction_update: { text_delta: { text: "Done" } } })
        send({ interaction_update: { turn_ended: {} } })
        stream.end()
      }
    }
    const read = async (model: LanguageModelV3, options: LanguageModelV3CallOptions) => {
      const parts: LanguageModelV3StreamPart[] = []
      const reader = (await model.doStream(options)).stream.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return parts
        parts.push(value)
      }
    }
    const headers = { "x-opencode-session-id": "ses_location_held" }
    const tools = [{ type: "function" as const, name: "bash", inputSchema: { type: "object", properties: { command: { type: "string" } } } }]
    cacheHttp2SessionForTests(ORIGIN, client)
    otherConnect.cacheHttp2SessionForTests(ORIGIN, client)
    const options = { name: "cursor", accessToken: "example-token", agentBaseURL: ORIGIN, cacheDir: root, workspaceRoot: root }
    try {
      const locationA = createCursor(options).languageModel("composer-2.5")
      const locationB = other.createCursor(options).languageModel("composer-2.5")
      const prompt: LanguageModelV3CallOptions["prompt"] = [{ role: "user", content: [{ type: "text", text: "Run it" }] }]
      const call = (await read(locationA, { headers, tools, prompt })).find(part => part.type === "tool-call")
      if (!call || call.type !== "tool-call") throw new Error("Expected the shell call")
      await read(locationB, { headers, tools, prompt: [{ role: "user", content: [{ type: "text", text: "Meanwhile" }] }] })
      await otherModel.settleRunSavesForTests()
      prompt.push({ role: "assistant", content: [{ type: "tool-call", toolCallId: call.toolCallId, toolName: call.toolName, input: JSON.parse(call.input) }] })
      prompt.push({ role: "tool", content: [{ type: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, output: { type: "text", value: "done" } }] })
      const parts = await read(locationA, { headers, tools, prompt })
      expect(replaced).toEqual([])
      expect(heldResult).toBe(true)
      expect(requests).toHaveLength(2)
      expect(parts.some(part => part.type === "finish")).toBe(true)
    } finally {
      otherSessions.sessionManager.dispose()
      await otherModel.settleRunSavesForTests()
      otherModel.resetTurnStateForTests()
      sessionManager.dispose()
      await settleRunSavesForTests()
      setHostCacheDirOverride(undefined)
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(graph, { recursive: true, force: true })
    }
  }, 30_000)
})


describe("foreign compaction follow-ups", () => {
  type Request = { conversation_id: string; conversation_state?: Uint8Array
    action: { resume_action?: unknown; user_message_action?: { user_message: { text: string } } } }
  const tool = (name: string) => ({ type: "function" as const, name, inputSchema: { type: "object", properties: { command: { type: "string" } } } })
  const text = (value: string) => ({ role: "user" as const, content: [{ type: "text" as const, text: value }] })
  const readParts = async (model: LanguageModelV3, options: LanguageModelV3CallOptions) => {
    const parts: LanguageModelV3StreamPart[] = []
    const reader = (await model.doStream(options)).stream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return parts
      parts.push(value)
    }
  }
  const appendResult = (prompt: LanguageModelV3CallOptions["prompt"], parts: LanguageModelV3StreamPart[], output: string) => {
    const call = parts.find(part => part.type === "tool-call")
    if (!call || call.type !== "tool-call") throw new Error("Expected a host tool call")
    prompt.push({ role: "assistant", content: [{ type: "tool-call", toolCallId: call.toolCallId, toolName: call.toolName, input: JSON.parse(call.input) }] })
    prompt.push({ role: "tool", content: [{ type: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, output: { type: "text", value: output } }] })
  }
  // The first Run waits on a shell call; every later Run answers and ends its turn.
  const heldThenAnswer = (requests: Request[]) => (stream: http2.ServerHttp2Stream, message: Record<string, unknown>) => {
    if (!message.run_request) return
    requests.push(message.run_request as Request)
    const send = (value: Record<string, unknown>) => stream.write(frame(encodeMessage("AgentServerMessage", value)))
    send({ conversation_checkpoint_update: Uint8Array.of(0x2a, 5, 8, 42, 16, 0x80, requests.length) })
    if (requests.length === 1) {
      send({ exec_server_message: { id: 1, shell_args: { command: "echo done", tool_call_id: "command" } } })
      return
    }
    send({ interaction_update: { text_delta: { text: "Cursor answer" } } })
    send({ interaction_update: { turn_ended: {} } })
    stream.end()
  }
  const restart = async () => {
    sessionManager.dispose()
    await settleRunSavesForTests()
    resetTurnStateForTests()
    resetHostHistoryRewritesForTests()
    resetConversationPersistenceForTests()
    resetConversationBindingsForTests()
    resetCheckpointsForTests()
  }

  // Without a rewrite, a restart still rebuilds the late tool result from host history.
  for (const scenario of ["live", "restart", "restart-without-rewrite"] as const) {
    it(`keeps the host notes a held Run carried when its next Run starts without its checkpoint (${scenario})`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-foreign-notes-"))
      const key = `ses_foreign_notes_${scenario}`
      const requests: Request[] = []
      scripted = heldThenAnswer(requests)
      cacheHttp2SessionForTests(ORIGIN, client)
      try {
        const model = createCursor({ name: "cursor", accessToken: "example-token", agentBaseURL: ORIGIN,
          cacheDir: root, workspaceRoot: root }).languageModel("composer-2.5")
        const prompt: LanguageModelV3CallOptions["prompt"] = [text("Original large history")]
        const options: LanguageModelV3CallOptions = { prompt, headers: { "x-opencode-session-id": key }, tools: [tool("bash")] }
        restorePersistedHostNotes(key, encodePersistedHostNotes(["<system-update>Use bazel for builds.</system-update>"]))
        const parts = await readParts(model, options)
        expect(requests[0]!.action.user_message_action!.user_message.text).toContain("Use bazel for builds.")
        appendResult(prompt, parts, "COMPLETED_HOST_RESULT")
        const restarts = scenario !== "live"
        const rewrites = scenario !== "restart-without-rewrite"
        if (restarts) await notifyHostInterrupt(key, "shutdown")
        if (rewrites) await noteHostHistoryRewrite(root, key, "evt_compacted")
        if (restarts) await restart()
        if (rewrites) prompt[0] = text("COMPACTED_HOST_SUMMARY")
        await readParts(model, options)
        const seed = requests.at(-1)!.action.user_message_action!.user_message.text
        expect(requests.at(-1)!.conversation_state?.length ?? 0).toBe(0)
        if (rewrites) expect(seed).toContain("COMPACTED_HOST_SUMMARY")
        expect(seed.split("Use bazel for builds.")).toHaveLength(2)
      } finally {
        sessionManager.dispose()
        await settleRunSavesForTests()
        fs.rmSync(root, { recursive: true, force: true })
      }
    })
  }

  it("keeps a held Run's notes through restart, a compaction Run and another restart", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-foreign-notes-compaction-"))
    const key = "ses_foreign_notes_compaction"
    const requests: Request[] = []
    scripted = heldThenAnswer(requests)
    cacheHttp2SessionForTests(ORIGIN, client)
    try {
      const model = createCursor({ name: "cursor", accessToken: "example-token", agentBaseURL: ORIGIN,
        cacheDir: root, workspaceRoot: root }).languageModel("composer-2.5")
      const prompt: LanguageModelV3CallOptions["prompt"] = [text("Original large history")]
      const options: LanguageModelV3CallOptions = { prompt, headers: { "x-opencode-session-id": key }, tools: [tool("bash")] }
      restorePersistedHostNotes(key, encodePersistedHostNotes(["<system-update>Use bazel for builds.</system-update>"]))
      appendResult(prompt, await readParts(model, options), "COMPLETED_HOST_RESULT")
      await notifyHostInterrupt(key, "shutdown")
      await restart()
      // The host summarizes on Cursor; its compaction Run does not deliver the note.
      await readParts(model, { prompt: [...prompt, text("Summarize the conversation.")], tools: [],
        headers: { "x-opencode-session-id": key }, providerOptions: { cursor: { [CURSOR_COMPACTION_OPTION]: true } } })
      expect(requests.at(-1)!.action.user_message_action!.user_message.text).not.toContain("Use bazel for builds.")
      await restart()
      prompt.splice(0, prompt.length, text("COMPACTED_HOST_SUMMARY"), text("Continue."))
      await readParts(model, options)
      const seed = requests.at(-1)!.action.user_message_action!.user_message.text
      expect(requests.at(-1)!.conversation_state?.length ?? 0).toBe(0)
      expect(seed).toContain("COMPACTED_HOST_SUMMARY")
      expect(seed.split("Use bazel for builds.")).toHaveLength(2)
    } finally {
      sessionManager.dispose()
      await settleRunSavesForTests()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("keeps restored request notes when its checkpoint cannot be loaded and recovery rebuilds history", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-foreign-notes-missing-blob-"))
    const key = "ses_restored_notes_missing_blob"
    const requests: Request[] = []
    const answer = heldThenAnswer(requests)
    scripted = (stream, message) => {
      if (message.run_request && requests.length === 1) {
        requests.push(message.run_request as Request)
        stream.write(frame(encodeMessage("AgentServerMessage", {
          kv_server_message: { id: 1, get_blob_args: { blob_id: new Uint8Array(32).fill(0xc8) } },
        })))
      } else if (message.kv_client_message && requests.length === 2) {
        stream.end(frame(Buffer.from(JSON.stringify({ error: { code: "internal" } })), 2))
      } else answer(stream, message)
    }
    cacheHttp2SessionForTests(ORIGIN, client)
    try {
      const model = createCursor({ name: "cursor", accessToken: "example-token", agentBaseURL: ORIGIN,
        cacheDir: root, workspaceRoot: root, retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 } }).languageModel("composer-2.5")
      const prompt: LanguageModelV3CallOptions["prompt"] = [text("Original history")]
      const options: LanguageModelV3CallOptions = { prompt, headers: { "x-opencode-session-id": key }, tools: [tool("bash")] }
      restorePersistedHostNotes(key, encodePersistedHostNotes(["<system-update>Use bazel for builds.</system-update>"]))
      await readParts(model, options)
      await notifyHostInterrupt(key, "shutdown")
      await restart()
      prompt.push(text("Continue."))
      await readParts(model, options)
      expect(requests).toHaveLength(3)
      expect(requests[1]!.conversation_state!.length).toBeGreaterThan(0)
      expect(requests[1]!.action.user_message_action!.user_message.text).not.toContain("Use bazel for builds.")
      expect(requests[2]!.conversation_state?.length ?? 0).toBe(0)
      expect(requests[2]!.action.user_message_action!.user_message.text.split("Use bazel for builds.")).toHaveLength(2)
    } finally {
      sessionManager.dispose()
      await settleRunSavesForTests()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("leaves the rebase to the main turn when a smaller-catalog helper arrives first", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-foreign-helper-"))
    const key = "ses_foreign_helper"
    const requests: Request[] = []
    scripted = heldThenAnswer(requests)
    cacheHttp2SessionForTests(ORIGIN, client)
    try {
      const model = createCursor({ name: "cursor", accessToken: "example-token", agentBaseURL: ORIGIN,
        cacheDir: root, workspaceRoot: root }).languageModel("composer-2.5")
      const prompt: LanguageModelV3CallOptions["prompt"] = [text("Original large history")]
      const options: LanguageModelV3CallOptions = { prompt, headers: { "x-opencode-session-id": key }, tools: [tool("bash"), tool("task")] }
      appendResult(prompt, await readParts(model, options), "COMPLETED_HOST_RESULT")
      await noteHostHistoryRewrite(root, key, "evt_compacted")
      prompt[0] = text("COMPACTED_HOST_SUMMARY")
      await readParts(model, { prompt: [text("Helper task")], headers: { "x-opencode-session-id": key }, tools: [tool("bash")] })
      expect(hasHostHistoryRewrite(root, key)).toBe(true)
      await readParts(model, options)
      const main = requests.at(-1)!
      expect(main.conversation_state?.length ?? 0).toBe(0)
      expect(main.action.user_message_action!.user_message.text).toContain("COMPACTED_HOST_SUMMARY")
    } finally {
      sessionManager.dispose()
      await settleRunSavesForTests()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("keeps a consumed rewrite only as a tombstone against a late copy of its event", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-foreign-forget-"))
    const key = "ses_foreign_forget"
    const requests: Request[] = []
    scripted = heldThenAnswer(requests)
    cacheHttp2SessionForTests(ORIGIN, client)
    try {
      const model = createCursor({ name: "cursor", accessToken: "example-token", agentBaseURL: ORIGIN,
        cacheDir: root, workspaceRoot: root }).languageModel("composer-2.5")
      const prompt: LanguageModelV3CallOptions["prompt"] = [text("Original large history")]
      const options: LanguageModelV3CallOptions = { prompt, headers: { "x-opencode-session-id": key }, tools: [tool("bash")] }
      appendResult(prompt, await readParts(model, options), "COMPLETED_HOST_RESULT")
      await noteHostHistoryRewrite(root, key, "evt_compacted")
      prompt[0] = text("COMPACTED_HOST_SUMMARY")
      await readParts(model, options)
      expect(hasHostHistoryRewrite(root, key)).toBe(false)
      // Another module copy can deliver the same compaction event after the main turn consumed it.
      await noteHostHistoryRewrite(root, key, "evt_compacted")
      expect(hasHostHistoryRewrite(root, key)).toBe(false)
    } finally {
      sessionManager.dispose()
      await settleRunSavesForTests()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
