import { closeSync, fstatSync, openSync, readSync, constants } from "node:fs"
import { basename, resolve } from "node:path"
import { trace } from "./debug.js"

export type BackgroundShellNote = {
  sessionID: string
  text: string
  description: string
  metadata: Record<string, unknown>
  resume?: boolean
}

export type BackgroundShellNotifier = (note: BackgroundShellNote) => Promise<unknown>

type ShellEnd = {
  state: "completed" | "cancelled" | "error"
  status?: string
  exitCode?: number
  elapsedMs?: number
}

type WatchedShell = {
  sessionID: string
  pid: number
  file: string
  command: string
  startedAt: number
  terminal: boolean
  notifier: BackgroundShellNotifier
  end?: ShellEnd
  endSeenAt?: number
  goneSince?: number
  lastReadAt?: number
  observed?: boolean
}

type SessionState = { busy: boolean; stopped?: boolean }

type NoticeState = {
  watches: Map<string, WatchedShell>
  notifiers: Set<BackgroundShellNotifier>
  sessions: Map<string, SessionState>
  supported: boolean
  timer?: ReturnType<typeof setInterval>
  manualPolling?: boolean
}

const POLL_INTERVAL_MS = 1000
// AwaitShell reads the terminal file about three times a second.
export const AWAIT_GRACE_MS = 2000
export const BUSY_SETTLE_MS = 10_000
export const MAX_HOLD_MS = 60_000
export const RUNNER_GONE_GRACE_MS = 3000
const MAX_WATCHES = 256
const HEADER_LIMIT_BYTES = 1024 * 1024
const TAIL_WINDOW_BYTES = 64 * 1024
const FOOTER_WINDOW_BYTES = 1024 * 1024
const LINE_COUNT_LIMIT_BYTES = 16 * 1024 * 1024
const NOTE_TAIL_LINES = 20
const NOTE_TAIL_CHARS = 2000
const NOTE_COMMAND_CHARS = 200

// The plugin and the model run in separate module graphs, and the plugin reloads in place.
const NOTICES = Symbol.for("cursor-opencode-provider.background-shell-notices")
const globals = globalThis as typeof globalThis & { [NOTICES]?: NoticeState }
const state: NoticeState = globals[NOTICES] ??= {
  watches: new Map(),
  notifiers: new Set(),
  sessions: new Map(),
  supported: false,
}

export function registerBackgroundShellNotifier(notifier: BackgroundShellNotifier): () => void {
  state.notifiers.add(notifier)
  state.supported = true
  if (state.watches.size > 0) ensureTimer()
  return () => {
    state.notifiers.delete(notifier)
  }
}

// Sticky, so the frozen guidance does not change when a plugin reloads.
export function backgroundShellNoticesSupported(): boolean {
  return state.supported
}

export function watchBackgroundShell(input: {
  sessionID: string
  pid: number
  file: string
  command: string
  notifier: BackgroundShellNotifier
  now?: number
}): void {
  if (!input.sessionID || !Number.isSafeInteger(input.pid) || input.pid <= 0 || !input.file) return
  const file = resolve(input.file)
  state.watches.delete(file)
  state.watches.set(file, {
    sessionID: input.sessionID,
    pid: input.pid,
    file,
    command: input.command,
    startedAt: input.now ?? Date.now(),
    terminal: basename(file) === `${input.pid}.txt`,
    notifier: input.notifier,
  })
  // A tool call started it, so its session is in a turn.
  state.sessions.set(input.sessionID, { busy: true })
  while (state.watches.size > MAX_WATCHES) {
    const [oldest, dropped] = state.watches.entries().next().value as [string, WatchedShell]
    state.watches.delete(oldest)
    trace(`background shell: too many watched, dropped pid=${dropped.pid} sessionID=${dropped.sessionID}`)
  }
  trace(`background shell: watching pid=${input.pid} sessionID=${input.sessionID} file=${JSON.stringify(file)}`)
  ensureTimer()
}

// Call before answering the read: an answer that starts on a finished terminal file shows the end.
export function recordBackgroundShellRead(
  file: string,
  sessionID: string | undefined,
  read: { offset?: number; limit?: number; now?: number } = {},
): void {
  const watch = state.watches.get(resolve(file))
  if (!watch || !sessionID || watch.sessionID !== sessionID) return
  watch.lastReadAt = read.now ?? Date.now()
  if (watch.observed || !watch.terminal) return
  const shown = readShowsEnd(watch.file, read)
  trace(`background shell: read of pid=${watch.pid} offset=${read.offset ?? "-"} limit=${read.limit ?? "-"} shows end=${shown}`)
  if (!shown) return
  watch.observed = true
  trace(`background shell: pid=${watch.pid} end read by the model; no note`)
}

export function noteSessionExecution(sessionID: string, event: "started" | "succeeded" | "failed" | "interrupted"): void {
  if (!state.sessions.has(sessionID)) return
  state.sessions.set(sessionID, event === "started" ? { busy: true } : { busy: false, stopped: event === "interrupted" })
}

export function forgetBackgroundShells(sessionID: string): void {
  state.sessions.delete(sessionID)
  for (const [file, watch] of state.watches) {
    if (watch.sessionID === sessionID) state.watches.delete(file)
  }
}

export function pollBackgroundShells(now = Date.now()): void {
  for (const [file, watch] of state.watches) {
    if (!watch.end) probe(watch, now)
    if (!watch.end) continue
    if (!watch.observed) {
      if (holdNote(watch, now)) continue
      const notifier = state.notifiers.has(watch.notifier) ? watch.notifier : state.notifiers.values().next().value
      if (!notifier) continue
      post(notifier, watch)
    }
    state.watches.delete(file)
    if (![...state.watches.values()].some((other) => other.sessionID === watch.sessionID)) state.sessions.delete(watch.sessionID)
  }
  if (state.watches.size === 0) stopTimer()
}

function holdNote(watch: WatchedShell, now: number): boolean {
  const sinceEnd = now - (watch.endSeenAt ?? now)
  if (sinceEnd >= MAX_HOLD_MS) return false
  if (watch.lastReadAt !== undefined && now - watch.lastReadAt < AWAIT_GRACE_MS) return true
  // Mid-turn, give the model a moment to await a command that ended quickly.
  return (state.sessions.get(watch.sessionID)?.busy ?? false) && sinceEnd < BUSY_SETTLE_MS
}

function post(notifier: BackgroundShellNotifier, watch: WatchedShell): void {
  const end = watch.end!
  const session = state.sessions.get(watch.sessionID)
  const note: BackgroundShellNote = {
    sessionID: watch.sessionID,
    text: backgroundShellNoteText(watch, end, readOutputTail(watch)),
    description: watch.command,
    metadata: {
      source: "shell",
      shellID: String(watch.pid),
      state: end.state,
      ...(end.exitCode !== undefined ? { exit: end.exitCode } : {}),
      file: watch.file,
    },
    // After a Stop, the note waits for the user's next message instead of starting a turn.
    ...(session && !session.busy && session.stopped ? { resume: false } : {}),
  }
  trace(
    `background shell: posting note pid=${watch.pid} sessionID=${watch.sessionID} state=${end.state} ` +
      `exit=${end.exitCode ?? "-"} resume=${note.resume ?? true}`,
  )
  notifier(note).catch((error: unknown) => {
    trace(`background shell: note for pid=${watch.pid} failed: ${error instanceof Error ? error.message : String(error)}`)
  })
}

function probe(watch: WatchedShell, now: number): void {
  if (!watch.terminal) {
    if (processExists(watch.pid)) return
    watch.end = { state: "completed" }
    watch.endSeenAt = now
    return
  }
  const end = readTerminalEnd(watch.file)
  if (end) {
    watch.end = end
    watch.endSeenAt = now
    return
  }
  if (processExists(watch.pid)) {
    watch.goneSince = undefined
    return
  }
  watch.goneSince ??= now
  if (now - watch.goneSince < RUNNER_GONE_GRACE_MS) return
  watch.end = { state: "error" }
  watch.endSeenAt = now
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as { code?: string }).code === "EPERM"
  }
}

function openPlain(file: string): number | undefined {
  try {
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    if (fstatSync(fd).isFile()) return fd
    closeSync(fd)
  } catch {
    // missing or unreadable
  }
  return undefined
}

function readRange(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(Math.max(0, length))
  let read = 0
  while (read < buffer.length) {
    const n = readSync(fd, buffer, read, buffer.length - read, position + read)
    if (n === 0) break
    read += n
  }
  return buffer.subarray(0, read)
}

function readHeader(fd: number, size: number): { end: number; text: string } | undefined {
  let length = Math.min(size, 4096)
  for (;;) {
    const head = readRange(fd, 0, length)
    if (head.subarray(0, 4).toString("utf8") !== "---\n") return undefined
    const close = head.indexOf("\n---\n", 3)
    if (close !== -1) return { end: close + 5, text: head.subarray(0, close + 5).toString("utf8") }
    if (length >= Math.min(size, HEADER_LIMIT_BYTES)) return undefined
    length = Math.min(size, HEADER_LIMIT_BYTES, length * 16)
  }
}

// The runner rewrites the header's status only after it has written the footer.
const FINAL_STATUS = /^status: (succeeded|failed|aborted) *$/m
const FOOTER = /\n---\nexit_code: (-?\d+)\nelapsed_ms: (\d+)\nended_at: [^\n]*\n---\n/g
const FOOTER_OPENING = "\n---\nexit_code: "
const FOOTER_AT_START = /^\n---\nexit_code: -?\d+\nelapsed_ms: \d+\nended_at: [^\n]*\n---\n/

function readTerminalEnd(file: string): ShellEnd | undefined {
  const fd = openPlain(file)
  if (fd === undefined) return undefined
  try {
    const size = fstatSync(fd).size
    const header = readHeader(fd, size)
    const status = header && FINAL_STATUS.exec(header.text)?.[1]
    if (!header || !status) return undefined
    // A descendant may keep writing after the footer.
    const start = Math.max(header.end, size - FOOTER_WINDOW_BYTES)
    const footer = lastFooter(readRange(fd, start, size - start).toString("utf8"))
    return {
      state: status === "aborted" ? "cancelled" : "completed",
      status,
      ...(footer ? { exitCode: footer.exitCode, elapsedMs: footer.elapsedMs } : {}),
    }
  } catch {
    return undefined
  } finally {
    closeSync(fd)
  }
}

function readShowsEnd(file: string, range: { offset?: number; limit?: number }): boolean {
  const fd = openPlain(file)
  if (fd === undefined) return false
  try {
    const size = fstatSync(fd).size
    const header = readHeader(fd, size)
    const status = header && FINAL_STATUS.exec(header.text)
    if (!header || !status) return false
    if (range.offset === undefined && range.limit === undefined) return true
    const first = Math.max(1, range.offset ?? 1)
    const last = range.limit === undefined ? Infinity : first + range.limit - 1
    const statusLine = header.text.slice(0, status.index).split("\n").length
    if (first <= statusLine && statusLine <= last) return true
    const footer = findFooter(fd, header.end, size)
    if (footer === undefined || footer > LINE_COUNT_LIMIT_BYTES) return false
    // The footer opens with a newline, then its `---` line, then `exit_code:`.
    const exitCodeLine = countNewlines(fd, footer + 1) + 2
    return first <= exitCodeLine && exitCodeLine <= last
  } catch {
    return false
  } finally {
    closeSync(fd)
  }
}

function findFooter(fd: number, outputStart: number, size: number): number | undefined {
  const start = Math.max(outputStart, size - FOOTER_WINDOW_BYTES)
  const window = readRange(fd, start, size - start)
  for (let at = window.lastIndexOf(FOOTER_OPENING); at !== -1; at = at > 0 ? window.lastIndexOf(FOOTER_OPENING, at - 1) : -1) {
    if (FOOTER_AT_START.test(window.subarray(at, at + 200).toString("utf8"))) return start + at
  }
  return undefined
}

function countNewlines(fd: number, end: number): number {
  let count = 0
  for (let position = 0; position < end; position += TAIL_WINDOW_BYTES) {
    const chunk = readRange(fd, position, Math.min(TAIL_WINDOW_BYTES, end - position))
    for (let i = 0; i < chunk.length; i++) if (chunk[i] === 0x0a) count++
  }
  return count
}

function lastFooter(text: string): { index: number; end: number; exitCode: number; elapsedMs: number } | undefined {
  let last: { index: number; end: number; exitCode: number; elapsedMs: number } | undefined
  for (const match of text.matchAll(FOOTER)) {
    last = { index: match.index!, end: match.index! + match[0].length, exitCode: Number(match[1]), elapsedMs: Number(match[2]) }
  }
  return last
}

function readOutputTail(watch: WatchedShell): { lines: string[]; omitted: boolean } {
  const fd = openPlain(watch.file)
  if (fd === undefined) return { lines: [], omitted: false }
  try {
    const size = fstatSync(fd).size
    const outputStart = watch.terminal ? (readHeader(fd, size)?.end ?? 0) : 0
    const start = Math.max(outputStart, size - TAIL_WINDOW_BYTES)
    let text = readRange(fd, start, size - start).toString("utf8")
    let omitted = start > outputStart
    const footer = watch.terminal ? lastFooter(text) : undefined
    if (footer) {
      const before = text.slice(0, footer.index)
      const after = text.slice(footer.end)
      text = before + (after && !before.endsWith("\n") ? "\n" : "") + after
    }
    if (omitted) text = text.slice(text.indexOf("\n") + 1)
    const all = text.replace(/\s+$/, "").split("\n")
    if (all.length === 1 && all[0] === "") return { lines: [], omitted }
    let lines = all.slice(-NOTE_TAIL_LINES)
    omitted ||= lines.length < all.length
    while (lines.length > 1 && lines.join("\n").length > NOTE_TAIL_CHARS) {
      lines = lines.slice(1)
      omitted = true
    }
    if (lines[0]!.length > NOTE_TAIL_CHARS) {
      lines = [lines[0]!.slice(-NOTE_TAIL_CHARS)]
      omitted = true
    }
    return { lines, omitted }
  } catch {
    return { lines: [], omitted: false }
  } finally {
    closeSync(fd)
  }
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function attribute(value: string): string {
  const short = value.length > NOTE_COMMAND_CHARS ? `${value.slice(0, NOTE_COMMAND_CHARS)}…` : value
  return short.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/\n/g, "&#10;")
}

// OpenCode's `<shell>` completion note, as a host `<system-update>` so it is never taken for a user message.
export function backgroundShellNoteText(
  watch: Pick<WatchedShell, "pid" | "file" | "command" | "startedAt" | "terminal" | "endSeenAt">,
  end: ShellEnd,
  tail: { lines: string[]; omitted: boolean },
): string {
  const after = formatDuration(end.elapsedMs ?? (watch.endSeenAt ?? Date.now()) - watch.startedAt)
  const name = `Background shell ${watch.pid}`
  const headline =
    end.state === "error"
      ? `${name} ended without reporting an exit code; its runner was stopped.`
      : !watch.terminal
        ? `${name} has finished; its exit code was not recorded.`
        : end.state === "cancelled"
          ? `${name} was stopped after ${after}${end.exitCode !== undefined ? ` (exit code ${end.exitCode})` : ""}.`
          : end.exitCode === undefined
            ? `${name} has ${end.status === "failed" ? "failed" : "finished"} after ${after}.`
            : end.exitCode === 0
              ? `${name} finished with exit code 0 after ${after}.`
              : `${name} failed with exit code ${end.exitCode} after ${after}.`
  const output =
    tail.lines.length === 0
      ? [`It printed no output. Output file: ${watch.file}`]
      : [
          tail.omitted
            ? `Last ${tail.lines.length} line${tail.lines.length === 1 ? "" : "s"} of its output (full output in ${watch.file}):`
            : `Its output (also in ${watch.file}):`,
          ...tail.lines,
        ]
  return [
    "<system-update>",
    `<shell id="${watch.pid}" state="${end.state}" command="${attribute(watch.command)}">`,
    headline,
    ...output,
    "</shell>",
    "</system-update>",
  ].join("\n")
}

function ensureTimer(): void {
  if (state.timer || state.manualPolling || state.watches.size === 0) return
  state.timer = setInterval(() => pollBackgroundShells(), POLL_INTERVAL_MS)
  ;(state.timer as unknown as { unref?: () => void }).unref?.()
}

function stopTimer(): void {
  if (!state.timer) return
  clearInterval(state.timer)
  state.timer = undefined
}

export function resetBackgroundShellNotices(options: { manualPolling?: boolean } = {}): void {
  stopTimer()
  state.watches.clear()
  state.notifiers.clear()
  state.sessions.clear()
  state.supported = false
  state.manualPolling = options.manualPolling
}
