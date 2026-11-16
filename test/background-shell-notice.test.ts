import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createManagedTerminal, type ManagedTerminal } from "../src/terminal-runner.js"
import { runtimeLayout } from "../src/runtime-files.js"
import {
  CURSOR_TIMEOUT_BACKGROUND,
  captureCursorShellResult,
  capturedCursorShellOutcome,
  registerCursorShellCall,
  resetCursorShellCalls,
  type CursorShellPolicy,
} from "../src/shell-timeout.js"
import {
  AWAIT_GRACE_MS,
  BUSY_SETTLE_MS,
  KILL_SETTLE_MS,
  MAX_HOLD_MS,
  RUNNER_GONE_GRACE_MS,
  STOPPED_HOLD_MS,
  TARGETED_STOP_MS,
  backgroundShellNoticesSupported,
  forgetBackgroundShells,
  noteAgentShellCommand,
  noteAgentShellCommandEnded,
  noteSessionExecution,
  parseKillCommand,
  pollBackgroundShells,
  recordBackgroundShellRead,
  registerBackgroundShellNotifier,
  resetBackgroundShellNotices,
  watchBackgroundShell,
  type BackgroundShellNote,
} from "../src/background-shell-notice.js"

const SHELL_ID = 4242
const LIVE_PID = process.pid
// Above Linux's pid_max and macOS's pid range, so never a live process.
const GONE_PID = 2_000_000_000

let dir: string
let notes: BackgroundShellNote[]
const notifier = async (note: BackgroundShellNote) => {
  notes.push(note)
}

type RecordFields = {
  status?: string
  output?: string
  exitCode?: number | "unknown"
  elapsedMs?: number
  storageFailed?: boolean
  footer?: boolean
  after?: string
}

// The supervisor's record: a fixed-width header, the output, then the completion footer.
function terminalFile(pid: number, input: RecordFields = {}): string {
  const file = join(dir, `${SHELL_ID}.txt`)
  const status = input.status ?? "running"
  const header = [
    "---",
    `pid: ${pid}`,
    'cwd: "/work"',
    'command: "sleep 90; echo done"',
    `status: ${status.padEnd(9)}`,
    "started_at: 2026-10-07T10:00:00Z",
    `running_for_ms: ${"0".padEnd(15)}`,
    "---",
    "",
  ].join("\n")
  const lost = input.exitCode === "unknown"
  const footer = status === "running" || input.footer === false
    ? ""
    : `\n---\nexit_code: ${input.exitCode ?? 0}\n`
      + (lost ? "" : `elapsed_ms: ${input.elapsedMs ?? 90_000}\n`)
      + "ended_at: 2026-10-07T10:01:30Z\n"
      + (input.storageFailed ? "output_storage_failed: true\n" : "")
      + "---\n"
  writeFileSync(file, header + (input.output ?? "") + footer + (input.after ?? ""))
  return file
}

function watch(pid: number, file: string, now = 0, sessionID = "ses_a") {
  watchBackgroundShell({ sessionID, shellId: SHELL_ID, pid, file, command: "sleep 90; echo done", notifier, now })
}

beforeEach(() => {
  resetBackgroundShellNotices({ manualPolling: true })
  dir = mkdtempSync(join(tmpdir(), "cursor-bg-notice-"))
  notes = []
  registerBackgroundShellNotifier(notifier)
})

afterEach(() => {
  resetBackgroundShellNotices()
  rmSync(dir, { recursive: true, force: true })
})

describe("background shell notices", () => {
  test("posts OpenCode's shell note once the supervisor finishes the record", async () => {
    const file = terminalFile(LIVE_PID)
    watch(LIVE_PID, file)
    noteSessionExecution("ses_a", "succeeded")
    pollBackgroundShells(1000)
    expect(notes).toEqual([])

    terminalFile(LIVE_PID, { status: "succeeded", output: "step 1\ndone\n" })
    pollBackgroundShells(2000)
    await Promise.resolve()
    expect(notes).toHaveLength(1)
    const [note] = notes
    expect(note!.sessionID).toBe("ses_a")
    expect(note!.resume).toBeUndefined()
    expect(note!.description).toBe("sleep 90; echo done")
    expect(note!.metadata).toEqual({ source: "shell", shellID: String(SHELL_ID), state: "completed", exit: 0, file })
    expect(note!.text).toBe([
      "<system-update>",
      `<shell id="${SHELL_ID}" state="completed" command="sleep 90; echo done">`,
      `Background shell ${SHELL_ID} finished with exit code 0 after 1m 30s.`,
      `Its output (also in ${file}):`,
      "step 1",
      "done",
      "</shell>",
      "</system-update>",
    ].join("\n"))
    pollBackgroundShells(3000)
    expect(notes).toHaveLength(1)
  })

  test("only watches a record named after its shell id", () => {
    const file = join(dir, `${LIVE_PID}.txt`)
    writeFileSync(file, "")
    watchBackgroundShell({ sessionID: "ses_a", shellId: SHELL_ID, pid: LIVE_PID, file, command: "x", notifier, now: 0 })
    noteSessionExecution("ses_a", "succeeded")
    pollBackgroundShells(MAX_HOLD_MS * 2)
    expect(notes).toEqual([])
  })

  test("reports a failing command's exit code and a stopped one as cancelled", () => {
    const failed = terminalFile(LIVE_PID, { status: "failed", exitCode: 3, elapsedMs: 4200, output: "boom\n" })
    watch(LIVE_PID, failed)
    noteSessionExecution("ses_a", "succeeded")
    pollBackgroundShells(1000)
    expect(notes[0]!.text).toContain(`Background shell ${SHELL_ID} failed with exit code 3 after 4s.`)
    expect(notes[0]!.metadata.exit).toBe(3)

    const aborted = terminalFile(LIVE_PID, { status: "aborted", exitCode: 143, elapsedMs: 12_000 })
    watch(LIVE_PID, aborted)
    noteSessionExecution("ses_a", "succeeded")
    pollBackgroundShells(2000)
    expect(notes[1]!.text).toContain(`state="cancelled"`)
    expect(notes[1]!.text).toContain(`Background shell ${SHELL_ID} was stopped after 12s (exit code 143).`)
    expect(notes[1]!.text).toContain(`It printed no output. Output file: ${aborted}`)
  })

  test("waits for the footer the supervisor writes after the final status", () => {
    const file = terminalFile(LIVE_PID, { status: "failed", output: "boom\n", footer: false })
    watch(LIVE_PID, file)
    noteSessionExecution("ses_a", "succeeded")
    pollBackgroundShells(1000)
    expect(notes).toEqual([])
    terminalFile(LIVE_PID, { status: "failed", exitCode: 2, output: "boom\n" })
    pollBackgroundShells(2000)
    expect(notes[0]!.text).toContain(`failed with exit code 2 after 1m 30s.`)
  })

  test("takes a final status without a footer once the supervisor is gone", () => {
    const file = terminalFile(GONE_PID, { status: "failed", output: "boom\n", footer: false })
    watch(GONE_PID, file)
    noteSessionExecution("ses_a", "succeeded")
    pollBackgroundShells(1000)
    expect(notes[0]!.text).toContain(`Background shell ${SHELL_ID} has failed after`)
    expect(notes[0]!.metadata.exit).toBeUndefined()
  })

  test("reports a record finalized for a lost supervisor as an error without an exit code", () => {
    const output = "partial\n\n[Terminal supervisor stopped before the command finished; its exit status is unknown.]\n"
    const file = terminalFile(GONE_PID, { status: "aborted", exitCode: "unknown", output })
    watch(GONE_PID, file)
    noteSessionExecution("ses_a", "succeeded")
    pollBackgroundShells(1000)
    expect(notes).toHaveLength(1)
    expect(notes[0]!.text).toContain(`state="error"`)
    expect(notes[0]!.text).toContain(`Background shell ${SHELL_ID} ended without reporting an exit code`)
    expect(notes[0]!.text).toContain("partial\n")
    expect(notes[0]!.text).not.toContain("exit_code")
    expect(notes[0]!.metadata.exit).toBeUndefined()
  })

  test("says when the record's output could not be stored completely", () => {
    const file = terminalFile(LIVE_PID, { status: "aborted", exitCode: 1, storageFailed: true, output: "some\n" })
    watch(LIVE_PID, file)
    noteSessionExecution("ses_a", "succeeded")
    pollBackgroundShells(1000)
    expect(notes[0]!.text).toContain(`(exit code 1).\nIts output could not be stored completely.\nIts output (also in ${file}):\nsome\n</shell>`)
    expect(notes[0]!.text).not.toContain("output_storage_failed")
  })

  test("drops the note when the session read the finished record", () => {
    const file = terminalFile(LIVE_PID, { status: "succeeded" })
    watch(LIVE_PID, file)
    expect(recordBackgroundShellRead(file, "ses_other", { now: 500 })).toBe(false)
    // Only the read that replaces the note says so: a history rebuild would lose it.
    expect(recordBackgroundShellRead(file, "ses_a", { now: 500 })).toBe(true)
    expect(recordBackgroundShellRead(file, "ses_a", { now: 600 })).toBe(false)
    noteSessionExecution("ses_a", "succeeded")
    pollBackgroundShells(MAX_HOLD_MS * 2)
    expect(notes).toEqual([])
    pollBackgroundShells(MAX_HOLD_MS * 3)
    expect(notes).toEqual([])
  })

  test("a ranged read stands in for the note only when it shows the status line or the exit footer", () => {
    // Lines 1-8 header (status on 5), 9-38 output, 41 exit_code.
    const output = Array.from({ length: 30 }, (_, i) => `l${i + 1}`).join("\n") + "\n"
    const file = terminalFile(LIVE_PID, { status: "succeeded", output })
    const cases: Array<[{ offset?: number; limit?: number }, boolean]> = [
      [{ offset: 20, limit: 5 }, false],
      [{ offset: 30 }, true],
      [{ offset: 1, limit: 6 }, true],
      [{ offset: 5, limit: 1 }, true],
      [{ offset: 6, limit: 10 }, false],
      [{ offset: 41, limit: 1 }, true],
      [{ offset: 60 }, false],
      [{ limit: 3 }, false],
    ]
    for (const [range, shown] of cases) {
      notes.length = 0
      watch(LIVE_PID, file)
      noteSessionExecution("ses_a", "succeeded")
      const endRead = recordBackgroundShellRead(file, "ses_a", { ...range, now: 0 })
      pollBackgroundShells(AWAIT_GRACE_MS)
      expect({ range, notes: notes.length, endRead }).toEqual({ range, notes: shown ? 0 : 1, endRead: shown })
    }
  })

  test("finds the exit footer for a ranged read when a descendant wrote after it", () => {
    // Lines 1-8 header, 9-38 output, 41 exit_code, 45 "late".
    const output = Array.from({ length: 30 }, (_, i) => `l${i + 1}`).join("\n") + "\n"
    const file = terminalFile(LIVE_PID, { status: "succeeded", output, after: "late\n" })
    const cases: Array<[{ offset?: number; limit?: number }, boolean]> = [
      [{ offset: 41, limit: 1 }, true],
      [{ offset: 42, limit: 1 }, false],
      [{ offset: 45 }, false],
      [{ offset: 39 }, true],
    ]
    for (const [range, shown] of cases) {
      notes.length = 0
      watch(LIVE_PID, file)
      noteSessionExecution("ses_a", "succeeded")
      recordBackgroundShellRead(file, "ses_a", { ...range, now: 0 })
      pollBackgroundShells(AWAIT_GRACE_MS)
      expect({ range, notes: notes.length }).toEqual({ range, notes: shown ? 0 : 1 })
    }
  })

  test("keeps output a descendant wrote after the exit footer", () => {
    const file = terminalFile(LIVE_PID, { status: "succeeded", output: "early\n", after: "late\n" })
    watch(LIVE_PID, file)
    noteSessionExecution("ses_a", "succeeded")
    pollBackgroundShells(1000)
    expect(notes[0]!.text).toContain(`finished with exit code 0 after 1m 30s.\nIts output (also in ${file}):\nearly\nlate\n</shell>`)
  })

  test("finds the exit code behind a lot of output written after the footer", () => {
    const after = "x".repeat(99) + "\n"
    const file = terminalFile(LIVE_PID, { status: "failed", exitCode: 5, output: "start\n", after: after.repeat(2000) })
    watch(LIVE_PID, file)
    noteSessionExecution("ses_a", "succeeded")
    pollBackgroundShells(1000)
    expect(notes[0]!.text).toContain(`failed with exit code 5 after 1m 30s.\nLast 20 lines of its output`)
  })

  test("another session's read neither drops nor holds the note", () => {
    const file = terminalFile(LIVE_PID, { status: "succeeded" })
    watch(LIVE_PID, file)
    noteSessionExecution("ses_a", "succeeded")
    recordBackgroundShellRead(file, "ses_other", { now: 1000 })
    pollBackgroundShells(1000)
    expect(notes).toHaveLength(1)
  })

  test("waits while the record is being read, then posts when no read saw the end", () => {
    const file = terminalFile(LIVE_PID)
    watch(LIVE_PID, file)
    noteSessionExecution("ses_a", "succeeded")
    recordBackgroundShellRead(file, "ses_a", { now: 1000 })
    terminalFile(LIVE_PID, { status: "succeeded" })
    pollBackgroundShells(1000 + AWAIT_GRACE_MS - 1)
    expect(notes).toEqual([])
    pollBackgroundShells(1000 + AWAIT_GRACE_MS)
    expect(notes).toHaveLength(1)
  })

  test("a read that starts on the finished record during the wait drops the note", () => {
    const file = terminalFile(LIVE_PID)
    watch(LIVE_PID, file)
    noteSessionExecution("ses_a", "succeeded")
    recordBackgroundShellRead(file, "ses_a", { now: 1000 })
    terminalFile(LIVE_PID, { status: "succeeded" })
    pollBackgroundShells(1500)
    recordBackgroundShellRead(file, "ses_a", { now: 1600 })
    pollBackgroundShells(10_000)
    expect(notes).toEqual([])
  })

  test("reads that never show the end hold the note no longer than the cap", () => {
    const output = Array.from({ length: 30 }, (_, i) => `l${i + 1}`).join("\n") + "\n"
    const file = terminalFile(LIVE_PID, { status: "succeeded", output })
    watch(LIVE_PID, file)
    noteSessionExecution("ses_a", "succeeded")
    for (let t = 1000; t < 1000 + MAX_HOLD_MS; t += 1000) {
      recordBackgroundShellRead(file, "ses_a", { offset: 10, limit: 1, now: t })
      pollBackgroundShells(t)
    }
    expect(notes).toEqual([])
    recordBackgroundShellRead(file, "ses_a", { offset: 10, limit: 1, now: 1000 + MAX_HOLD_MS })
    pollBackgroundShells(1000 + MAX_HOLD_MS)
    expect(notes).toHaveLength(1)
  })

  test("mid-turn, a note waits for the model to await a command that ended quickly", () => {
    const file = terminalFile(LIVE_PID, { status: "succeeded" })
    watch(LIVE_PID, file)
    pollBackgroundShells(1000)
    pollBackgroundShells(1000 + BUSY_SETTLE_MS - 1)
    expect(notes).toEqual([])
    pollBackgroundShells(1000 + BUSY_SETTLE_MS)
    expect(notes).toHaveLength(1)
    expect(notes[0]!.resume).toBeUndefined()
  })

  test("a note held over a turn the user stopped waits for their next message", () => {
    const file = terminalFile(LIVE_PID, { status: "succeeded" })
    watch(LIVE_PID, file)
    pollBackgroundShells(1000)
    expect(notes).toEqual([])
    noteSessionExecution("ses_a", "interrupted")
    pollBackgroundShells(1500)
    expect(notes).toHaveLength(1)
    expect(notes[0]!.resume).toBe(false)
  })

  test("execution events count only for a session with a watched shell", () => {
    noteSessionExecution("ses_a", "interrupted")
    const file = terminalFile(LIVE_PID, { status: "succeeded" })
    watch(LIVE_PID, file)
    pollBackgroundShells(1000)
    expect(notes).toEqual([])
    pollBackgroundShells(1000 + BUSY_SETTLE_MS)
    expect(notes).toHaveLength(1)
    expect(notes[0]!.resume).toBeUndefined()

    noteSessionExecution("ses_a", "interrupted")
    watch(LIVE_PID, file, 2000)
    pollBackgroundShells(3000)
    expect(notes).toHaveLength(1)
  })

  test("a turn ending lets a held note go at once", () => {
    const file = terminalFile(LIVE_PID, { status: "succeeded" })
    watch(LIVE_PID, file)
    pollBackgroundShells(1000)
    noteSessionExecution("ses_a", "succeeded")
    pollBackgroundShells(1500)
    expect(notes).toHaveLength(1)
    expect(notes[0]!.resume).toBeUndefined()
  })

  test("a supervisor gone without finishing its record is reported after a grace period", () => {
    const file = terminalFile(GONE_PID, { output: "partial\n" })
    watch(GONE_PID, file)
    noteSessionExecution("ses_a", "succeeded")
    pollBackgroundShells(1000)
    pollBackgroundShells(1000 + RUNNER_GONE_GRACE_MS - 1)
    expect(notes).toEqual([])
    pollBackgroundShells(1000 + RUNNER_GONE_GRACE_MS)
    expect(notes).toHaveLength(1)
    expect(notes[0]!.text).toContain(`state="error"`)
    expect(notes[0]!.text).toContain("ended without reporting an exit code")
    expect(notes[0]!.text).toContain("partial")
  })

  test("keeps the last lines of long output", () => {
    const output = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n") + "\n"
    const file = terminalFile(LIVE_PID, { status: "succeeded", output })
    watch(LIVE_PID, file)
    noteSessionExecution("ses_a", "succeeded")
    pollBackgroundShells(1000)
    const text = notes[0]!.text
    expect(text).toContain(`Last 20 lines of its output (full output in ${file}):`)
    expect(text).toContain("line 81\n")
    expect(text).toContain("line 100\n</shell>")
    expect(text).not.toContain("line 80\n")
  })

  test("escapes the command attribute", () => {
    const file = terminalFile(LIVE_PID, { status: "succeeded" })
    watchBackgroundShell({ sessionID: "ses_a", shellId: SHELL_ID, pid: LIVE_PID, file, command: 'echo "a" <b>\nnext & more', notifier, now: 0 })
    noteSessionExecution("ses_a", "succeeded")
    pollBackgroundShells(1000)
    expect(notes[0]!.text).toContain('command="echo &quot;a&quot; &lt;b>&#10;next &amp; more">')
  })

  test("posts through another live notifier once the registering setup is gone", () => {
    resetBackgroundShellNotices({ manualPolling: true })
    const first: BackgroundShellNote[] = []
    const second: BackgroundShellNote[] = []
    const disposeFirst = registerBackgroundShellNotifier(async (note) => void first.push(note))
    const file = terminalFile(LIVE_PID, { status: "succeeded" })
    watchBackgroundShell({ sessionID: "ses_a", shellId: SHELL_ID, pid: LIVE_PID, file, command: "x", notifier: async (note) => void first.push(note), now: 0 })
    disposeFirst()
    noteSessionExecution("ses_a", "succeeded")
    pollBackgroundShells(1000)
    expect(first).toEqual([])
    registerBackgroundShellNotifier(async (note) => void second.push(note))
    pollBackgroundShells(2000)
    expect(second).toHaveLength(1)
    expect(backgroundShellNoticesSupported()).toBe(true)
  })

  test("forgets a deleted session's shells", () => {
    const file = terminalFile(LIVE_PID, { status: "succeeded" })
    watch(LIVE_PID, file)
    forgetBackgroundShells("ses_a")
    pollBackgroundShells(MAX_HOLD_MS)
    expect(notes).toEqual([])
  })

  test("a failed post is not retried", async () => {
    resetBackgroundShellNotices({ manualPolling: true })
    let calls = 0
    const failing = async () => {
      calls++
      throw new Error("session not found")
    }
    registerBackgroundShellNotifier(failing)
    const file = terminalFile(LIVE_PID, { status: "succeeded" })
    watchBackgroundShell({ sessionID: "ses_a", shellId: SHELL_ID, pid: LIVE_PID, file, command: "x", notifier: failing, now: 0 })
    noteSessionExecution("ses_a", "succeeded")
    pollBackgroundShells(1000)
    await Promise.resolve()
    pollBackgroundShells(2000)
    expect(calls).toBe(1)
  })
})

describe("shells the agent stopped itself", () => {
  const children: Array<{ kill: () => void }> = []
  afterEach(() => {
    for (const child of children.splice(0)) child.kill()
  })

  // A process under the watched supervisor (this test process stands in for it).
  function payload(): number {
    const child = Bun.spawn(["sleep", "30"])
    children.push(child)
    return child.pid
  }

  test("recognizes kill commands and the pids they name", () => {
    expect(parseKillCommand("kill 1815815 1815829")).toEqual({ pids: [1815815, 1815829] })
    expect(parseKillCommand("kill -9 4242; sleep 1; ss -ltn")).toEqual({ pids: [4242] })
    expect(parseKillCommand("kill -s TERM 4242")).toEqual({ pids: [4242] })
    expect(parseKillCommand("kill -TERM -- -4242")).toEqual({ pids: [4242] })
    expect(parseKillCommand("kill -TERM -4242")).toEqual({ pids: [4242] })
    expect(parseKillCommand("cd /w && sudo kill \"4242\" || true")).toEqual({ pids: [4242] })
    expect(parseKillCommand("kill $(cat server.pid)")).toEqual({ pids: [] })
    expect(parseKillCommand("kill \"$SERVER_PID\"")).toEqual({ pids: [] })
    expect(parseKillCommand("fuser -k 8000/tcp")).toEqual({ pids: [] })
    expect(parseKillCommand("pkill -f 'uvicorn app'")).toEqual({ pids: [] })
    expect(parseKillCommand("fuser 8000/tcp")).toBeUndefined()
    expect(parseKillCommand("echo kill 4242")).toBeUndefined()
    expect(parseKillCommand("git commit -m 'kill the server'")).toBeUndefined()
    expect(parseKillCommand("touch demo.stop")).toBeUndefined()
  })

  test.skipIf(process.platform !== "linux")("a shell whose process the agent killed by pid waits out the turn and starts none", () => {
    const file = terminalFile(LIVE_PID)
    watch(LIVE_PID, file)
    noteAgentShellCommand("ses_a", "call_kill", `kill ${payload()}`, 1000)
    noteAgentShellCommandEnded("call_kill", 1100)
    terminalFile(LIVE_PID, { status: "succeeded", exitCode: 0 })
    pollBackgroundShells(3000)
    pollBackgroundShells(3000 + MAX_HOLD_MS)
    expect(notes).toEqual([])
    noteSessionExecution("ses_a", "succeeded")
    pollBackgroundShells(3000 + MAX_HOLD_MS + 500)
    expect(notes).toHaveLength(1)
    expect(notes[0]!.resume).toBe(false)
  })

  test.skipIf(process.platform !== "linux")("a kill that names another process leaves the note as it was", () => {
    const file = terminalFile(LIVE_PID)
    watch(LIVE_PID, file)
    noteAgentShellCommand("ses_a", "call_kill", "kill 1", 1000)
    noteAgentShellCommandEnded("call_kill", 1100)
    terminalFile(LIVE_PID, { status: "succeeded", exitCode: 0 })
    noteSessionExecution("ses_a", "succeeded")
    pollBackgroundShells(2000)
    expect(notes).toHaveLength(1)
    expect(notes[0]!.resume).toBeUndefined()
  })

  test.skipIf(process.platform !== "linux")("a shell that ends long after the kill named it is reported as usual", () => {
    const file = terminalFile(LIVE_PID)
    watch(LIVE_PID, file)
    noteAgentShellCommand("ses_a", "call_kill", `kill ${payload()}`, 1000)
    noteAgentShellCommandEnded("call_kill", 1100)
    noteSessionExecution("ses_a", "succeeded")
    terminalFile(LIVE_PID, { status: "failed", exitCode: 1 })
    pollBackgroundShells(1000 + TARGETED_STOP_MS + 1)
    expect(notes).toHaveLength(1)
    expect(notes[0]!.resume).toBeUndefined()
  })

  test("a death by signal right after a kill without pids is the agent's stop", () => {
    const file = terminalFile(LIVE_PID)
    watch(LIVE_PID, file)
    noteAgentShellCommand("ses_a", "call_kill", "fuser -k 8000/tcp", 1000)
    terminalFile(LIVE_PID, { status: "failed", exitCode: 137 })
    pollBackgroundShells(1500)
    noteAgentShellCommandEnded("call_kill", 1600)
    noteSessionExecution("ses_a", "succeeded")
    pollBackgroundShells(2000)
    expect(notes).toHaveLength(1)
    expect(notes[0]!.resume).toBe(false)
  })

  test("without pids, a normal exit or a signal well after the kill still starts a turn", () => {
    for (const [exitCode, seen] of [[0, 1500], [143, 1100 + KILL_SETTLE_MS + 1000]] as const) {
      notes.length = 0
      const file = terminalFile(LIVE_PID)
      watch(LIVE_PID, file)
      noteAgentShellCommand("ses_a", "call_kill", "pkill -f server", 1000)
      noteAgentShellCommandEnded("call_kill", 1100)
      noteSessionExecution("ses_a", "succeeded")
      terminalFile(LIVE_PID, { status: exitCode === 0 ? "succeeded" : "failed", exitCode })
      pollBackgroundShells(seen)
      expect({ exitCode, resume: notes[0]?.resume, count: notes.length }).toEqual({ exitCode, resume: undefined, count: 1 })
    }
  })

  test("another session's kill does not count", () => {
    const file = terminalFile(LIVE_PID)
    watch(LIVE_PID, file)
    noteAgentShellCommand("ses_other", "call_kill", "pkill -f server", 1000)
    terminalFile(LIVE_PID, { status: "failed", exitCode: 143 })
    noteSessionExecution("ses_a", "succeeded")
    pollBackgroundShells(1500)
    expect(notes).toHaveLength(1)
    expect(notes[0]!.resume).toBeUndefined()
  })

  test("a stopped shell's note goes without a turn once held for the cap", () => {
    const file = terminalFile(LIVE_PID)
    watch(LIVE_PID, file)
    noteAgentShellCommand("ses_a", "call_kill", "pkill -f server", 1000)
    terminalFile(LIVE_PID, { status: "failed", exitCode: 143 })
    pollBackgroundShells(1500)
    pollBackgroundShells(1500 + STOPPED_HOLD_MS - 1)
    expect(notes).toEqual([])
    pollBackgroundShells(1500 + STOPPED_HOLD_MS)
    expect(notes).toHaveLength(1)
    expect(notes[0]!.resume).toBe(false)
  })

  test("reading the stopped shell's end still drops its note", () => {
    const file = terminalFile(LIVE_PID)
    watch(LIVE_PID, file)
    noteAgentShellCommand("ses_a", "call_kill", "pkill -f server", 1000)
    terminalFile(LIVE_PID, { status: "failed", exitCode: 143 })
    pollBackgroundShells(1500)
    expect(recordBackgroundShellRead(file, "ses_a", { now: 1600 })).toBe(true)
    noteSessionExecution("ses_a", "succeeded")
    pollBackgroundShells(5000)
    expect(notes).toEqual([])
  })
})

describe("completion notes from supervised terminal records", () => {
  const jobs: ManagedTerminal[] = []
  afterEach(async () => {
    for (const job of jobs.splice(0)) {
      if (existsSync(join(job.directory, "done"))) continue
      try { process.kill(Number(readFileSync(join(job.directory, "ready"), "utf8")), "SIGTERM") } catch { /* stopped */ }
    }
    resetCursorShellCalls()
  })

  async function run(callID: string, policy: CursorShellPolicy, metadata: Record<string, unknown>) {
    runtimeLayout(dir, true)
    const terminal = createManagedTerminal(policy, dir)
    jobs.push(terminal)
    registerCursorShellCall(callID, { ...metadata, managed_command: terminal.command, managed_job_directory: terminal.directory })
    const proc = Bun.spawn(["/bin/sh", "-c", terminal.command], { stdout: "pipe", stderr: "pipe" })
    const stdout = await new Response(proc.stdout).text()
    await proc.exited
    captureCursorShellResult(callID, stdout)
    const outcome = capturedCursorShellOutcome(callID)
    if (outcome?.kind !== "backgrounded" || !outcome.outputFile) throw new Error(`not backgrounded: ${stdout}`)
    watchBackgroundShell({ sessionID: "ses_run", shellId: outcome.shellId, pid: outcome.pid, file: outcome.outputFile, command: outcome.command, notifier })
    noteSessionExecution("ses_run", "succeeded")
    return { terminal, outcome }
  }

  async function noteWithin(ms: number): Promise<BackgroundShellNote | undefined> {
    const end = Date.now() + ms
    while (notes.length === 0 && Date.now() < end) {
      pollBackgroundShells()
      await Bun.sleep(50)
    }
    return notes[0]
  }

  test("reports a background spawn's exit code and output", async () => {
    const command = "sleep 0.3; printf 'a\\nb\\n'; exit 3"
    const { terminal, outcome } = await run("cursor_note_spawn", {
      command, workingDirectory: dir, timeoutMs: 0, timeoutBehavior: 0, backgroundSpawn: true,
    }, { background_shell_spawn: true, command, working_directory: dir })
    expect(outcome.outputFile).toBe(terminal.file)
    const note = await noteWithin(8000)
    expect(note?.text).toContain(`<shell id="${terminal.shellId}" state="completed" command="sleep 0.3; printf 'a\\nb\\n'; exit 3">`)
    expect(note?.text).toMatch(new RegExp(`Background shell ${terminal.shellId} failed with exit code 3 after \\d+s\\.\\nIts output \\(also in [^)]+\\):\\na\\nb\\n</shell>`))
    expect(note?.metadata.exit).toBe(3)
  }, 15_000)

  test("reports a soft-background command once it ends after its window", async () => {
    const command = "printf 'start\\n'; sleep 1.2; printf 'end\\n'"
    const { terminal } = await run("cursor_note_soft", {
      command, workingDirectory: dir, timeoutMs: 300, timeoutBehavior: CURSOR_TIMEOUT_BACKGROUND,
    }, { shell_stream: true, command, working_directory: dir, timeout_ms: 300, timeout_behavior: CURSOR_TIMEOUT_BACKGROUND })
    const note = await noteWithin(8000)
    expect(note?.text).toContain(`Background shell ${terminal.shellId} finished with exit code 0 after`)
    expect(note?.text).toContain("start\nend\n</shell>")
  }, 15_000)

  test("reports a command stopped through its supervisor as cancelled", async () => {
    const command = "printf 'start\\n'; sleep 30"
    const { terminal, outcome } = await run("cursor_note_stop", {
      command, workingDirectory: dir, timeoutMs: 0, timeoutBehavior: 0, backgroundSpawn: true,
    }, { background_shell_spawn: true, command, working_directory: dir })
    await Bun.sleep(300)
    process.kill(outcome.pid, "SIGTERM")
    const note = await noteWithin(8000)
    expect(note?.text).toContain(`state="cancelled"`)
    expect(note?.text).toContain(`Background shell ${terminal.shellId} was stopped after`)
    expect(note?.text).toContain("(exit code 143)")
  }, 15_000)

  test.skipIf(process.platform !== "linux")("a command the agent kills by pid is reported without starting a turn", async () => {
    const pidFile = join(dir, "server.pid")
    const command = `echo $$ > '${pidFile}'; exec sleep 30`
    await run("cursor_note_killed", {
      command, workingDirectory: dir, timeoutMs: 0, timeoutBehavior: 0, backgroundSpawn: true,
    }, { background_shell_spawn: true, command, working_directory: dir })
    const deadline = Date.now() + 5000
    while (!existsSync(pidFile) && Date.now() < deadline) await Bun.sleep(20)
    const pid = Number(readFileSync(pidFile, "utf8"))
    noteAgentShellCommand("ses_run", "call_kill", `kill ${pid}`)
    process.kill(pid, "SIGTERM")
    noteAgentShellCommandEnded("call_kill")
    const note = await noteWithin(8000)
    expect(note?.text).toContain("failed with exit code 143")
    expect(note?.resume).toBe(false)
  }, 15_000)

  test("reports a killed supervisor's command as ended without an exit code", async () => {
    const command = "printf 'start\\n'; sleep 30"
    const { outcome } = await run("cursor_note_lost", {
      command, workingDirectory: dir, timeoutMs: 0, timeoutBehavior: 0, backgroundSpawn: true,
    }, { background_shell_spawn: true, command, working_directory: dir })
    await Bun.sleep(300)
    process.kill(outcome.pid, "SIGKILL")
    const note = await noteWithin(RUNNER_GONE_GRACE_MS + 6000)
    expect(note?.text).toContain(`state="error"`)
    expect(note?.text).toContain("ended without reporting an exit code")
    expect(note?.text).toContain("start")
  }, 20_000)
})
