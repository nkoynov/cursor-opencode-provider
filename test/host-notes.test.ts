import { describe, it, expect, afterEach } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { sessionManager, type CursorSession } from "../src/session.js"
import {
  deliverContinuationResults,
  extractPromptHistory,
  extractTrailingToolResults,
  preparePriorSessionForFreshTurn,
  pump,
  pumpWithRecovery,
  resetTurnStateForTests,
} from "../src/language-model.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { resetCursorShellCalls } from "../src/shell-timeout.js"
import { resetConversationBindingsForTests, restoreConversationBinding } from "../src/protocol/conversation-bind.js"
import { getCheckpoint, resetCheckpointsForTests } from "../src/protocol/checkpoint.js"
import { resetConversationPersistenceForTests } from "../src/protocol/conversation-persistence.js"
import { hydrateConversationState } from "../src/protocol/conversation-state.js"

type Prompt = LanguageModelV3CallOptions["prompt"]

const NOTE = "<system-update>\nInstructions from: /repo/pkg/AGENTS.md\nIndent with tabs.\n</system-update>"
const LATER_NOTE = "<system-update>\nThe following skill IDs are no longer available: repro.\n</system-update>"

let seq = 0
function liveSession(writes: Uint8Array[], root = "/tmp"): CursorSession {
  const id = `hostnotes${++seq}`
  return {
    sessionId: id,
    conversationId: `conv-${id}`,
    stream: {
      write(frame: Uint8Array) { writes.push(frame) },
      end() {},
      frames: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }),
      destroy() {},
      isClosed: () => false,
    } as any,
    frames: { next: async () => ({ done: true, value: undefined }) } as any,
    pending: new Map(),
    blobs: new Map(),
    toolDescriptors: [],
    requestContext: { env: { workspace_paths: [root] } },
    usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
    allowTools: true,
    pumpActive: false,
    heartbeat: null,
    expiresAt: Date.now() + 10_000,
  } as unknown as CursorSession
}

function toolResult(live: CursorSession, execId: number, toolName: string, value: string, type = "text"): Prompt[number] {
  return {
    role: "tool",
    content: [{
      type: "tool-result",
      toolCallId: `cursor_${live.sessionId}_${execId}`,
      toolName,
      output: { type, value },
    }],
  } as Prompt[number]
}

function hostNote(text: string): Prompt[number] {
  return { role: "user", content: [{ type: "text", text }] } as Prompt[number]
}

function step(...messages: Prompt): Prompt {
  return [{ role: "user", content: [{ type: "text", text: "go" }] }, ...messages] as Prompt
}

function execMessages(writes: Uint8Array[]): any[] {
  return writes
    .map((frame) => decodeMessage<any>("AgentClientMessage", frame).exec_client_message)
    .filter((message) => message !== undefined)
}

const turnEndedFrame = () => ({
  flags: 0,
  payload: encodeMessage("AgentServerMessage", { interaction_update: { turn_ended: { input_tokens: 1, output_tokens: 1 } } }),
})

function injectionStateFrame(injectionId: string, state: Record<string, unknown>) {
  return {
    flags: 0,
    payload: encodeMessage("AgentServerMessage", {
      interaction_update: { context_injection_state: { injection_id: injectionId, state } },
    }),
  }
}

function injectedNotes(writes: Uint8Array[]): any[] {
  return writes
    .map((frame) => decodeMessage<any>("AgentClientMessage", frame).conversation_action?.inject_context_action)
    .filter((action) => action !== undefined)
}

/** Let the Run checkpoint and end its turn, saving the restart snapshot under `root`. */
function endsTurn(
  live: CursorSession,
  root: string,
  sessionKey: string,
  before: Array<{ flags: number; payload: Uint8Array }> = [],
): CursorSession {
  live.cacheDir = root
  live.openCodeSessionId = sessionKey
  restoreConversationBinding(sessionKey, live.conversationId)
  const frames = [
    ...before,
    { flags: 0, payload: encodeMessage("AgentServerMessage", { conversation_checkpoint_update: Uint8Array.from([7]) }) },
    turnEndedFrame(),
  ]
  live.frames = {
    next: async () => frames.length > 0 ? { done: false, value: frames.shift()! } : { done: true, value: undefined },
  } as CursorSession["frames"]
  return live
}

const controller = { enqueue() {}, error(error: Error) { throw error } } as unknown as ReadableStreamDefaultController<any>

/** The note the next fresh Run of `sessionKey` gets after a provider restart. */
async function hostNoteAfterRestart(root: string, sessionKey: string): Promise<string | undefined> {
  resetConversationPersistenceForTests()
  resetConversationBindingsForTests()
  resetCheckpointsForTests()
  resetTurnStateForTests()
  return (await hydrateConversationState(root, sessionKey))?.hostNote
}

afterEach(() => {
  sessionManager.dispose()
  resetCursorShellCalls()
  resetTurnStateForTests()
  resetConversationPersistenceForTests()
  resetConversationBindingsForTests()
  resetCheckpointsForTests()
})

describe("host notes on held-Run exec results", () => {
  it("keeps a note out of a read's numbered file lines and adds it to the Run's next result", () => {
    const root = fs.mkdtempSync(path.join("/tmp", "cursor-host-notes-"))
    const file = path.join(root, "main.go")
    const lines = Array.from({ length: 161 }, (_, i) => `\tline ${i + 1}`)
    fs.writeFileSync(file, `${lines.join("\n")}\n`)
    try {
      const writes: Uint8Array[] = []
      const live = liveSession(writes, root)
      sessionManager.registerPending(1, live, "read_result", "read", false, { path: file })

      const results = extractTrailingToolResults(step(
        toolResult(live, 1, "read", `Read file ${file}, lines 1-161\n${lines.map((line, i) => `${i + 1}: ${line}`).join("\n")}`),
        hostNote(NOTE),
      ))
      expect(deliverContinuationResults(live, results)).toBe(live)

      const read = execMessages(writes)[0].read_result.success
      expect(read.content).toBe(`${lines.join("\n")}\n`)
      expect(read.content.split("\n").length - 1).toBe(read.total_lines)
      expect(read.total_lines).toBe(161)
      expect(live.deferredNote).toBe(NOTE)

      writes.length = 0
      sessionManager.registerPending(2, live, "shell_stream", "shell", false, {
        shell_stream: true,
        command: "ls",
        working_directory: root,
      })
      deliverContinuationResults(live, extractTrailingToolResults(step(toolResult(live, 2, "shell", "main.go\n"))))

      const stdout = execMessages(writes).flatMap((message) => message.shell_stream?.stdout?.data ?? [])
      expect(stdout).toEqual([`main.go\n\n${NOTE}`])
      expect(live.deferredNote).toBeUndefined()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("puts a note that follows a read on an earlier result of the step", () => {
    const root = fs.mkdtempSync(path.join("/tmp", "cursor-host-notes-"))
    const file = path.join(root, "a.txt")
    fs.writeFileSync(file, "alpha\n")
    try {
      const writes: Uint8Array[] = []
      const live = liveSession(writes, root)
      sessionManager.registerPending(20, live, "shell_stream", "shell", false, {
        shell_stream: true,
        command: "ls",
        working_directory: root,
      })
      sessionManager.registerPending(21, live, "read_result", "read", false, { path: file })

      deliverContinuationResults(live, extractTrailingToolResults(step(
        toolResult(live, 20, "shell", "a.txt\n"),
        toolResult(live, 21, "read", `Read file ${file}, lines 1-1\n1: alpha`),
        hostNote(NOTE),
      )))

      const messages = execMessages(writes)
      expect(messages.flatMap((message) => message.shell_stream?.stdout?.data ?? [])).toEqual([`a.txt\n\n${NOTE}`])
      expect(messages.find((message) => message.read_result).read_result.success.content).toBe("alpha\n")
      expect(live.deferredNote).toBeUndefined()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("keeps a note out of Pi read content", () => {
    const writes: Uint8Array[] = []
    const live = liveSession(writes)
    sessionManager.registerPending(22, live, "pi_read_result", "read", false, { path: "/tmp/pi.txt" })

    deliverContinuationResults(live, extractTrailingToolResults(step(
      toolResult(live, 22, "read", "alpha\nbeta"),
      hostNote(NOTE),
    )))

    expect(execMessages(writes)[0].pi_read_result.success.output).toBe("alpha\nbeta")
    expect(live.deferredNote).toBe(NOTE)
  })

  it("appends the note to a failed read's error text", () => {
    const writes: Uint8Array[] = []
    const live = liveSession(writes)
    sessionManager.registerPending(23, live, "read_result", "read", false, { path: "/tmp/missing.txt" })

    deliverContinuationResults(live, extractTrailingToolResults(step(
      toolResult(live, 23, "read", "File not found: /tmp/missing.txt", "error-text"),
      hostNote(NOTE),
    )))

    expect(execMessages(writes)[0].read_result.error.error).toBe(`File not found: /tmp/missing.txt\n\n${NOTE}`)
    expect(live.deferredNote).toBeUndefined()
  })

  it("appends the note to a failed result's error text", () => {
    const writes: Uint8Array[] = []
    const live = liveSession(writes)
    sessionManager.registerPending(2, live, "write_result", "write", false, { path: "/tmp/x" })

    deliverContinuationResults(live, extractTrailingToolResults(step(
      toolResult(live, 2, "write", "The user rejected permission to use this specific tool call.", "error-text"),
      hostNote(NOTE),
    )))

    expect(execMessages(writes)[0].write_result.error.error)
      .toBe(`The user rejected permission to use this specific tool call.\n\n${NOTE}`)
  })

  it("adds the note as its own MCP content item", () => {
    const writes: Uint8Array[] = []
    const live = liveSession(writes)
    sessionManager.registerPending(3, live, "mcp_result", "t3_thread_read")

    deliverContinuationResults(live, extractTrailingToolResults(step(
      toolResult(live, 3, "t3_thread_read", "{\"messages\":[]}"),
      hostNote(NOTE),
    )))

    expect(execMessages(writes)[0].mcp_result.success.content.map((item: any) => item.text.text))
      .toEqual(["{\"messages\":[]}", NOTE])
  })

  it("streams the note after shell stdout", () => {
    const writes: Uint8Array[] = []
    const live = liveSession(writes)
    sessionManager.registerPending(4, live, "shell_stream", "shell", false, {
      shell_stream: true,
      command: "ls",
      working_directory: "/tmp",
    })

    deliverContinuationResults(live, extractTrailingToolResults(step(
      toolResult(live, 4, "shell", "a.txt\n"),
      hostNote(NOTE),
    )))

    const stdout = execMessages(writes).flatMap((message) => message.shell_stream?.stdout?.data ?? [])
    expect(stdout).toEqual([`a.txt\n\n${NOTE}`])
  })

  it("puts the note on the last result whose shape can hold it", () => {
    const writes: Uint8Array[] = []
    const live = liveSession(writes)
    sessionManager.registerPending(5, live, "mcp_result", "t3_thread_read")
    sessionManager.registerPending(6, live, "write_result", "write", false, { path: "/tmp/out.txt" })

    deliverContinuationResults(live, extractTrailingToolResults(step(
      toolResult(live, 5, "t3_thread_read", "{}"),
      toolResult(live, 6, "write", "Wrote file successfully."),
      hostNote(NOTE),
    )))

    const [mcp, write] = execMessages(writes)
    expect(mcp.mcp_result.success.content.at(-1).text.text).toBe(NOTE)
    expect(JSON.stringify(write)).not.toContain("system-update")
    expect(live.deferredNote).toBeUndefined()
  })

  it("holds a note no result can carry for the Run's next exec result", () => {
    const writes: Uint8Array[] = []
    const live = liveSession(writes)
    sessionManager.registerPending(7, live, "grep_result", "glob", false, { pattern: "*.ts" })
    sessionManager.registerPending(8, live, "todowrite", "todowrite", true)

    deliverContinuationResults(live, extractTrailingToolResults(step(
      toolResult(live, 7, "glob", "a.ts"),
      toolResult(live, 8, "todowrite", "ok"),
      hostNote(NOTE),
    )))
    expect(JSON.stringify(execMessages(writes))).not.toContain("system-update")
    expect(live.deferredNote).toBe(NOTE)

    writes.length = 0
    sessionManager.registerPending(9, live, "mcp_result", "t3_thread_read")
    deliverContinuationResults(live, extractTrailingToolResults(step(
      toolResult(live, 9, "t3_thread_read", "{}"),
      hostNote(LATER_NOTE),
    )))

    expect(execMessages(writes)[0].mcp_result.success.content.at(-1).text.text).toBe(`${NOTE}\n\n${LATER_NOTE}`)
    expect(live.deferredNote).toBeUndefined()
  })

  it("skips a last result whose encoded shape has no text slot", () => {
    const writes: Uint8Array[] = []
    const live = liveSession(writes)
    sessionManager.registerPending(11, live, "mcp_result", "t3_thread_read")
    sessionManager.registerPending(12, live, "shell_result", "shell", false, {
      shell_stream: true,
      command: "sleep 9",
      working_directory: "/tmp",
      timeout_ms: 1000,
      timeout_behavior: 0,
    })

    deliverContinuationResults(live, extractTrailingToolResults(step(
      toolResult(live, 11, "t3_thread_read", "{}"),
      toolResult(live, 12, "shell", "<shell_metadata>\nshell tool terminated command after exceeding timeout 1000 ms.\n</shell_metadata>"),
      hostNote(NOTE),
    )))

    const [mcp, shell] = execMessages(writes)
    expect(shell.shell_result.timeout).toBeDefined()
    expect(mcp.mcp_result.success.content.at(-1).text.text).toBe(NOTE)
    expect(live.deferredNote).toBeUndefined()
  })

  it("keeps the note out of the complete file an edit transaction reads", () => {
    const root = fs.mkdtempSync(path.join("/tmp", "cursor-host-notes-"))
    const file = path.join(root, "edit.ts")
    fs.writeFileSync(file, "export const a = 1\n")
    try {
      const writes: Uint8Array[] = []
      const live = liveSession(writes, root)
      live.editToolCalls = new Map([["edit-1", { path: file }]])
      sessionManager.registerPending(13, live, "mcp_result", "t3_thread_read")
      sessionManager.registerPending(14, live, "read_result", "read", false, { path: file, correlatedEditCallId: "edit-1" })

      deliverContinuationResults(live, extractTrailingToolResults(step(
        toolResult(live, 13, "t3_thread_read", "{}"),
        toolResult(live, 14, "read", `Read file ${file}, lines 1-1\n1: export const a = 1`),
        hostNote(NOTE),
      )))

      const [mcp, read] = execMessages(writes)
      expect(read.read_result.success.content).toBe("export const a = 1\n")
      expect(mcp.mcp_result.success.content.at(-1).text.text).toBe(NOTE)
      expect(live.deferredNote).toBeUndefined()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("keeps the note out of an edit transaction's read that is too large to return whole", () => {
    const root = fs.mkdtempSync(path.join("/tmp", "cursor-host-notes-"))
    const file = path.join(root, "huge.ts")
    fs.writeFileSync(file, "")
    fs.truncateSync(file, 50 * 1024 * 1024 + 1)
    try {
      const writes: Uint8Array[] = []
      const live = liveSession(writes, root)
      live.editToolCalls = new Map([["edit-1", { path: file }]])
      sessionManager.registerPending(15, live, "read_result", "read", false, { path: file, correlatedEditCallId: "edit-1" })

      deliverContinuationResults(live, extractTrailingToolResults(step(
        toolResult(live, 15, "read", `Read file ${file}, lines 1-1\n1: capped preview`),
        hostNote(NOTE),
      )))

      expect(execMessages(writes)[0].read_result.success.content).toBe("capped preview")
      expect(live.deferredNote).toBe(NOTE)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("keeps the note out of an edit transaction's read whose complete file cannot be read", () => {
    const root = fs.mkdtempSync(path.join("/tmp", "cursor-host-notes-"))
    const file = path.join(root, "locked.ts")
    fs.writeFileSync(file, "secret\n")
    fs.chmodSync(file, 0o000)
    try {
      const writes: Uint8Array[] = []
      const live = liveSession(writes, root)
      live.editToolCalls = new Map([["edit-1", { path: file }]])
      sessionManager.registerPending(17, live, "read_result", "read", false, { path: file, correlatedEditCallId: "edit-1" })

      deliverContinuationResults(live, extractTrailingToolResults(step(
        toolResult(live, 17, "read", `Read file ${file}, lines 1-1\n1: host preview`),
        hostNote(NOTE),
      )))

      expect(execMessages(writes)[0].read_result.success.content).toBe("host preview")
      expect(live.deferredNote).toBe(NOTE)
    } finally {
      fs.chmodSync(file, 0o600)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("keeps a step's results and its trailing notes when a dead Run is rebased", () => {
    const live = liveSession([])
    const history = extractPromptHistory(step(
      toolResult(live, 18, "write", "Wrote file successfully."),
      hostNote(NOTE),
      { role: "system", content: LATER_NOTE } as Prompt[number],
    ), { preserveTrailingUser: true, toolResults: "trailing" })

    expect(JSON.stringify(history)).toContain("Wrote file successfully.")
    // System messages reach Cursor through the context epoch, not the seed history.
    expect(history.slice(-2)).toEqual([{ role: "user", content: NOTE }, { role: "system", content: LATER_NOTE }])
  })

  it("keeps a deferred note when the held Run is resumed after an interruption", async () => {
    const root = fs.mkdtempSync(path.join("/tmp", "cursor-host-notes-"))
    try {
      const live = liveSession([])
      live.resumeCheckpoint = new Uint8Array([1])
      live.deferredNote = NOTE
      await pumpWithRecovery({
        initialSession: live,
        controller,
        recover: async () => endsTurn(liveSession([]), root, "ses_resumed"),
      })

      expect(await hostNoteAfterRestart(root, "ses_resumed")).toBe(NOTE)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("carries the note on a background spawn that returned no process id", () => {
    const writes: Uint8Array[] = []
    const live = liveSession(writes)
    sessionManager.registerPending(16, live, "background_shell_spawn_result", "shell", false, {
      command: "sleep 30",
      working_directory: "/tmp",
    })

    deliverContinuationResults(live, extractTrailingToolResults(step(
      toolResult(live, 16, "shell", "started"),
      hostNote(NOTE),
    )))

    expect(execMessages(writes)[0].background_shell_spawn_result.error.error).toEndWith(`\n\n${NOTE}`)
    expect(live.deferredNote).toBeUndefined()
  })

  it("leaves results without a trailing note unchanged", () => {
    const writes: Uint8Array[] = []
    const live = liveSession(writes)
    sessionManager.registerPending(10, live, "mcp_result", "t3_thread_read")

    deliverContinuationResults(live, extractTrailingToolResults(step(toolResult(live, 10, "t3_thread_read", "{}"))))

    expect(execMessages(writes)[0].mcp_result.success.content.map((item: any) => item.text.text)).toEqual(["{}"])
    expect(live.deferredNote).toBeUndefined()
  })
})

describe("host notes a turn ends without delivering", () => {
  let root: string
  const readResult = (live: CursorSession, execId: number) => {
    sessionManager.registerPending(execId, live, "read_result", "read", false, { path: "/tmp/a.ts" })
    return toolResult(live, execId, "read", "Read file /tmp/a.ts, lines 1-1\n1: alpha")
  }

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it("keeps the note of a turn's last read, with its checkpoint, for the session's next user turn", async () => {
    root = fs.mkdtempSync(path.join("/tmp", "cursor-host-notes-"))
    const live = liveSession([])
    deliverContinuationResults(live, extractTrailingToolResults(step(readResult(live, 1), hostNote(NOTE))))

    await pump(endsTurn(live, root, "ses_read"), controller, { textId: "t", reasoningId: "r" })

    expect(live.deferredNote).toBeUndefined()
    expect(await hostNoteAfterRestart(root, "ses_read")).toBe(NOTE)
  })

  it("does not keep a note a later result of the turn carried", async () => {
    root = fs.mkdtempSync(path.join("/tmp", "cursor-host-notes-"))
    const live = liveSession([])
    deliverContinuationResults(live, extractTrailingToolResults(step(readResult(live, 1), hostNote(NOTE))))
    sessionManager.registerPending(2, live, "mcp_result", "t3_thread_read")
    deliverContinuationResults(live, extractTrailingToolResults(step(toolResult(live, 2, "t3_thread_read", "{}"))))

    await pump(endsTurn(live, root, "ses_carried"), controller, { textId: "t", reasoningId: "r" })

    expect(await hostNoteAfterRestart(root, "ses_carried")).toBeUndefined()
  })

  it("keeps the note when a fresh turn drains the prior Run", async () => {
    root = fs.mkdtempSync(path.join("/tmp", "cursor-host-notes-"))
    const live = endsTurn(liveSession([]), root, "ses_drained")
    live.deferredNote = NOTE
    sessionManager.registerSession(live)

    expect(await preparePriorSessionForFreshTurn("ses_drained", { timeoutMs: 1_000 })).toBe("drained")

    expect(await hostNoteAfterRestart(root, "ses_drained")).toBe(NOTE)
  })
})

describe("host notes injected into the held Run", () => {
  let root: string | undefined
  const heldRun = (writes: Uint8Array[]) => {
    const live = liveSession(writes)
    live.runId = `run-${live.sessionId}`
    return live
  }
  const readResult = (live: CursorSession, execId: number) => {
    sessionManager.registerPending(execId, live, "read_result", "read", false, { path: "/tmp/a.ts" })
    return toolResult(live, execId, "read", "Read file /tmp/a.ts, lines 1-1\n1: alpha")
  }
  const noFollowUp = (live: CursorSession) => {
    live.reopenWithUserMessage = async () => { throw new Error("a host note is never a follow-up Run") }
  }

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true })
    root = undefined
  })

  it("injects a note no result of the step can carry before the step's results", () => {
    const writes: Uint8Array[] = []
    const live = heldRun(writes)

    expect(deliverContinuationResults(live, extractTrailingToolResults(step(
      readResult(live, 1),
      readResult(live, 2),
      hostNote(NOTE),
    )))).toBe(live)

    const [first, ...rest] = writes.map((frame) => decodeMessage<any>("AgentClientMessage", frame))
    expect(first.conversation_action.inject_context_action).toMatchObject({
      expected_run_id: live.runId,
      user_context: { user_message: { text: NOTE } },
    })
    expect(rest.filter((message) => message.exec_client_message?.read_result)).toHaveLength(2)
    expect(JSON.stringify(rest)).not.toContain("system-update")
    expect(live.deferredNote).toBeUndefined()
    expect(live.steerInjections).toMatchObject([{ text: NOTE, state: "sent", hostNote: true }])
  })

  it("leaves a note on a result of the step that can carry it", () => {
    const writes: Uint8Array[] = []
    const live = heldRun(writes)
    sessionManager.registerPending(3, live, "mcp_result", "t3_thread_read")

    deliverContinuationResults(live, extractTrailingToolResults(step(
      toolResult(live, 3, "t3_thread_read", "{}"),
      readResult(live, 4),
      hostNote(NOTE),
    )))

    expect(injectedNotes(writes)).toEqual([])
    expect(execMessages(writes)[0].mcp_result.success.content.at(-1).text.text).toBe(NOTE)
  })

  it("injects a deferred note with the Run's next results", () => {
    const writes: Uint8Array[] = []
    const live = heldRun(writes)
    live.deferredNote = NOTE

    deliverContinuationResults(live, extractTrailingToolResults(step(readResult(live, 5), hostNote(LATER_NOTE))))

    expect(injectedNotes(writes).map((action) => action.user_context.user_message.text)).toEqual([`${NOTE}\n\n${LATER_NOTE}`])
    expect(live.deferredNote).toBeUndefined()
  })

  it("closes the Run when the note cannot be written", () => {
    const live = heldRun([])
    live.stream.write = () => { throw new Error("stream closed") }

    expect(deliverContinuationResults(live, extractTrailingToolResults(step(readResult(live, 6), hostNote(NOTE))))).toBeUndefined()
    expect(live.closed).toBe(true)
  })

  it("keeps nothing for the next user turn once Cursor delivered the note", async () => {
    root = fs.mkdtempSync(path.join("/tmp", "cursor-host-notes-"))
    const writes: Uint8Array[] = []
    const live = heldRun(writes)
    noFollowUp(live)
    deliverContinuationResults(live, extractTrailingToolResults(step(readResult(live, 1), hostNote(NOTE))))
    const id = injectedNotes(writes)[0].injection_id

    await pump(endsTurn(live, root, "ses_injected", [
      injectionStateFrame(id, { queued: {} }),
      injectionStateFrame(id, { delivered: { step: 2 } }),
    ]), controller, { textId: "t", reasoningId: "r" })

    expect(getCheckpoint(live.conversationId)).toEqual(Uint8Array.from([7]))
    expect(await hostNoteAfterRestart(root, "ses_injected")).toBeUndefined()
  })

  it("keeps a note Cursor did not deliver for the next user turn, with the turn's checkpoint", async () => {
    const outcomes: Record<string, unknown> = {}
    for (const state of ["rejected", "queued_for_next_turn", "cancelled", "unanswered"]) {
      const dir = fs.mkdtempSync(path.join("/tmp", "cursor-host-notes-"))
      try {
        const writes: Uint8Array[] = []
        const live = heldRun(writes)
        noFollowUp(live)
        deliverContinuationResults(live, extractTrailingToolResults(step(readResult(live, 1), hostNote(NOTE))))
        const id = injectedNotes(writes)[0].injection_id
        const answer = state === "unanswered" ? [] : [injectionStateFrame(id, { [state]: {} })]

        await pump(endsTurn(live, dir, `ses_${state}`, answer), controller, { textId: "t", reasoningId: "r" })

        outcomes[state] = {
          checkpoint: getCheckpoint(live.conversationId),
          note: await hostNoteAfterRestart(dir, `ses_${state}`),
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    }

    for (const outcome of Object.values(outcomes)) {
      expect(outcome).toEqual({ checkpoint: Uint8Array.from([7]), note: NOTE })
    }
    expect(Object.keys(outcomes)).toHaveLength(4)
  })

  it("sends a note the resumed checkpoint may not hold with the resumed Run's next results", async () => {
    root = fs.mkdtempSync(path.join("/tmp", "cursor-host-notes-"))
    const live = heldRun([])
    live.resumeCheckpoint = new Uint8Array([1])
    live.steerInjections = [
      { id: "held", text: LATER_NOTE, state: "delivered", checkpointed: true, hostNote: true },
      { id: "unheld", text: NOTE, state: "queued", hostNote: true },
    ]

    await pumpWithRecovery({
      initialSession: live,
      controller,
      recover: async () => {
        const resumed = endsTurn(heldRun([]), root!, "ses_resumed_injection")
        noFollowUp(resumed)
        return resumed
      },
    })

    expect(await hostNoteAfterRestart(root, "ses_resumed_injection")).toBe(NOTE)
  })

  it("keeps only an undelivered note when a fresh turn drains the prior Run", async () => {
    const outcomes: Record<string, unknown> = {}
    for (const state of ["delivered", "rejected"]) {
      const dir = fs.mkdtempSync(path.join("/tmp", "cursor-host-notes-"))
      try {
        const live = endsTurn(heldRun([]), dir, `ses_drained_${state}`, [injectionStateFrame("note-1", { [state]: {} })])
        live.steerInjections = [{ id: "note-1", text: NOTE, state: "sent", hostNote: true }]
        sessionManager.registerSession(live)

        expect(await preparePriorSessionForFreshTurn(`ses_drained_${state}`, { timeoutMs: 1_000 })).toBe("drained")
        outcomes[state] = await hostNoteAfterRestart(dir, `ses_drained_${state}`)
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    }

    expect(outcomes).toEqual({ delivered: undefined, rejected: NOTE })
  })
})
