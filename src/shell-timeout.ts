import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path"

/** Cursor agent.v1 TimeoutBehavior enum values. */
export const CURSOR_TIMEOUT_CANCEL = 1
export const CURSOR_TIMEOUT_BACKGROUND = 2

const MAX_TRACKED_SHELL_CALLS = 512
const OPENCODE_TIMEOUT_GRACE_MS = 15_000
const POLL_INTERVAL_MS = 100
const BACKGROUND_MARKER = "__CURSOR_SHELL_BACKGROUND__"
const EXIT_MARKER = "__CURSOR_SHELL_EXIT__"
const TIMEOUT_MARKER = "__CURSOR_SHELL_TIMEOUT__"
/** Private marker for Cursor `background_shell_spawn_args` detach wrappers. */
export const BACKGROUND_SHELL_MARKER = "__CURSOR_BACKGROUND_SHELL__"

export type CursorShellPolicy = {
  command: string
  workingDirectory: string
  timeoutMs: number
  timeoutBehavior: number
  hardTimeoutMs?: number
  /** Immediate nohup detach for Cursor `background_shell_spawn_args`. */
  backgroundSpawn?: boolean
  /** Where a backgrounded command's Cursor terminal file goes. */
  terminal?: CursorTerminalTarget
}

/** The advertised `terminals_folder`, and the cwd and optional title shown in the terminal file header. */
export type CursorTerminalTarget = { folder: string; cwd: string; title?: string }

export type CursorShellOutcome =
  | { kind: "exit"; code: number }
  | { kind: "timeout"; timeoutMs: number }
  | {
      kind: "backgrounded"
      shellId: number
      pid: number
      command: string
      workingDirectory: string
      msToWait: number
      reason: 1
    }

type CursorShellEnvWrap = {
  env: Record<string, string>
  wrapperPath: string
  cleanup: () => void
}

// OpenCode 2 loads plugins in a separate module graph per project, so the
// provider registers a call in one copy of this module and the plugin hooks
// run in another. Keep per-call state in the process registry.
const SHELL_CALLS = Symbol.for("cursor-opencode-provider.shell-calls")
type ShellCallState = {
  policies: Map<string, CursorShellPolicy>
  outcomes: Map<string, CursorShellOutcome>
  /** callIDs that need shell.env injectors or a direct-command fallback. */
  pendingEnvWraps: Set<string>
  activeEnvWraps: Map<string, CursorShellEnvWrap>
}
const globals = globalThis as typeof globalThis & { [SHELL_CALLS]?: ShellCallState }
const { policies, outcomes, pendingEnvWraps, activeEnvWraps } = globals[SHELL_CALLS] ??= {
  policies: new Map(),
  outcomes: new Map(),
  pendingEnvWraps: new Set(),
  activeEnvWraps: new Map(),
}
let configuredShell: string | undefined

/** Track OpenCode's configured shell from the classic config hook. */
export function setCursorShellPath(shell: string | undefined): void {
  configuredShell = shell?.trim() || undefined
}

function executableOnPath(name: string): boolean {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return true
  }
  return false
}

/**
 * Mirror the relevant part of OpenCode Shell.acceptable(): fish/nu are denied,
 * then POSIX falls back to bash when installed and `/bin/sh` otherwise.
 */
export function resolveCursorShellKind(
  shell = configuredShell ?? process.env.SHELL,
): "bash" | "zsh" | "sh" | "dash" | "other" {
  let name = shell ? basename(shell).toLowerCase().replace(/\.exe$/, "") : ""
  if (name === "fish" || name === "nu" || !name) {
    name = executableOnPath("bash") ? "bash" : "sh"
  }
  if (name === "bash" || name === "zsh" || name === "sh" || name === "dash") return name
  return "other"
}

function remember<T>(map: Map<string, T>, key: string, value: T, onEvict?: (value: T) => void): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > MAX_TRACKED_SHELL_CALLS) {
    const oldest = map.keys().next().value as string | undefined
    if (!oldest) break
    const evicted = map.get(oldest)
    map.delete(oldest)
    if (evicted !== undefined && onEvict) onEvict(evicted)
  }
}

function finiteNonNegative(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(n) || n < 0) return undefined
  return Math.floor(n)
}

/** Exec result metadata naming where a backgrounded command's terminal file goes. */
export function terminalTargetMetadata(target: CursorTerminalTarget | undefined): Record<string, unknown> {
  if (!target) return {}
  return {
    terminals_folder: target.folder,
    terminal_cwd: target.cwd,
    ...(target.title ? { terminal_title: target.title } : {}),
  }
}

function terminalTargetFromMetadata(metadata: Record<string, unknown>): CursorTerminalTarget | undefined {
  const folder = metadata.terminals_folder
  if (typeof folder !== "string" || !folder) return undefined
  return {
    folder,
    cwd: typeof metadata.terminal_cwd === "string" ? metadata.terminal_cwd : "",
    ...(typeof metadata.terminal_title === "string" && metadata.terminal_title ? { title: metadata.terminal_title } : {}),
  }
}

export function shellPolicyFromMetadata(
  metadata: Record<string, unknown> | undefined,
): CursorShellPolicy | undefined {
  if (!metadata) return undefined
  const terminal = terminalTargetFromMetadata(metadata)
  if (metadata.background_shell_spawn === true) {
    return {
      command: typeof metadata.command === "string" ? metadata.command : "",
      workingDirectory:
        typeof metadata.working_directory === "string" ? metadata.working_directory : "",
      timeoutMs: 0,
      timeoutBehavior: 0,
      backgroundSpawn: true,
      ...(terminal ? { terminal } : {}),
    }
  }
  if (metadata.shell_stream !== true) return undefined
  const timeoutMs = finiteNonNegative(metadata.timeout_ms) ?? 30_000
  const timeoutBehavior = finiteNonNegative(metadata.timeout_behavior) ?? 0
  const hardTimeoutMs = finiteNonNegative(metadata.hard_timeout_ms)
  return {
    command: typeof metadata.command === "string" ? metadata.command : "",
    workingDirectory:
      typeof metadata.working_directory === "string" ? metadata.working_directory : "",
    timeoutMs,
    timeoutBehavior,
    ...(hardTimeoutMs !== undefined && hardTimeoutMs > 0 ? { hardTimeoutMs } : {}),
    ...(terminal ? { terminal } : {}),
  }
}

/** Register a Cursor shell request before OpenCode executes its emitted tool call. */
export function registerCursorShellCall(
  toolCallId: string,
  metadata: Record<string, unknown> | undefined,
): void {
  const policy = shellPolicyFromMetadata(metadata)
  if (!policy || !toolCallId.startsWith("cursor_")) return
  remember(policies, toolCallId, policy)
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function cursorQuoted(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`
}

/**
 * Runs a backgrounded command into Cursor CLI's terminal file layout:
 * `<folder>/<pid>.txt` with a `---` header, the output, then an exit footer,
 * after which the header's status is rewritten in place (fixed-width fields).
 * Cursor tells the model to read that file for the returned shell id, which is
 * the runner's pid (`nohup` execs it). The header's `running_for_ms` is
 * refreshed every 5 s like Cursor CLI's, by a ticker the runner stops before
 * its final rewrite. A TERM is forwarded to the command and escalated to KILL
 * after 3 s, so the footer is still written, with status `aborted`; one that
 * arrives before the command started keeps it from starting. The runner
 * removes its ready marker just before it starts the command. A waiting
 * wrapper's `$donef` stays until the wrapper removes it or is gone.
 */
const TERMINAL_RUNNER = [
  'f="$1/$$.txt"; cmd="$2"; cwdl="$3"; cmdl="$4"; titl="$5"; donef="$6"; waiter="$7"; ready="$8"; aborted=0; child=""',
  `stop_child() { kill -TERM "$child" 2>/dev/null; (sleep 3; kill -KILL "$child" 2>/dev/null) & }`,
  `trap 'aborted=1; [ -z "$child" ] || stop_child' TERM INT`,
  // Milliseconds where `date` has %N (GNU, busybox), else whole seconds.
  'now_ms() { t=$(date +%s%3N 2>/dev/null); case "$t" in ""|*[!0-9]*) t=$(( $(date +%s) * 1000 ));; esac; echo "$t"; }',
  'started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; t0=$(now_ms)',
  `hdr() { printf -- '---\\npid: %s\\n%s\\n%s\\n' "$$" "$cwdl" "$cmdl"; [ -z "$titl" ] || printf -- '%s\\n' "$titl"; printf -- 'status: %-9s\\nstarted_at: %s\\nrunning_for_ms: %-9s\\n---\\n' "$1" "$started" "$2"; }`,
  // The rewrite is in place, so the field must stay within its 9 characters.
  'elapsed() { total=$(( $(now_ms) - t0 )); ms=$total; [ "$ms" -le 999999999 ] || ms=999999999; }',
  // Until this rename, the file at this path may be an earlier runner's that had the same pid.
  'hdr running 0 >"$f.tmp" && mv -f "$f.tmp" "$f" || { rm -f -- "$f.tmp"; exit 1; }',
  // Through a pipe, the footer can wait like Cursor CLI's (up to 5 s) for descendants still writing.
  // The pipe is named after the ready marker, so a launcher that gives up on this runner knows what to remove.
  'reader=""; p="$ready.fifo"',
  'if [ "$aborted" = 0 ] && mkfifo -m 600 "$p" 2>/dev/null; then',
  // The runner opens both ends itself (through a brief read-write open, so neither blocks) and hands them out.
  '  if { command exec 4<>"$p" 5<"$p" 6>"$p" 4<&-; } 2>/dev/null; then cat <&5 >>"$f" 5<&- 6>&- & reader=$!; fi',
  '  rm -f -- "$p"',
  "fi",
  // Taking the ready marker claims the launch; a launcher that gave up on this runner took it first, and reads no file.
  'if [ "$aborted" = 0 ] && ! rm -- "$ready" 2>/dev/null; then rm -f -- "$f"; exit 1; fi',
  'if [ "$aborted" = 0 ]; then',
  '  if [ -n "$reader" ]; then sh -c "$cmd" >&6 2>&1 </dev/null 5<&- 6>&- & else sh -c "$cmd" >>"$f" 2>&1 </dev/null & fi',
  "  child=$!",
  // A TERM taken while the command was being started found no child to stop.
  '  [ "$aborted" = 0 ] || stop_child',
  "fi",
  "exec 4<&- 5<&- 6>&-",
  // A trapped TERM interrupts `wait` at once but lets a header rewrite in progress finish. It stops with a killed runner.
  `(trap 'exit 0' TERM; n=0; while kill -0 $$ 2>/dev/null; do sleep 1 & wait $!; n=$((n + 1)); if [ $((n % 5)) -eq 0 ]; then elapsed; hdr running "$ms" | dd of="$f" conv=notrunc 2>/dev/null; fi; done) </dev/null >/dev/null 2>&1 &`,
  "ticker=$!",
  'code=143',
  'while [ -n "$child" ]; do wait "$child"; code=$?; kill -0 "$child" 2>/dev/null || break; done',
  // A trapped TERM can interrupt `wait` after the shell already reaped the child; its status is still there.
  'if [ -n "$child" ] && [ "$code" -gt 128 ]; then wait "$child" 2>/dev/null; c=$?; [ "$c" -eq 127 ] || code=$c; fi',
  // Reaped: a later TERM must not reach a process that took its pid.
  'child=""',
  // A waiting wrapper ($donef) learns of the exit now, while the runner may still drain descendants' output.
  `[ -z "$donef" ] || printf -- '%s\\n' "$code" >>"$donef"`,
  'n=0; while [ -n "$reader" ] && kill -0 "$reader" 2>/dev/null && [ "$n" -lt 50 ]; do sleep 0.1; n=$((n + 1)); done',
  'kill -TERM "$ticker" 2>/dev/null; wait "$ticker" 2>/dev/null',
  "elapsed",
  'st=succeeded; [ "$code" -eq 0 ] || st=failed; [ "$aborted" = 0 ] || st=aborted',
  `end=$(wc -c <"$f" 2>/dev/null | tr -d ' ')`,
  `printf -- '\\n---\\nexit_code: %s\\nelapsed_ms: %s\\nended_at: %s\\n---\\n' "$code" "$total" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$f"`,
  'hdr "$st" "$ms" | dd of="$f" conv=notrunc 2>/dev/null',
  // Where the footer starts, since a descendant may append more after it. The runner writes no more to the file.
  `[ -z "$donef" ] || printf -- '%s\\n' "$end" >>"$donef"`,
  // The wrapper removes $donef once it has read it; after a handoff, or when it died, no one else does.
  '[ -z "$donef" ] || { n=0; while [ -e "$donef" ] && kill -0 "$waiter" 2>/dev/null && [ "$n" -lt 600 ]; do sleep 0.1; n=$((n + 1)); done; rm -f -- "$donef"; }',
  'exit "$code"',
].join("\n")

/** Output of a terminal file: without its header, and without the footer once finished. */
const TERMINAL_FINISHED_OUTPUT =
  `awk 'h < 2 { if ($0 == "---") h++; next } { line[++n] = $0 } END { if (n >= 5 && line[n] == "---" && line[n - 4] == "---" && line[n - 3] ~ /^exit_code: /) { n -= 5; if (n > 0 && line[n] == "") n-- } for (i = 1; i <= n; i++) print line[i] }' "$cursor_shell_log" 2>/dev/null`
/**
 * The runner reports the exit code and where its footer starts; bash's `wait`
 * on a disowned job reports 0. The footer is the fallback if it reported neither:
 * one at the end of the file, once the header's status is final (the runner
 * rewrites it after the footer), so output that looks like one does not count.
 */
const TERMINAL_RESULT = [
  'cursor_shell_known=""',
  `cursor_shell_footer_code="$(awk 'h < 2 { if ($0 == "---") h++; else if ($0 ~ /^status: (succeeded|failed|aborted) *$/) final = 1; next } { line[++n] = $0 } END { if (final && n >= 5 && line[n] == "---" && line[n - 4] == "---" && line[n - 3] ~ /^exit_code: -?[0-9]+$/) print substr(line[n - 3], 12) }' "$cursor_shell_log" 2>/dev/null)"`,
  'if [ -n "$cursor_shell_footer_code" ]; then cursor_shell_code=$cursor_shell_footer_code; cursor_shell_known=1; fi',
  'cursor_shell_reported="$(sed -n 1p "$cursor_shell_done" 2>/dev/null)"',
  'case "$cursor_shell_reported" in ""|*[!0-9]*) ;; *) cursor_shell_code=$cursor_shell_reported; cursor_shell_known=1;; esac',
  'cursor_shell_end="$(sed -n 2p "$cursor_shell_done" 2>/dev/null)"',
  'case "$cursor_shell_end" in',
  `  ""|*[!0-9]*) ${TERMINAL_FINISHED_OUTPUT};;`,
  `  *) head -c "$cursor_shell_end" "$cursor_shell_log" | awk 'h < 2 { if ($0 == "---") h++; next } { print }';;`,
  "esac",
  // A runner that never started the command, or was killed, reported nothing; `wait` may still say 0.
  `if [ -z "$cursor_shell_known" ]; then [ "$cursor_shell_code" -ne 0 ] || cursor_shell_code=1; ` +
    `if [ -n "$cursor_shell_stuck" ]; then echo "The shell runner did not start the command $cursor_shell_stuck."; ` +
    `else echo 'The shell runner exited before reporting the command'"'"'s exit status.'; fi; fi`,
]

/**
 * Start the runner in the background; sets `pidVar` to its pid and `cursor_shell_log` to its file.
 * First sets `cursor_shell_ready` and each of `controls` (a variable and a name) to a new private
 * file, in the terminals folder when the temporary directory is unavailable: the command must not
 * start without them. With `reportExit`, the runner reports the command's exit to `$cursor_shell_done`.
 */
function terminalRunnerLines(
  command: string,
  target: CursorTerminalTarget,
  pidVar: string,
  controls: Array<[variable: string, name: string]> = [],
  reportExit = false,
): string[] {
  const files: Array<[string, string]> = [["cursor_shell_ready", "ready"], ...controls]
  return [
    `bg_dir=${shellQuote(target.folder)}`,
    // A terminals folder it cannot write (a read-only cache) gives way to a temporary one, so the command still runs.
    'mkdir -p "$bg_dir" 2>/dev/null && [ -w "$bg_dir" ] && [ -x "$bg_dir" ] || bg_dir="$(mktemp -d "${TMPDIR:-/tmp}/cursor-opencode-terminals.XXXXXX")" || exit 1',
    files.map(([variable]) => `${variable}=""`).join("; "),
    files
      .map(([variable, name]) =>
        `${variable}="$(mktemp "\${TMPDIR:-/tmp}/cursor-opencode-shell-${name}.XXXXXX" 2>/dev/null || mktemp "$bg_dir/.cursor-opencode-shell-${name}.XXXXXX")"`)
      .join(" && ") +
      ` || { rm -f -- ${files.map(([variable]) => `"$${variable}"`).join(" ")} 2>/dev/null; ` +
      `[ "$bg_dir" = ${shellQuote(target.folder)} ] || rmdir -- "$bg_dir" 2>/dev/null; exit 1; }`,
    `nohup sh -c ${shellQuote(TERMINAL_RUNNER)} cursor-shell "$bg_dir" ${shellQuote(command)} ` +
      `${shellQuote(`cwd: ${cursorQuoted(target.cwd)}`)} ${shellQuote(`command: ${cursorQuoted(command)}`)} ` +
      `${shellQuote(target.title ? `title: ${cursorQuoted(target.title)}` : "")} ` +
      `${reportExit ? '"$cursor_shell_done" "$$"' : "'' ''"} "$cursor_shell_ready" >/dev/null 2>&1 </dev/null &`,
    `${pidVar}=$!`,
    `cursor_shell_log="$bg_dir/$${pidVar}.txt"`,
  ]
}

/**
 * Cursor may read the terminal file as soon as it learns the shell id. The runner takes its ready
 * marker once its header is in place, just before it starts the command; that normally takes
 * milliseconds. One that has not after 10 s, or by the hard timeout (`$cursor_shell_status` set), is
 * stuck (on a hung filesystem, say), so the launcher takes the marker itself, which keeps the runner
 * from starting the command; whichever takes the marker first decides. It then stops the runner,
 * kills its children (a `mv` or `mkfifo` that would otherwise finish later) and the runner, and
 * removes what they may have made. Leaves `cursor_shell_started` empty when the runner did not take
 * the marker, and sets `cursor_shell_stuck` to how long the launcher waited when it gave up.
 */
function awaitTerminalHeader(pidVar: string): string {
  const pid = `"$${pidVar}"`
  return [
    // Each round sleeps at least 10 ms, so at least 10 s pass.
    'cursor_shell_stuck=""; cursor_shell_wait=0',
    `while kill -0 ${pid} 2>/dev/null && [ -e "$cursor_shell_ready" ] && [ ! -s "$cursor_shell_status" ]; do ` +
      `if [ "$cursor_shell_wait" -ge 1000 ]; then cursor_shell_stuck='within 10 s'; break; fi; ` +
      "sleep 0.01; cursor_shell_wait=$((cursor_shell_wait + 1)); done",
    `[ ! -s "$cursor_shell_status" ] || cursor_shell_stuck='before its hard timeout'`,
    "cursor_shell_started=1",
    'if rm -- "$cursor_shell_ready" 2>/dev/null || [ -e "$cursor_shell_ready" ]; then cursor_shell_started=""; ' +
      `if kill -0 ${pid} 2>/dev/null; then kill -STOP ${pid} 2>/dev/null; pkill -KILL -P ${pid} 2>/dev/null; kill -KILL ${pid} 2>/dev/null; ` +
      'rm -f -- "$cursor_shell_log.tmp" "$cursor_shell_log" "$cursor_shell_ready.fifo"; fi; ' +
      'else cursor_shell_stuck=""; fi',
  ].join("; ")
}

const TERMINAL_FILE_NAME = /^\d+\.txt$/
const STALE_TERMINAL_FILE_MS = 7 * 24 * 60 * 60 * 1000
const sweptTerminalFolders = new Set<string>()

type TerminalsFolder = {
  /** A path to `name` in the opened folder. */
  entry(name: string): string
  /** Whether names still resolve in the opened folder. */
  intact(): boolean
}

/**
 * Runs `use` on a terminals folder opened without following a link. On Linux names resolve
 * through the folder's descriptor, so swapping the folder for a link afterwards cannot redirect
 * them; elsewhere they resolve by path, and `intact` checks the path still names that folder.
 * Throws the folder's open error.
 */
function withTerminalsFolder<T>(folder: string, use: (opened: TerminalsFolder) => T): T {
  const fd = openSync(folder, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const viaDescriptor = process.platform === "linux" && existsSync("/proc/self/fd")
    const root = viaDescriptor ? `/proc/self/fd/${fd}` : folder
    const opened = fstatSync(fd)
    return use({
      entry: (name) => join(root, name),
      intact: () => {
        if (viaDescriptor) return true
        try {
          const current = lstatSync(folder)
          return current.isDirectory() && current.dev === opened.dev && current.ino === opened.ino
        } catch {
          return false
        }
      },
    })
  } finally {
    closeSync(fd)
  }
}

/**
 * Opens a terminal file read-only, following a link at neither the folder nor the file.
 * Throws the open error: `ENOENT` when the folder or the file does not exist.
 */
export function openTerminalFile(file: string): number {
  return withTerminalsFolder(dirname(file), (folder) => {
    const fd = openSync(folder.entry(basename(file)), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    if (folder.intact()) return fd
    closeSync(fd)
    throw Object.assign(new Error(`terminals folder changed while opening ${file}`), { code: "ESTALE" })
  })
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as { code?: string }).code === "EPERM"
  }
}

/**
 * Remove terminal files untouched for a week, once per folder per process. A runner replaces
 * a stale file of its own pid, so one whose pid a process has is left alone: a runner taking
 * the pid after that check would have to start up before the very next call removes the file.
 */
export function sweepStaleTerminalFiles(folder: string, now = Date.now()): void {
  if (sweptTerminalFolders.has(folder)) return
  sweptTerminalFolders.add(folder)
  try {
    withTerminalsFolder(folder, (opened) => {
      for (const name of readdirSync(opened.entry("."))) {
        if (!TERMINAL_FILE_NAME.test(name)) continue
        const file = opened.entry(name)
        try {
          const stat = lstatSync(file)
          if (!stat.isFile() || now - stat.mtimeMs <= STALE_TERMINAL_FILE_MS || !opened.intact()) continue
          if (!processExists(Number.parseInt(name, 10))) unlinkSync(file)
        } catch {
          // best-effort cleanup
        }
      }
    })
  } catch {
    // best-effort cleanup
  }
}

/**
 * F11 / soft-background helper.
 *
 * Run a Cursor soft-background command for its foreground window, then leave
 * it detached (`nohup`) if still alive. The sentinel is removed by the after
 * hook before OpenCode stores/renders the result.
 *
 * This approximates Cursor's TIMEOUT_BACKGROUND semantics through OpenCode's
 * foreground-only bash tool. Residual: after OpenCode returns, the child (and
 * optional hard-timeout watchdog) may still be running; this provider does not
 * reap leftover processes — cleanup is left to the user / OS.
 */
export function buildSoftBackgroundCommand(policy: CursorShellPolicy): string {
  const polls = Math.ceil(policy.timeoutMs / POLL_INTERVAL_MS)
  const hardPolls = policy.hardTimeoutMs !== undefined
    ? Math.max(1, Math.ceil(policy.hardTimeoutMs / POLL_INTERVAL_MS))
    : undefined
  const terminal = policy.terminal
  // The command has exited once the terminal runner reports it, even while the runner still drains its output.
  const lines = terminal
    ? terminalRunnerLines(policy.command, terminal, "cursor_shell_pid", [
        ["cursor_shell_done", "done"],
        ...(hardPolls !== undefined ? [["cursor_shell_status", "status"] as [string, string]] : []),
      ], true)
    : [
        'cursor_shell_log="$(mktemp "${TMPDIR:-/tmp}/cursor-opencode-shell.XXXXXX")" || exit 1',
        ...(hardPolls !== undefined
          ? ['cursor_shell_status="$(mktemp "${TMPDIR:-/tmp}/cursor-opencode-shell-status.XXXXXX")" || { rm -f -- "$cursor_shell_log"; exit 1; }']
          : []),
        `nohup sh -c ${shellQuote(policy.command)} >"$cursor_shell_log" 2>&1 </dev/null &`,
        "cursor_shell_pid=$!",
        'cursor_shell_done=""',
      ]
  // The terminal runner escalates a TERM itself; a KILL would leave its file without a footer.
  const escalate = terminal ? "" : ' sleep 3; kill -KILL "$2" 2>/dev/null;'
  if (hardPolls !== undefined) {
    lines.push(
      // The wrapper ($4) kills the watchdog once it has read the status file, and then removes it. After a
      // handoff, or when the wrapper died, no one else does. A TERM is the wrapper's, or a kill of them all.
      `nohup sh -c 'trap '"'"'rm -f -- "$3"; exit 0'"'"' TERM INT; cursor_hard_poll=0; while [ "$cursor_hard_poll" -lt "$1" ] && kill -0 "$2" 2>/dev/null && [ ! -s "$5" ]; do sleep ${POLL_INTERVAL_MS / 1000}; cursor_hard_poll=$((cursor_hard_poll + 1)); done; if kill -0 "$2" 2>/dev/null && [ ! -s "$5" ]; then printf timeout >"$3"; kill -TERM "$2" 2>/dev/null;${escalate} fi; n=0; while [ -e "$3" ] && kill -0 "$4" 2>/dev/null && [ "$n" -lt 600 ]; do sleep 0.1; n=$((n + 1)); done; rm -f -- "$3"' cursor-shell-watchdog ${hardPolls} "$cursor_shell_pid" "$cursor_shell_status" "$$" "$cursor_shell_done" >/dev/null 2>&1 </dev/null &`,
      "cursor_shell_watchdog_pid=$!",
    )
  } else {
    lines.push('cursor_shell_status=""', 'cursor_shell_watchdog_pid=""')
  }
  lines.push(
    // Avoid interactive job-control noise ("Terminated: 15 …") when we later
    // reap the watchdog; that text can otherwise land after our private marker
    // and leak into OpenCode's bash UI.
    "set +m 2>/dev/null || true",
    'if [ -n "$cursor_shell_watchdog_pid" ]; then disown "$cursor_shell_watchdog_pid" 2>/dev/null || true; fi',
    'disown "$cursor_shell_pid" 2>/dev/null || true',
    "cursor_shell_poll=0",
    // With a terminal file, a hard timeout ends the window too: a runner stuck starting up defers the TERM.
    `while [ "$cursor_shell_poll" -lt ${polls} ] && kill -0 "$cursor_shell_pid" 2>/dev/null && [ ! -s "$cursor_shell_done" ]${terminal ? ' && [ ! -s "$cursor_shell_status" ]' : ""}; do`,
    `  sleep ${POLL_INTERVAL_MS / 1000}`,
    "  cursor_shell_poll=$((cursor_shell_poll + 1))",
    "done",
    'cursor_shell_started=""; cursor_shell_stuck=""',
    'if kill -0 "$cursor_shell_pid" 2>/dev/null && [ ! -s "$cursor_shell_done" ]; then',
    terminal ? `  ${awaitTerminalHeader("cursor_shell_pid")}` : "  cursor_shell_started=1",
    "fi",
    // A runner that exited before its header falls through to report that it never ran the command.
    ...(terminal
      ? [
          // The runner reports the exit before it writes the footer, so without a report after this
          // count, the footer is not in these bytes; with one, the command has ended after all.
          'if [ -n "$cursor_shell_started" ] && [ ! -s "$cursor_shell_status" ]; then',
          `  cursor_shell_size=$(wc -c <"$cursor_shell_log" 2>/dev/null | tr -d ' ')`,
          '  if [ -n "$cursor_shell_size" ] && [ ! -s "$cursor_shell_done" ]; then',
          // The command may be between the writes of one character; its rest is in the file later.
          `    cursor_shell_cut=$(head -c "$cursor_shell_size" "$cursor_shell_log" | tail -c 3 | od -An -v -tu1 | awk '{ for (i = 1; i <= NF; i++) b[++n] = $i + 0 } END { for (i = n; i > 0; i--) { if (b[i] < 128) break; if (b[i] >= 192) { need = b[i] >= 240 ? 4 : (b[i] >= 224 ? 3 : 2); if (n - i + 1 < need) print n - i + 1; break } } }')`,
          '    case "$cursor_shell_cut" in [123]) cursor_shell_size=$((cursor_shell_size - cursor_shell_cut));; esac',
          `    head -c "$cursor_shell_size" "$cursor_shell_log" | awk 'h < 2 { if ($0 == "---") h++; next } { print }'`,
          // The runner and the watchdog remove the control files once this wrapper is gone.
          `    printf '\n${BACKGROUND_MARKER}%s:%s\n' "$cursor_shell_pid" "$cursor_shell_log"`,
          "    exit 0",
          "  fi",
          "fi",
          // Like Cursor CLI's, the result waits for descendants still writing (the runner gives them 5 s),
          // until the runner says where its footer starts. It then waits for this wrapper to read that,
          // so `wait` (which blocks under dash) is only for a runner gone without a report.
          'cursor_shell_drain=0; while kill -0 "$cursor_shell_pid" 2>/dev/null && [ -z "$(sed -n 2p "$cursor_shell_done" 2>/dev/null)" ] && [ "$cursor_shell_drain" -lt 100 ]; do sleep 0.1; cursor_shell_drain=$((cursor_shell_drain + 1)); done',
          'cursor_shell_code=1; kill -0 "$cursor_shell_pid" 2>/dev/null || { wait "$cursor_shell_pid" 2>/dev/null; cursor_shell_code=$?; }',
        ]
      : [
          'if [ -n "$cursor_shell_started" ]; then',
          '  cat "$cursor_shell_log"',
          `  printf '\n${BACKGROUND_MARKER}%s:%s\n' "$cursor_shell_pid" "$cursor_shell_log"`,
          "  exit 0",
          "fi",
          'wait "$cursor_shell_pid" 2>/dev/null',
          "cursor_shell_code=$?",
        ]),
    ...(terminal ? TERMINAL_RESULT : ['cat "$cursor_shell_log"']),
    'if [ -n "$cursor_shell_status" ] && [ "$(cat "$cursor_shell_status" 2>/dev/null)" = timeout ]; then',
    // Reap the watchdog before printing the private marker so any residual
    // shell diagnostics cannot trail the sentinel.
    '  if [ -n "$cursor_shell_watchdog_pid" ]; then kill "$cursor_shell_watchdog_pid" 2>/dev/null || true; wait "$cursor_shell_watchdog_pid" 2>/dev/null || true; fi',
    `  printf '\n${TIMEOUT_MARKER}%s\n' ${policy.hardTimeoutMs ?? policy.timeoutMs}`,
    "else",
    '  if [ -n "$cursor_shell_watchdog_pid" ]; then kill "$cursor_shell_watchdog_pid" 2>/dev/null || true; wait "$cursor_shell_watchdog_pid" 2>/dev/null || true; fi',
    `  printf '\n${EXIT_MARKER}%s\n' "$cursor_shell_code"`,
    "fi",
    'rm -f -- "$cursor_shell_log"',
    ...(terminal ? ['if [ -n "$cursor_shell_ready" ]; then rm -f -- "$cursor_shell_ready" "$cursor_shell_ready.fifo"; fi'] : []),
    'if [ -n "$cursor_shell_status" ]; then rm -f -- "$cursor_shell_status"; fi',
    'if [ -n "$cursor_shell_done" ]; then rm -f -- "$cursor_shell_done"; fi',
    // Last: a temporary terminals folder may hold the control files too.
    ...(terminal ? [`[ "$bg_dir" = ${shellQuote(terminal.folder)} ] || rmdir -- "$bg_dir" 2>/dev/null`] : []),
  )
  return lines.join("\n")
}

/**
 * F11 / background_shell_spawn_args helper.
 *
 * OpenCode's bash tool is foreground-only. Detach the requested command inside
 * that one foreground call (`nohup … &`) and print a private marker containing
 * the spawned PID and log path. With stdin and all output redirected, the host
 * shell can return immediately instead of retaining OpenCode's tool pipe.
 *
 * Residual: the detached child is not reaped by this provider after OpenCode
 * completes the tool call; cleanup is left to the user / OS.
 */
export function buildBackgroundShellCommand(command: string, terminal?: CursorTerminalTarget): string {
  if (terminal) {
    return [
      ...terminalRunnerLines(command, terminal, "bg_pid"),
      // Else bash reports a runner it kills, script and all, on stderr.
      'disown "$bg_pid" 2>/dev/null || true',
      'cursor_shell_status=""',
      awaitTerminalHeader("bg_pid"),
      // No one will be told of the file; a runner that never started the command may have left its header there.
      'if [ -z "$cursor_shell_started" ]; then rm -f -- "$cursor_shell_log" "$cursor_shell_ready.fifo"; ' +
        `if [ -n "$cursor_shell_stuck" ]; then echo "The background shell did not start the command $cursor_shell_stuck." >&2; ` +
        `else echo 'The background shell exited before it started the command.' >&2; fi; exit 1; fi`,
      `printf '${BACKGROUND_SHELL_MARKER}%s:%s\\n' "$bg_pid" "$cursor_shell_log"`,
    ].join("\n")
  }
  return [
    'bg_log="$(mktemp "${TMPDIR:-/tmp}/cursor-opencode-bg.XXXXXX")" || exit 1',
    `nohup sh -c ${shellQuote(command)} >"$bg_log" 2>&1 </dev/null &`,
    "bg_pid=$!",
    `printf '${BACKGROUND_SHELL_MARKER}%s:%s\\n' "$bg_pid" "$bg_log"`,
  ].join("\n")
}

function wrapperBodyForPolicy(policy: CursorShellPolicy): string | undefined {
  if (policy.backgroundSpawn) return buildBackgroundShellCommand(policy.command, policy.terminal)
  if (policy.timeoutBehavior === CURSOR_TIMEOUT_BACKGROUND) return buildSoftBackgroundCommand(policy)
  return undefined
}

function writeShellEnvInjector(wrapperBody: string): CursorShellEnvWrap {
  const dir = mkdtempSync(join(tmpdir(), "cursor-opencode-wrap-"))
  const wrapperPath = join(dir, "wrapper.sh")
  const bashEnvPath = join(dir, "bashenv.sh")
  const zshenvPath = join(dir, ".zshenv")
  writeFileSync(wrapperPath, `${wrapperBody}\n`, { mode: 0o700 })
  // Sourced by bash (BASH_ENV) or zsh (.zshenv via ZDOTDIR). `exec`
  // replaces the host shell before OpenCode's `-c <original>` body runs.
  const injector = [
    "unset BASH_ENV ZDOTDIR ENV CURSOR_OPENCODE_WRAP_ACTIVE",
    `exec /bin/sh ${shellQuote(wrapperPath)}`,
    "",
  ].join("\n")
  writeFileSync(bashEnvPath, injector, { mode: 0o600 })
  writeFileSync(zshenvPath, injector, { mode: 0o600 })
  return {
    wrapperPath,
    env: {
      BASH_ENV: bashEnvPath,
      ZDOTDIR: dir,
    },
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // best-effort temp cleanup
      }
    },
  }
}

function ensureShellEnvWrap(
  toolCallId: string,
  policy: CursorShellPolicy,
): CursorShellEnvWrap | undefined {
  const existing = activeEnvWraps.get(toolCallId)
  if (existing) return existing
  const wrapperBody = wrapperBodyForPolicy(policy)
  if (!wrapperBody) return undefined
  const wrap = writeShellEnvInjector(wrapperBody)
  remember(activeEnvWraps, toolCallId, wrap, (evicted) => evicted.cleanup())
  return wrap
}

/**
 * Prepare OpenCode Bash args before execution when Cursor requested wrapping.
 *
 * bash/zsh source the shell.env injector, so the original command remains in
 * OpenCode's permission/UI state. sh/dash ignore those startup variables; for
 * them, use a short `exec wrapper.sh` command that contains no user payload.
 *
 * background_shell_spawn may already contain the inline non-plugin fallback.
 * The classic hook replaces it with the original command (bash/zsh) or the
 * shorter wrapper-file command (sh/dash), avoiding duplicate execution.
 */
export function prepareCursorShellArgs(
  toolCallId: string,
  args: Record<string, unknown>,
  options: { preferWrapperCommand?: boolean } = {},
): void {
  const policy = policies.get(toolCallId)
  if (!policy) return
  if (!policy.backgroundSpawn && policy.timeoutBehavior !== CURSOR_TIMEOUT_BACKGROUND) return

  pendingEnvWraps.add(toolCallId)
  if (!policy.backgroundSpawn) {
    // The wrapper returns just after Cursor's foreground window. OpenCode's own
    // timeout is only an outer safety net and must not win the race.
    args.timeout = Math.max(OPENCODE_TIMEOUT_GRACE_MS, policy.timeoutMs + OPENCODE_TIMEOUT_GRACE_MS)
  }

  const shellKind = resolveCursorShellKind()
  // OpenCode 2.0 has no `shell.env` hook, so bash/zsh cannot be wrapped by
  // sourcing an injector. Callers there opt into the wrapper-file command —
  // the same mechanism sh/dash already use — which needs no env injection.
  const envInjectable =
    !options.preferWrapperCommand && (shellKind === "bash" || shellKind === "zsh")
  if (process.platform === "win32" || envInjectable) {
    // Native Windows PowerShell/cmd wrapping remains unsupported; do not emit
    // a POSIX /bin/sh command there. Git Bash still uses the env path above.
    args.command = policy.command
    return
  }

  const wrap = ensureShellEnvWrap(toolCallId, policy)
  if (wrap) args.command = `exec /bin/sh ${shellQuote(wrap.wrapperPath)}`
}

/** Restore the model-facing command in OpenCode's completed tool title. */
export function cursorShellOriginalCommand(toolCallId: string): string | undefined {
  return policies.get(toolCallId)?.command || undefined
}

/** Drop injector temp files for a finished/abandoned Cursor shell call. */
export function releaseCursorShellEnv(toolCallId: string): void {
  pendingEnvWraps.delete(toolCallId)
  const active = activeEnvWraps.get(toolCallId)
  if (!active) return
  activeEnvWraps.delete(toolCallId)
  active.cleanup()
}

/**
 * Env vars for OpenCode's shell.env hook. bash/zsh execute the injector; the
 * same materialized wrapper backs the direct-command sh/dash fallback.
 */
export function cursorShellEnvForCall(toolCallId: string | undefined): Record<string, string> | undefined {
  if (typeof toolCallId !== "string" || !toolCallId || !pendingEnvWraps.has(toolCallId)) return undefined
  const policy = policies.get(toolCallId)
  if (!policy) return undefined
  const wrap = ensureShellEnvWrap(toolCallId, policy)
  if (!wrap) return undefined
  pendingEnvWraps.delete(toolCallId)
  return wrap.env
}

/**
 * OpenCode 2.0 `shell.create.before` has no tool-call id. Correlate the pending
 * wrap by command + working directory when possible, then fall back to the
 * original command for hosts that omit the directory.
 */
export function cursorShellEnvForCommand(
  command: string | undefined,
  workingDirectory?: string,
): Record<string, string> | undefined {
  if (typeof command !== "string" || !command) return undefined
  const directory = workingDirectory && isAbsolute(workingDirectory) ? resolve(workingDirectory) : undefined
  if (directory) {
    for (const [id, policy] of policies) {
      if (!pendingEnvWraps.has(id)) continue
      if (policy.command === command && policyDirectory(policy) === directory) {
        return cursorShellEnvForCall(id)
      }
    }
  }
  for (const [id, policy] of policies) {
    if (!pendingEnvWraps.has(id) || policy.command !== command) continue
    // The registry is process-wide: a call for another directory may be another project's.
    if (directory && policyDirectory(policy) !== undefined) continue
    return cursorShellEnvForCall(id)
  }
  return undefined
}

function policyDirectory(policy: CursorShellPolicy): string | undefined {
  // An omitted working_directory runs in the workspace root, which the terminal target records.
  const directory = policy.workingDirectory || policy.terminal?.cwd || ""
  return isAbsolute(directory) ? resolve(directory) : undefined
}

function withoutMarker(output: string, index: number): string {
  let clean = output.slice(0, index).replace(/[\t ]+$/gm, "").replace(/\n{2,}$/, "\n")
  if (clean.trim() === "" || clean.trim() === "(no output)") clean = ""
  return clean
}

/**
 * OpenCode only stores/renders text (`output` / `metadata.output`). Private
 * markers become typed Cursor outcomes, but stripping them alone can leave a
 * blank or partial bash bubble that looks like success. Append a short
 * user-facing status so the UI explains background handoff / timeout.
 */
function formatShellOutcomeDisplay(clean: string, outcome: CursorShellOutcome): string {
  let notice: string | undefined
  if (outcome.kind === "backgrounded") {
    notice = outcome.msToWait > 0
      ? `Still running in the background (pid ${outcome.pid}) after ${outcome.msToWait}ms.`
      : `Started in the background (pid ${outcome.pid}).`
  } else if (outcome.kind === "timeout") {
    notice = `Timed out after ${outcome.timeoutMs}ms.`
  }
  if (!notice) return clean
  if (!clean) return `${notice}\n`
  return clean.endsWith("\n") ? `${clean}${notice}\n` : `${clean}\n${notice}\n`
}

/**
 * Find the last private wrapper sentinel.
 *
 * Soft-background wrappers print the marker as the final intentional line, but
 * the host shell can still append job-control diagnostics afterwards (e.g.
 * "Terminated: 15 … nohup sh -c '…cursor-shell-watchdog…'"). Match the sentinel
 * on its own line and discard everything from that point to EOF.
 */
function lastPrivateMarker(
  output: string,
  marker: string,
  valuePattern: string,
): { index: number; values: string[] } | undefined {
  const re = new RegExp(`(?:^|\\r?\\n)(${marker}${valuePattern})`, "g")
  let match: RegExpExecArray | null
  let last: { index: number; values: string[] } | undefined
  while ((match = re.exec(output)) !== null) {
    if (match.index === undefined || match[1] === undefined) continue
    const index = match[0].startsWith("\r\n")
      ? match.index + 2
      : match[0].startsWith("\n")
        ? match.index + 1
        : match.index
    last = { index, values: match.slice(2) }
  }
  return last
}

function parseOpenCodeTimeout(output: string): { output: string; timeoutMs: number } | undefined {
  const closeTag = "</shell_metadata>"
  const closeAt = output.lastIndexOf(closeTag)
  if (closeAt === -1 || output.slice(closeAt + closeTag.length).trim() !== "") return undefined

  const header = /<shell_metadata>\r?\nshell tool terminated command after exceeding timeout (\d+) ms\./
  const match = header.exec(output.slice(0, closeAt))
  if (!match || match.index === undefined) return undefined
  return { output: withoutMarker(output, match.index), timeoutMs: Number(match[1]) }
}

function parseSoftBackgroundOutcome(
  output: string,
  policy: CursorShellPolicy | undefined,
): { output: string; outcome: CursorShellOutcome } | undefined {
  const background = lastPrivateMarker(output, BACKGROUND_MARKER, "(\\d+):([^\\r\\n]+)")
  if (background) {
    const pid = Number(background.values[0])
    if (Number.isSafeInteger(pid) && pid > 0 && pid <= 0xffff_ffff) {
      return {
        output: withoutMarker(output, background.index),
        outcome: {
          kind: "backgrounded",
          shellId: pid,
          pid,
          command: policy?.command ?? "",
          workingDirectory: policy?.workingDirectory || policy?.terminal?.cwd || "",
          msToWait: policy?.timeoutMs ?? 0,
          reason: 1,
        },
      }
    }
  }
  const timeout = lastPrivateMarker(output, TIMEOUT_MARKER, "(\\d+)")
  if (timeout) {
    return {
      output: withoutMarker(output, timeout.index),
      outcome: { kind: "timeout", timeoutMs: Number(timeout.values[0]) },
    }
  }
  const exit = lastPrivateMarker(output, EXIT_MARKER, "(-?\\d+)")
  if (exit) {
    return {
      output: withoutMarker(output, exit.index),
      outcome: { kind: "exit", code: Number(exit.values[0]) },
    }
  }
  return undefined
}

function parseBackgroundSpawnOutcome(
  output: string,
  policy: CursorShellPolicy | undefined,
): { output: string; outcome: CursorShellOutcome } | undefined {
  const match = lastPrivateMarker(output, BACKGROUND_SHELL_MARKER, "(\\d+):([^\\r\\n]+)")
  if (!match) return undefined
  const pid = Number(match.values[0])
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffff_ffff) return undefined
  return {
    output: withoutMarker(output, match.index),
    outcome: {
      kind: "backgrounded",
      shellId: pid,
      pid,
      command: policy?.command ?? "",
      workingDirectory: policy?.workingDirectory || policy?.terminal?.cwd || "",
      msToWait: 0,
      reason: 1,
    },
  }
}

/**
 * Strip private wrapper sentinels / OpenCode timeout envelopes for display.
 * Does not record outcomes — use {@link captureCursorShellResult} for that.
 *
 * OpenCode 2.0 `Tool.Result.output` is structured (an object for shell), not
 * a string. Non-string input is returned unchanged so the 2.0 after-hook can
 * pass structured output through safely.
 */
export function sanitizeCursorShellDisplayOutput(
  output: string,
  policy?: CursorShellPolicy,
): string {
  if (typeof output !== "string") return output
  if (policy?.backgroundSpawn) {
    const spawn = parseBackgroundSpawnOutcome(output, policy)
    if (spawn) return formatShellOutcomeDisplay(spawn.output, spawn.outcome)
  }
  if (policy?.timeoutBehavior === CURSOR_TIMEOUT_BACKGROUND) {
    const wrapper = parseSoftBackgroundOutcome(output, policy)
    if (wrapper) return formatShellOutcomeDisplay(wrapper.output, wrapper.outcome)
  }
  const timeout = parseOpenCodeTimeout(output)
  if (timeout) {
    return formatShellOutcomeDisplay(timeout.output, {
      kind: "timeout",
      timeoutMs: timeout.timeoutMs,
    })
  }
  return output
}

/** Sanitize a secondary display string (e.g. Bash `metadata.output`) for a registered call. */
export function sanitizeRegisteredCursorShellOutput(toolCallId: string, output: string): string {
  if (typeof output !== "string") return output
  if (typeof toolCallId !== "string" || !toolCallId) return output
  return sanitizeCursorShellDisplayOutput(output, policies.get(toolCallId))
}

/**
 * Capture Bash completion in the classic plugin's after hook. Returns the
 * sanitized output that OpenCode should store and render.
 *
 * Guards non-string output (OpenCode 2.0 structured `Tool.Result.output`)
 * by returning it unchanged.
 */
export function captureCursorShellResult(
  toolCallId: string,
  output: string,
  metadata?: Record<string, unknown>,
): string {
  const parsed = parseCursorShellResult(toolCallId, output, metadata)
  if (parsed.outcome) remember(outcomes, toolCallId, parsed.outcome)
  return parsed.output
}

function parseCursorShellResult(
  toolCallId: string,
  output: string,
  metadata?: Record<string, unknown>,
): { output: string; outcome?: CursorShellOutcome } {
  if (typeof output !== "string") return { output }
  if (typeof toolCallId !== "string" || !toolCallId.startsWith("cursor_")) return { output }
  const policy = policies.get(toolCallId)
  if (policy?.backgroundSpawn) {
    const spawn = parseBackgroundSpawnOutcome(output, policy)
    if (spawn) return { output: formatShellOutcomeDisplay(spawn.output, spawn.outcome), outcome: spawn.outcome }
  }
  // Private wrapper sentinels are meaningful only for calls we transformed.
  // A normal foreground command is allowed to print the same text verbatim.
  const wrapper = policy?.timeoutBehavior === CURSOR_TIMEOUT_BACKGROUND
    ? parseSoftBackgroundOutcome(output, policy)
    : undefined
  if (wrapper) return { output: formatShellOutcomeDisplay(wrapper.output, wrapper.outcome), outcome: wrapper.outcome }
  const timeout = parseOpenCodeTimeout(output)
  if (timeout) {
    const outcome = { kind: "timeout" as const, timeoutMs: timeout.timeoutMs }
    return { output: formatShellOutcomeDisplay(timeout.output, outcome), outcome }
  }
  const exitCode = finiteNonNegative(metadata?.exit)
  return exitCode === undefined ? { output } : { output, outcome: { kind: "exit", code: exitCode } }
}

/** What {@link consumeCursorShellResult} would return, without consuming it. */
export function peekCursorShellResult(
  toolCallId: string,
  output: string,
): { output: string; outcome?: CursorShellOutcome } {
  if (typeof toolCallId !== "string" || !toolCallId) return { output }
  const outcome = outcomes.get(toolCallId)
  return outcome ? { output, outcome } : parseCursorShellResult(toolCallId, output)
}

/** Consume the structured result, with an inline fallback when no plugin hook ran. */
export function consumeCursorShellResult(
  toolCallId: string,
  output: string,
): { output: string; outcome?: CursorShellOutcome } {
  if (typeof toolCallId !== "string" || !toolCallId) {
    return { output }
  }
  let clean = output
  if (!outcomes.has(toolCallId)) clean = captureCursorShellResult(toolCallId, output)
  const outcome = outcomes.get(toolCallId)
  outcomes.delete(toolCallId)
  policies.delete(toolCallId)
  releaseCursorShellEnv(toolCallId)
  return { output: clean, outcome }
}

/** Test/process cleanup. */
export function resetCursorShellCalls(): void {
  for (const wrap of activeEnvWraps.values()) wrap.cleanup()
  activeEnvWraps.clear()
  pendingEnvWraps.clear()
  policies.clear()
  outcomes.clear()
  sweptTerminalFolders.clear()
  configuredShell = undefined
}
