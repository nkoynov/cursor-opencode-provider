import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync, constants } from "node:fs"
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
  storageFailed?: boolean
}

type WatchedShell = {
  sessionID: string
  shellId: number
  /** The record's supervisor. */
  pid: number
  file: string
  command: string
  startedAt: number
  notifier: BackgroundShellNotifier
  end?: ShellEnd
  endSeenAt?: number
  goneSince?: number
  lastReadAt?: number
  observed?: boolean
  /** When a kill command of its session named one of its processes. */
  targetedAt?: number
  targetedBy?: string
  targetedUntil?: number
  targetSignals?: number[]
  targetedLater?: boolean
  targetedLastIsKill?: boolean
  targetedVerified?: boolean
  stoppedByAgent?: boolean
  posting?: boolean
  retried?: boolean
}

type SessionState = { busy: boolean; stopped?: boolean }

type KillCommand = { sessionID: string; startedAt: number; endedAt?: number; signals?: number[] }

type NoticeState = {
  watches: Map<string, WatchedShell>
  notifiers: Set<BackgroundShellNotifier>
  sessions: Map<string, SessionState>
  /** By tool execution id. Optional: a state an older build created on reload lacks it. */
  kills?: Map<string, KillCommand>
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
// A server the agent killed by pid may take a while to shut down.
export const TARGETED_STOP_MS = 30_000
// Without a pid that names the shell, only a death by signal this soon after a kill command counts. A killed
// server's children can hold its output open until the supervisor stops its group, seven seconds on a loaded VM.
export const KILL_SETTLE_MS = 20_000
// The note of a shell the agent stopped waits out the turn, never starting one of its own.
export const STOPPED_HOLD_MS = 30 * 60_000
const MAX_WATCHES = 256
const MAX_KILLS = 64
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
  // A reloaded plugin's timer would keep polling with the old module's code.
  stopTimer()
  ensureTimer()
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
  shellId: number
  pid: number
  file: string
  command: string
  notifier: BackgroundShellNotifier
  now?: number
}): void {
  if (!input.sessionID || !Number.isSafeInteger(input.pid) || input.pid <= 0 || !input.file) return
  const file = resolve(input.file)
  if (basename(file) !== `${input.shellId}.txt`) return
  state.watches.delete(file)
  state.watches.set(file, {
    sessionID: input.sessionID,
    shellId: input.shellId,
    pid: input.pid,
    file,
    command: input.command,
    startedAt: input.now ?? Date.now(),
    notifier: input.notifier,
  })
  // A tool call started it, so its session is in a turn.
  state.sessions.set(input.sessionID, { busy: true })
  while (state.watches.size > MAX_WATCHES) {
    const [oldest, dropped] = state.watches.entries().next().value as [string, WatchedShell]
    state.watches.delete(oldest)
    trace(`background shell: too many watched, dropped shell=${dropped.shellId} sessionID=${dropped.sessionID}`)
  }
  trace(`background shell: watching shell=${input.shellId} pid=${input.pid} sessionID=${input.sessionID} file=${JSON.stringify(file)}`)
  ensureTimer()
}

// Call before answering the read: an answer that starts on a finished terminal file shows the end.
export function recordBackgroundShellRead(
  file: string,
  sessionID: string | undefined,
  read: { offset?: number; limit?: number; now?: number } = {},
): boolean {
  const watch = state.watches.get(resolve(file))
  if (!watch || !sessionID || watch.sessionID !== sessionID) return false
  watch.lastReadAt = read.now ?? Date.now()
  if (watch.observed) return false
  const shown = readShowsEnd(watch.file, read)
  trace(`background shell: read of shell=${watch.shellId} offset=${read.offset ?? "-"} limit=${read.limit ?? "-"} shows end=${shown}`)
  if (!shown) return false
  watch.observed = true
  trace(`background shell: shell=${watch.shellId} end read by the model; no note`)
  return true
}

export function noteSessionExecution(sessionID: string, event: "started" | "succeeded" | "failed" | "interrupted"): void {
  if (!state.sessions.has(sessionID)) return
  state.sessions.set(sessionID, event === "started" ? { busy: true } : { busy: false, stopped: event === "interrupted" })
}

/**
 * Call before a session's shell command runs. A kill command's targets are matched while their
 * processes still exist, so a watched shell they belong to is known to be the agent's own stop.
 */
export function noteAgentShellCommand(sessionID: string, executionID: string, command: string, now = Date.now()): void {
  // Process ancestry comes from /proc and the signal numbers are Linux's.
  if (!sessionID || !executionID || process.platform !== "linux") return
  const watches = [...state.watches.values()].filter((watch) => watch.sessionID === sessionID && !watch.end)
  if (watches.length === 0) return
  const kill = parseKillCommand(command)
  if (!kill) return
  const table = kill.kills.some((entry) => entry.names.length > 0) ? processTable() : undefined
  const stat = table ? (pid: number) => table.get(pid) : procStat
  const targets = (watch: WatchedShell, entry: KillEntry) =>
    entry.pids.some((pid) => descendsFrom(pid, watch.pid, stat))
    || (table !== undefined && entry.names.length > 0
      && [...table.keys()].some((pid) => descendsFrom(pid, watch.pid, stat) && entry.names.some((name) => nameMatches(name, pid))))
  for (const watch of watches) {
    const matching = kill.kills.filter((entry) => targets(watch, entry))
    if (matching.length === 0) continue
    const rightAway = matching.filter((entry) => entry.rightAway)
    // A kill behind other commands may never run (`curl /crash && kill PID`), or run after the shell ended by itself.
    const counted = rightAway.length > 0 ? rightAway : matching
    watch.targetedAt = now
    watch.targetedBy = executionID
    watch.targetedUntil = undefined
    watch.targetSignals = [...new Set(counted.flatMap((entry) => entry.signals))]
    watch.targetedLater = rightAway.length === 0
    // The command's exit status is its last kill's, and that proves a signal reached this shell only when it is the
    // kill's one target.
    watch.targetedLastIsKill = matching.length === 1 && matching[0]!.last && matching[0]!.pids.length === 1 && matching[0]!.names.length === 0
    watch.targetedVerified = false
    trace(`background shell: shell=${watch.shellId} named by kill command execution=${executionID}${rightAway.length > 0 ? "" : " (later)"}`)
  }
  // A target that can't be resolved (`pkill "$NAME"`, `fuser -k PORT/tcp`, `xargs kill`) falls back to timing.
  const unresolved = kill.kills.filter((entry) => entry.rightAway && entry.unresolved)
  if (unresolved.length === 0) return
  const kills = state.kills ??= new Map()
  kills.set(executionID, { sessionID, startedAt: now, signals: [...new Set(unresolved.flatMap((entry) => entry.signals))] })
  while (kills.size > MAX_KILLS) kills.delete(kills.keys().next().value!)
}

/** `exitCode` is the whole command's: 0 with a kill as its last command means that kill signalled a live process. */
export function noteAgentShellCommandEnded(executionID: string, now = Date.now(), exitCode?: number): void {
  const kill = state.kills?.get(executionID)
  if (kill) kill.endedAt = now
  for (const watch of state.watches.values()) {
    if (watch.targetedBy !== executionID) continue
    watch.targetedUntil = now + TARGETED_STOP_MS
    if (watch.targetedLastIsKill && exitCode === 0) watch.targetedVerified = true
  }
}

export function forgetBackgroundShells(sessionID: string): void {
  state.sessions.delete(sessionID)
  for (const [file, watch] of state.watches) {
    if (watch.sessionID === sessionID) state.watches.delete(file)
  }
  for (const [id, kill] of state.kills ?? []) {
    if (kill.sessionID === sessionID) state.kills!.delete(id)
  }
}

export function pollBackgroundShells(now = Date.now()): void {
  for (const watch of state.watches.values()) {
    if (watch.posting) continue
    if (!watch.end) probe(watch, now)
    if (!watch.end) continue
    if (!watch.observed) {
      // Kept once found: the kill records it rests on expire while the note is held.
      const stopped = watch.stoppedByAgent ||= stoppedByAgent(watch)
      if (holdNote(watch, now, stopped)) continue
      const notifier = state.notifiers.has(watch.notifier) ? watch.notifier : state.notifiers.values().next().value
      if (!notifier) continue
      post(notifier, watch, stopped)
      continue
    }
    unwatch(watch)
  }
  for (const [id, kill] of state.kills ?? []) {
    if (now - kill.startedAt > KILL_SETTLE_MS + POLL_INTERVAL_MS) state.kills!.delete(id)
  }
  if (state.watches.size === 0) stopTimer()
}

function holdNote(watch: WatchedShell, now: number, stopped: boolean): boolean {
  const sinceEnd = now - (watch.endSeenAt ?? now)
  if (stopped) {
    if (watch.lastReadAt !== undefined && now - watch.lastReadAt < AWAIT_GRACE_MS) return true
    // Posted mid-turn, the note would be taken after the turn's last message and answered there.
    return (state.sessions.get(watch.sessionID)?.busy ?? false) && sinceEnd < STOPPED_HOLD_MS
  }
  if (sinceEnd >= MAX_HOLD_MS) return false
  if (watch.lastReadAt !== undefined && now - watch.lastReadAt < AWAIT_GRACE_MS) return true
  // Mid-turn, give the model a moment to await a command that ended quickly.
  return (state.sessions.get(watch.sessionID)?.busy ?? false) && sinceEnd < BUSY_SETTLE_MS
}

function stoppedByAgent(watch: WatchedShell): boolean {
  const seen = watch.endSeenAt
  if (seen === undefined) return false
  const signal = endSignal(watch.end!)
  // A crash, or a signal the agent's kill doesn't send (the OOM killer's KILL after a TERM), is never its stop.
  if (signal !== undefined && CRASH_SIGNALS.has(signal)) return false
  if (watch.targetedAt !== undefined && seen >= watch.targetedAt
    && seen <= (watch.targetedUntil ?? watch.targetedAt + STOPPED_HOLD_MS)) {
    if (signal !== undefined ? sends(watch.targetSignals, signal) : !watch.targetedLater || watch.targetedVerified) return true
  }
  if (signal === undefined) return false
  for (const kill of state.kills?.values() ?? []) {
    if (kill.sessionID === watch.sessionID && seen >= kill.startedAt && seen - kill.startedAt <= KILL_SETTLE_MS
      && sends(kill.signals, signal)) return true
  }
  return false
}

function endSignal(end: ShellEnd): number | undefined {
  return end.exitCode !== undefined && end.exitCode > 128 && end.exitCode <= 128 + 64 ? end.exitCode - 128 : undefined
}

/** An empty list stands for signals that have no fixed number here (`RTMIN+2`). */
function sends(signals: readonly number[] | undefined, signal: number): boolean {
  return signals === undefined || signals.length === 0 || signals.includes(signal)
}

type Word = { text: string; dynamic: boolean; operator?: boolean }

/** Words of each simple command; quotes are removed, and `dynamic` marks a `$` expansion outside single quotes. */
function shellSegments(command: string): Word[][] {
  const segments: Word[][] = [[]]
  let word: Word | undefined
  let quote: "'" | '"' | undefined
  const endWord = () => {
    if (word) segments.at(-1)!.push(word)
    word = undefined
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (quote === "'") {
      if (c === "'") quote = undefined
      else word!.text += c
      continue
    }
    if (c === "\\" && i + 1 < command.length) {
      word ??= { text: "", dynamic: false }
      word.text += command[++i]
      continue
    }
    if (quote === '"') {
      if (c === '"') quote = undefined
      else {
        if (c === "$" || c === "`") word!.dynamic = true
        word!.text += c
      }
      continue
    }
    if (c === "'" || c === '"') {
      word ??= { text: "", dynamic: false }
      quote = c
    } else if (/\s/.test(c) && c !== "\n") {
      endWord()
    } else if (/[;&|\n()`{}]/.test(c)) {
      endWord()
      if (segments.at(-1)!.length > 0) segments.push([])
      if ((c === "&" || c === "|") && command[i + 1] === c) {
        segments.at(-1)!.push({ text: c + c, dynamic: false, operator: true })
        segments.push([])
        i++
      }
    } else {
      word ??= { text: "", dynamic: false }
      if (c === "$") word.dynamic = true
      word.text += c
    }
  }
  endWord()
  return segments.filter((segment) => segment.length > 0)
}

type Prefix = { withValue: string[]; notRun?: string[]; positional?: number }
const PREFIXES: Record<string, Prefix> = {
  sudo: { withValue: ["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "-T"] },
  env: { withValue: ["-u", "-C", "-S", "--unset", "--chdir"] },
  command: { withValue: [], notRun: ["-v", "-V"] },
  exec: { withValue: ["-a"] },
  builtin: { withValue: [] },
  nohup: { withValue: [] },
  time: { withValue: ["-f", "-o"] },
  nice: { withValue: ["-n"] },
  timeout: { withValue: ["-s", "-k", "--signal", "--kill-after"], positional: 1 },
  xargs: { withValue: ["-I", "-n", "-P", "-L", "-d", "-E", "-s", "-a", "--max-args", "--max-procs", "--delimiter", "--arg-file"] },
}
const KILL_PROGRAMS = new Set(["kill", "pkill", "killall", "fuser"])
// Commands that may run before a kill without an end of their own that could be taken for the kill's doing.
const QUICK_PROGRAMS = new Set([
  "cd", "export", "set", "true", ":", "echo", "printf", "cat", "lsof", "pgrep", "ps", "ss", "grep", "awk", "sed",
  "head", "tail", "cut", "tr", "sort", "uniq", "test", "[", "kill", "pkill", "killall", "fuser", "xargs",
])
const ALWAYS_SUCCEED = new Set(["cd", "export", "set", "true", ":", "echo", "printf"])
const NOT_A_KILL = new Set(["-l", "-L", "--list", "--table", "--help", "--version", "-V"])
// Options whose meaning for which processes match is implemented here; any other option leaves the name unresolved.
const NAME_FLAGS: Record<"pkill" | "killall", { flags: string; long: string[]; withValue: string[] }> = {
  pkill: { flags: "efixA", long: ["--echo", "--full", "--ignore-case", "--exact", "--ignore-ancestors"], withValue: ["-q", "--queue"] },
  killall: { flags: "eIqvwgr", long: ["--exact", "--ignore-case", "--quiet", "--verbose", "--wait", "--process-group", "--regexp"], withValue: [] },
}
// Patterns made only of characters that mean the same in a POSIX extended regex and a JavaScript one.
const PORTABLE_PATTERN = /^[\w./ :=@,+^$|*?()-]+$/

export type KillName = { program: "pkill" | "killall"; pattern: string; full: boolean; exact: boolean; regex: boolean; ignoreCase: boolean }
/** One simple kill command: what it targets and sends, whether it runs right away, and whether it ends the command. */
export type KillEntry = { pids: number[]; names: KillName[]; signals: number[]; unresolved: boolean; rightAway: boolean; last: boolean }

export type ParsedKill = {
  kills: KillEntry[]
  pids: number[]
  names: KillName[]
  /** What the right-away kills send; empty when one sends a real-time signal. */
  signals: number[]
  laterPids: number[]
  laterNames: KillName[]
  laterSignals: number[]
  unresolved: boolean
  leading: boolean
  /** The command's last simple command is a kill, so the command's exit status is that kill's. */
  lastIsKill: boolean
}

/** The program word of a simple command after its prefixes, or undefined when the command doesn't run it. */
function commandWords(words: Word[]): { program: string; args: Word[]; viaXargs: boolean } | undefined {
  let i = 0
  let viaXargs = false
  while (i < words.length) {
    const text = words[i]!.text
    const prefix = PREFIXES[text.split("/").pop()!]
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(text)) { i++; continue }
    if (!prefix) break
    if (text.endsWith("xargs")) viaXargs = true
    i++
    let positional = prefix.positional ?? 0
    while (i < words.length) {
      const option = words[i]!.text
      if (prefix.notRun?.includes(option)) return undefined
      if (option === "--") { i++; break }
      if (option.startsWith("-") && option.length > 1) i += prefix.withValue.includes(option) ? 2 : 1
      else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(option) && text === "env") i++
      else if (positional > 0) { positional--; i++ }
      else break
    }
  }
  const program = words[i]?.text.split("/").pop()
  return program ? { program, args: words.slice(i + 1), viaXargs } : undefined
}

function normalSignal(text: string): string {
  return text.toUpperCase().replace(/^SIG/, "")
}

const SIGNAL_NUMBERS: Record<string, number> = {
  HUP: 1, INT: 2, QUIT: 3, ILL: 4, TRAP: 5, ABRT: 6, IOT: 6, BUS: 7, FPE: 8, KILL: 9, USR1: 10, SEGV: 11, USR2: 12,
  PIPE: 13, ALRM: 14, TERM: 15, STKFLT: 16, CHLD: 17, CLD: 17, CONT: 18, STOP: 19, TSTP: 20, TTIN: 21, TTOU: 22, URG: 23,
  XCPU: 24, XFSZ: 25, VTALRM: 26, PROF: 27, WINCH: 28, IO: 29, POLL: 29, PWR: 30, SYS: 31,
}
const SIGTERM = 15
const SIGKILL = 9
// Deaths a process brings on itself; a kill sends one of these only when it names it.
const CRASH_SIGNALS = new Set([4, 5, 6, 7, 8, 11, 24, 25, 31])
// Signals that stop or notify a process without ending it.
const NON_ENDING_SIGNALS = new Set([17, 18, 19, 20, 21, 22, 23, 28])

/** A signal Linux delivers, or 0, which only tests that the process exists. */
function signalKind(name: string): "zero" | "signal" | "invalid" {
  const normal = normalSignal(name)
  if (/^\d+$/.test(normal) && Number(normal) === 0) return "zero"
  return signalNumber(name) === undefined ? "invalid" : "signal"
}

// glibc keeps 32 and 33 for itself, so procps and bash name 34 RTMIN and 64 RTMAX.
const RTMIN = 34
const RTMAX = 64

function signalNumber(name: string): number | undefined {
  const normal = normalSignal(name)
  if (/^\d+$/.test(normal)) return Number(normal) >= 1 && Number(normal) <= RTMAX ? Number(normal) : undefined
  if (normal in SIGNAL_NUMBERS) return SIGNAL_NUMBERS[normal]
  const realTime = /^RTM(IN|AX)(?:([+-])(\d{1,2}))?$/.exec(normal)
  if (!realTime) return undefined
  const offset = Number(realTime[3] ?? 0)
  if (realTime[2] === (realTime[1] === "IN" ? "-" : "+") && offset > 0) return undefined
  const number = realTime[1] === "IN" ? RTMIN + offset : RTMAX - offset
  return number >= RTMIN && number <= RTMAX ? number : undefined
}

/** `-9`, `-TERM`, `-SIGKILL`, `-RTMIN+2`: an option that names a signal, so not a pkill or killall flag like `-P123`. */
function signalOption(text: string): string | undefined {
  // pkill takes `-kill` too; a lowercase word is a signal only when it is a whole signal name, not flags like `-fx`.
  const name = /^-(\d+|[A-Z][A-Z0-9+-]*|[a-z][a-z0-9+-]{2,})$/.exec(text)?.[1]
  if (name === undefined || signalKind(name) === "invalid") return undefined
  return /^[a-z]/.test(name) && !(name.toUpperCase().replace(/^SIG/, "") in SIGNAL_NUMBERS) ? undefined : name
}

/**
 * A command that runs kill, pkill, killall or `fuser -k` with a real signal: the pids kill names (process groups by
 * their leader) and the names pkill and killall match, for kills that run right away (nothing but quick commands
 * before them) and, as `later…`, for kills behind other commands; and whether a right-away kill's target can't be
 * resolved. `leading` says whether the first kill ran right away.
 */
export function parseKillCommand(command: string): ParsedKill | undefined {
  const parsed = emptyKill(true)
  let found = false
  let quickSoFar = true
  let previous: string | undefined
  const realTime = { now: false, later: false }
  for (const segment of shellSegments(command)) {
    if (segment[0]?.operator) {
      // What follows `&&` runs only if the command before it succeeded, and what follows `||` only if it failed.
      if (segment[0].text === "||" || !ALWAYS_SUCCEED.has(previous ?? "")) quickSoFar = false
      continue
    }
    const run = commandWords(segment)
    previous = run?.program
    const kill = emptyKill(quickSoFar)
    const isKill = run !== undefined && KILL_PROGRAMS.has(run.program) && parseKillSegment(run.program, run.args, run.viaXargs, kill)
    parsed.lastIsKill = isKill
    if (isKill) {
      if (!found) parsed.leading = quickSoFar
      found = true
      parsed.kills.push({ pids: kill.pids, names: kill.names, signals: kill.signals, unresolved: kill.unresolved, rightAway: quickSoFar, last: false })
      if (quickSoFar) {
        parsed.pids.push(...kill.pids)
        parsed.names.push(...kill.names)
        parsed.signals.push(...kill.signals)
        realTime.now ||= kill.signals.length === 0
        parsed.unresolved ||= kill.unresolved
      } else {
        parsed.laterPids.push(...kill.pids)
        parsed.laterNames.push(...kill.names)
        parsed.laterSignals.push(...kill.signals)
        realTime.later ||= kill.signals.length === 0
      }
    }
    // A heredoc's lines (`<<EOF`, `3<<EOF`, `<<<`) are data.
    if (segment.some((word) => word.text.includes("<<"))) {
      parsed.lastIsKill = false
      break
    }
    if (!run || !QUICK_PROGRAMS.has(run.program)) quickSoFar = false
  }
  if (realTime.now) parsed.signals = []
  if (realTime.later) parsed.laterSignals = []
  if (parsed.lastIsKill) parsed.kills.at(-1)!.last = true
  return found ? parsed : undefined
}

function emptyKill(leading: boolean): ParsedKill {
  return { kills: [], pids: [], names: [], signals: [], laterPids: [], laterNames: [], laterSignals: [], unresolved: false, leading, lastIsKill: false }
}

function parseKillSegment(program: string, args: Word[], viaXargs: boolean, parsed: ParsedKill): boolean {
  const texts = args.map((arg) => arg.text)
  if (texts.some((text) => NOT_A_KILL.has(text))) return false
  if (program === "fuser") {
    if (!texts.some((text) => /^-[a-zA-Z]*k/.test(text) || text === "--kill")) return false
    const fuserSignal = texts.map(signalOption).find((name) => name !== undefined)
    if (fuserSignal !== undefined && signalKind(fuserSignal) === "zero") return false
    if (!takeSignal(fuserSignal, SIGKILL, parsed)) return false
    parsed.unresolved = true
    return true
  }
  let signal: string | undefined
  const operands: Word[] = []
  let resolvable = !viaXargs
  const named = program === "killall" ? "killall" : "pkill"
  const name: Omit<KillName, "pattern"> = { program: named, full: false, exact: false, regex: named === "pkill", ignoreCase: false }
  let rest = false
  for (let i = 0; i < args.length; i++) {
    const text = texts[i]!
    if (!rest && text === "--") { rest = true; continue }
    // After `--`, an operand, or kill's signal, kill's `-123` is a process group.
    if (rest || !text.startsWith("-") || text === "-" || (program === "kill" && i > 0 && /^-\d+$/.test(text))) {
      rest = true
      operands.push(args[i]!)
      continue
    }
    if (text === "--signal") { signal = texts[++i] ?? ""; continue }
    if (text.startsWith("--signal=")) { signal = text.slice("--signal=".length); continue }
    const short = /^-([sn])(.*)$/.exec(text)
    if (short && (program === "kill" || (program === "killall" && short[1] === "s"))) {
      signal = short[2] || (texts[++i] ?? "")
      continue
    }
    if (program === "kill") {
      // Only a first `-N` / `-NAME` is a signal; kill's other options take no operand.
      if (i === 0 && /^-[A-Za-z0-9+-]+$/.test(text)) signal = text.slice(1)
      continue
    }
    const signalName = signalOption(text)
    if (signalName !== undefined) { signal = signalName; continue }
    const options = NAME_FLAGS[named]
    if (options.withValue.includes(text)) { i++; continue }
    if (text.startsWith("--")) {
      if (!options.long.includes(text)) resolvable = false
      else if (text === "--full") name.full = true
      else if (text === "--exact") name.exact = true
      else if (text === "--ignore-case") name.ignoreCase = true
      else if (text === "--regexp") name.regex = true
      continue
    }
    for (const flag of text.slice(1)) {
      if (!options.flags.includes(flag)) resolvable = false
      else if (flag === "f") name.full = true
      else if (flag === "x" || (flag === "e" && named === "killall")) name.exact = true
      else if (flag === "i" || flag === "I") name.ignoreCase = true
      else if (flag === "r") name.regex = true
    }
  }
  // Signal 0 kills nothing, and an unknown signal makes the command fail.
  if (signal !== undefined && signalKind(signal) !== "signal") return false
  if (!takeSignal(signal, SIGTERM, parsed)) return false
  if (viaXargs || operands.length === 0) parsed.unresolved = true
  for (const operand of operands) {
    if (program === "kill") {
      const pid = Number(operand.text.replace(/^-/, ""))
      if (!operand.dynamic && /^-?\d+$/.test(operand.text) && Number.isSafeInteger(pid) && pid > 1) parsed.pids.push(pid)
      else parsed.unresolved = true
    } else if (resolvable && !operand.dynamic && (!name.regex || (PORTABLE_PATTERN.test(operand.text) && !operand.text.includes("(?")))) {
      parsed.names.push({ ...name, pattern: operand.text })
    } else parsed.unresolved = true
  }
  return true
}

/** Records the signal a kill sends; false for one that doesn't end a process (`-STOP`, `-CONT`). */
function takeSignal(signal: string | undefined, fallback: number, parsed: ParsedKill): boolean {
  const number = signal === undefined ? fallback : signalNumber(signal)
  if (number !== undefined && NON_ENDING_SIGNALS.has(number)) return false
  parsed.signals = number === undefined ? [] : [number]
  return true
}

function nameMatches(name: KillName, pid: number): boolean {
  try {
    const comm = readFileSync(`/proc/${pid}/comm`, "utf8").replace(/\n$/, "")
    const argv = name.full || name.program === "killall" ? readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean) : []
    if (name.program === "killall" && !name.regex) {
      const wanted = name.ignoreCase ? name.pattern.toLowerCase() : name.pattern
      const fold = (text: string) => name.ignoreCase ? text.toLowerCase() : text
      if (wanted.length <= 15) return fold(comm) === wanted
      // A name longer than comm's 15 bytes matches the command's own name, or with -e only that.
      return fold(basename(argv[0] ?? "")) === wanted || (!name.exact && fold(comm) === wanted.slice(0, 15))
    }
    const subject = name.full ? argv.join(" ") : comm
    const pattern = name.exact ? `^(?:${name.pattern})$` : name.pattern
    return new RegExp(pattern, name.ignoreCase ? "i" : "").test(subject)
  } catch {
    return false
  }
}

type ProcStat = { ppid: number; pgrp: number; session: number }

function procStat(pid: number): ProcStat | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
    return { ppid: Number(fields[1]), pgrp: Number(fields[2]), session: Number(fields[3]) }
  } catch {
    return undefined
  }
}

function processTable(): Map<number, ProcStat> {
  const table = new Map<number, ProcStat>()
  let entries: string[] = []
  try {
    entries = readdirSync("/proc")
  } catch {
    return table
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const stat = procStat(Number(entry))
    if (stat) table.set(Number(entry), stat)
  }
  return table
}

// Linux only: elsewhere no pid matches, and only a death by signal right after the kill counts.
function descendsFrom(pid: number, ancestor: number, stat: (pid: number) => ProcStat | undefined = procStat): boolean {
  const start = stat(pid)
  if (!start) return false
  // A daemonized descendant's parent is init, but it keeps the payload's process group and session.
  for (const from of new Set([pid, start.pgrp, start.session])) {
    let current = from
    for (let depth = 0; depth < 64 && current > 1; depth++) {
      if (current === ancestor) return true
      const next = current === pid ? start : stat(current)
      if (!next) break
      current = next.ppid
    }
  }
  return false
}

function post(notifier: BackgroundShellNotifier, watch: WatchedShell, stopped = false): void {
  const end = watch.end!
  const session = state.sessions.get(watch.sessionID)
  const note: BackgroundShellNote = {
    sessionID: watch.sessionID,
    text: backgroundShellNoteText(watch, end, readOutputTail(watch)),
    description: watch.command,
    metadata: {
      source: "shell",
      shellID: String(watch.shellId),
      state: end.state,
      ...(end.exitCode !== undefined ? { exit: end.exitCode } : {}),
      file: watch.file,
    },
    // After a Stop, or for a shell the agent stopped itself, the note waits for the next message instead of starting a turn.
    ...(stopped || (session && !session.busy && session.stopped) ? { resume: false } : {}),
  }
  trace(
    `background shell: posting note shell=${watch.shellId} sessionID=${watch.sessionID} state=${end.state} ` +
      `exit=${end.exitCode ?? "-"} resume=${note.resume ?? true} stoppedByAgent=${stopped}`,
  )
  // The watch stays until the post settles, so a deleted session or a newer watch of the record wins over a retry.
  watch.posting = true
  notifier(note).then(() => unwatch(watch), (error: unknown) => {
    trace(`background shell: note for shell=${watch.shellId} failed: ${error instanceof Error ? error.message : String(error)}`)
    watch.posting = false
    // Once more on the next poll: a note held through a turn has no other copy.
    if (watch.retried) unwatch(watch)
    watch.retried = true
  })
}

function unwatch(watch: WatchedShell): void {
  if (state.watches.get(watch.file) !== watch) return
  state.watches.delete(watch.file)
  if (![...state.watches.values()].some((other) => other.sessionID === watch.sessionID)) state.sessions.delete(watch.sessionID)
  if (state.watches.size === 0) stopTimer()
}

function probe(watch: WatchedShell, now: number): void {
  const supervised = processExists(watch.pid)
  // The supervisor writes the final status before the footer; wait for the footer while it lives.
  const end = readTerminalEnd(watch.file, !supervised)
  if (end) {
    watch.end = end
    watch.endSeenAt = now
    return
  }
  if (supervised) {
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

const FINAL_STATUS = /^status: (succeeded|failed|aborted) *$/m
// A lost supervisor's footer has `exit_code: unknown` and no `elapsed_ms`.
const FOOTER_BODY = "exit_code: (-?\\d+|unknown)\\n(?:elapsed_ms: (\\d+)\\n)?ended_at: [^\\n]*\\n(output_storage_failed: true\\n)?---\\n"
const FOOTER = new RegExp(`\\n---\\n${FOOTER_BODY}`, "g")
const FOOTER_OPENING = "\n---\nexit_code: "
const FOOTER_AT_START = new RegExp(`^\\n---\\n${FOOTER_BODY}`)

function readTerminalEnd(file: string, footerOptional: boolean): ShellEnd | undefined {
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
    if (!footer && !footerOptional) return undefined
    if (footer && footer.exitCode === undefined) return { state: "error", status }
    return {
      state: status === "aborted" ? "cancelled" : "completed",
      status,
      ...(footer ? { exitCode: footer.exitCode, elapsedMs: footer.elapsedMs } : {}),
      ...(footer?.storageFailed ? { storageFailed: true } : {}),
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

type Footer = { index: number; end: number; exitCode?: number; elapsedMs?: number; storageFailed: boolean }

function lastFooter(text: string): Footer | undefined {
  let last: Footer | undefined
  for (const match of text.matchAll(FOOTER)) {
    last = {
      index: match.index!,
      end: match.index! + match[0].length,
      ...(match[1] === "unknown" ? {} : { exitCode: Number(match[1]) }),
      ...(match[2] === undefined ? {} : { elapsedMs: Number(match[2]) }),
      storageFailed: match[3] !== undefined,
    }
  }
  return last
}

function readOutputTail(watch: WatchedShell): { lines: string[]; omitted: boolean } {
  const fd = openPlain(watch.file)
  if (fd === undefined) return { lines: [], omitted: false }
  try {
    const size = fstatSync(fd).size
    const outputStart = readHeader(fd, size)?.end ?? 0
    const start = Math.max(outputStart, size - TAIL_WINDOW_BYTES)
    let text = readRange(fd, start, size - start).toString("utf8")
    let omitted = start > outputStart
    const footer = lastFooter(text)
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
  watch: Pick<WatchedShell, "shellId" | "file" | "command" | "startedAt" | "endSeenAt">,
  end: ShellEnd,
  tail: { lines: string[]; omitted: boolean },
): string {
  const after = formatDuration(end.elapsedMs ?? (watch.endSeenAt ?? Date.now()) - watch.startedAt)
  const name = `Background shell ${watch.shellId}`
  const headline =
    end.state === "error"
      ? `${name} ended without reporting an exit code; its supervisor stopped before the command finished.`
      : end.state === "cancelled"
        ? `${name} was stopped after ${after}${end.exitCode !== undefined ? ` (exit code ${end.exitCode})` : ""}.`
        : end.exitCode === undefined
          ? `${name} has ${end.status === "failed" ? "failed" : "finished"} after ${after}.`
          : end.exitCode === 0
            ? `${name} finished with exit code 0 after ${after}.`
            : `${name} failed with exit code ${end.exitCode} after ${after}.`
  const storage = end.storageFailed ? ["Its output could not be stored completely."] : []
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
    `<shell id="${watch.shellId}" state="${end.state}" command="${attribute(watch.command)}">`,
    headline,
    ...storage,
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
  state.kills?.clear()
  state.supported = false
  state.manualPolling = options.manualPolling
}
