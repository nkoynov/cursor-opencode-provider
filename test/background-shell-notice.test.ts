import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  AWAIT_GRACE_MS,
  BUSY_SETTLE_MS,
  MAX_HOLD_MS,
  RUNNER_GONE_GRACE_MS,
  backgroundShellNoticesSupported,
  forgetBackgroundShells,
  noteSessionExecution,
  pollBackgroundShells,
  recordBackgroundShellRead,
  registerBackgroundShellNotifier,
  resetBackgroundShellNotices,
  watchBackgroundShell,
  type BackgroundShellNote,
} from "../src/background-shell-notice.js"

const LIVE_PID = process.pid
// Above Linux's pid_max and macOS's pid range, so never a live process.
const GONE_PID = 2_000_000_000

let dir: string
let notes: BackgroundShellNote[]
const notifier = async (note: BackgroundShellNote) => {
  notes.push(note)
}

function terminalFile(pid: number, input: { status?: string; output?: string; exitCode?: number; elapsedMs?: number; after?: string } = {}): string {
  const file = join(dir, `${pid}.txt`)
  const status = input.status ?? "running"
  const header = [
    "---",
    `pid: ${pid}`,
    'cwd: "/work"',
    'command: "sleep 90; echo done"',
    `status: ${status.padEnd(9)}`,
    "started_at: 2026-10-07T10:00:00Z",
    "running_for_ms: 0        ",
    "---",
    "",
  ].join("\n")
  const footer = status === "running"
    ? ""
    : `\n---\nexit_code: ${input.exitCode ?? 0}\nelapsed_ms: ${input.elapsedMs ?? 90_000}\nended_at: 2026-10-07T10:01:30Z\n---\n`
  writeFileSync(file, header + (input.output ?? "") + footer + (input.after ?? ""))
  return file
}

function watch(pid: number, file: string, now = 0, sessionID = "ses_a") {
  watchBackgroundShell({ sessionID, pid, file, command: "sleep 90; echo done", notifier, now })
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
  test("posts OpenCode's shell note once the runner finishes the terminal file", async () => {
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
    expect(note!.metadata).toEqual({ source: "shell", shellID: String(LIVE_PID), state: "completed", exit: 0, file })
    expect(note!.text).toBe([
      "<system-update>",
      `<shell id="${LIVE_PID}" state="completed" command="sleep 90; echo done">`,
      `Background shell ${LIVE_PID} finished with exit code 0 after 1m 30s.`,
      `Its output (also in ${file}):`,
      "step 1",
      "done",
      "</shell>",
      "</system-update>",
    ].join("\n"))
    pollBackgroundShells(3000)
    expect(notes).toHaveLength(1)
  })

  test("reports a failing command's exit code and a stopped one as cancelled", () => {
    const failed = terminalFile(LIVE_PID, { status: "failed", exitCode: 3, elapsedMs: 4200, output: "boom\n" })
    watch(LIVE_PID, failed)
    noteSessionExecution("ses_a", "succeeded")
    pollBackgroundShells(1000)
    expect(notes[0]!.text).toContain(`Background shell ${LIVE_PID} failed with exit code 3 after 4s.`)
    expect(notes[0]!.metadata.exit).toBe(3)

    const aborted = terminalFile(LIVE_PID, { status: "aborted", exitCode: 143, elapsedMs: 12_000 })
    watch(LIVE_PID, aborted)
    noteSessionExecution("ses_a", "succeeded")
    pollBackgroundShells(2000)
    expect(notes[1]!.text).toContain(`state="cancelled"`)
    expect(notes[1]!.text).toContain(`Background shell ${LIVE_PID} was stopped after 12s (exit code 143).`)
    expect(notes[1]!.text).toContain(`It printed no output. Output file: ${aborted}`)
  })

  test("drops the note when the session read the finished terminal file", () => {
    const file = terminalFile(LIVE_PID, { status: "succeeded" })
    watch(LIVE_PID, file)
    recordBackgroundShellRead(file, "ses_other", { now: 500 })
    recordBackgroundShellRead(file, "ses_a", { now: 500 })
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
      recordBackgroundShellRead(file, "ses_a", { ...range, now: 0 })
      pollBackgroundShells(AWAIT_GRACE_MS)
      expect({ range, notes: notes.length }).toEqual({ range, notes: shown ? 0 : 1 })
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

  test("waits while the file is being read, then posts when no read saw the end", () => {
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

  test("a read that starts on the finished file during the wait drops the note", () => {
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

  test("reads of a plain log, which shows no end, hold its note no longer than the cap", () => {
    const file = join(dir, "cursor-opencode-bg.XYZ")
    writeFileSync(file, "x\n")
    watch(GONE_PID, file)
    noteSessionExecution("ses_a", "succeeded")
    for (let t = 1000; t < 1000 + MAX_HOLD_MS; t += 1000) {
      recordBackgroundShellRead(file, "ses_a", { now: t })
      pollBackgroundShells(t)
    }
    expect(notes).toEqual([])
    recordBackgroundShellRead(file, "ses_a", { now: 1000 + MAX_HOLD_MS })
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

  test("a plain log is done when its process is gone, without an exit code", () => {
    const file = join(dir, "cursor-opencode-bg.ABC123")
    writeFileSync(file, "building\nok\n")
    watch(GONE_PID, file)
    noteSessionExecution("ses_a", "succeeded")
    pollBackgroundShells(1000)
    expect(notes).toHaveLength(1)
    expect(notes[0]!.text).toContain(`Background shell ${GONE_PID} has finished; its exit code was not recorded.`)
    expect(notes[0]!.text).toContain("building\nok\n</shell>")
    expect(notes[0]!.metadata.exit).toBeUndefined()
  })

  test("a runner gone without finishing its terminal file is reported after a grace period", () => {
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
    watchBackgroundShell({ sessionID: "ses_a", pid: LIVE_PID, file, command: 'echo "a" <b>\nnext & more', notifier, now: 0 })
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
    watchBackgroundShell({ sessionID: "ses_a", pid: LIVE_PID, file, command: "x", notifier: async (note) => void first.push(note), now: 0 })
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
    watchBackgroundShell({ sessionID: "ses_a", pid: LIVE_PID, file, command: "x", notifier: failing, now: 0 })
    noteSessionExecution("ses_a", "succeeded")
    pollBackgroundShells(1000)
    await Promise.resolve()
    pollBackgroundShells(2000)
    expect(calls).toBe(1)
  })
})
