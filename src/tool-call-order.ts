/**
 * Order of a model step's tool calls, as Claude Code runs them: consecutive
 * read-only calls run together, a call that can change state (edit, write,
 * shell, an MCP tool not known to be read-only) starts only after every call
 * before it has finished, and the calls after it wait for it.
 *
 * Cursor sends each call's exec as soon as the model has generated it, and an
 * edit's write only after Cursor has its read, so exec arrival order is not
 * the model's order. `tool_call_started` is: calls are tracked from there, and
 * an exec whose call must wait is held back until the calls before it finish.
 */
import type { Frame } from "./session.js"

/** `provisional`: the display call did not say enough; its exec decides. */
export type OrderedToolCall = { callId: string; mutating: boolean; provisional?: boolean }

export type DeferredToolExec = {
  execId: number
  callId?: string
  mutating: boolean
  read: IteratorResult<Frame>
  /** Released without its predecessors finishing (see `forceReleaseToolExec`). */
  forced?: boolean
}

export type ToolCallOrder = {
  /** Unfinished calls of the Run's current step, in model order. */
  calls: OrderedToolCall[]
  /** Exec frames held back, in arrival order. */
  deferred: DeferredToolExec[]
  /** Last time anything other than a heartbeat moved the Run. */
  progressAt: number
}

/** Release a held exec after this long without progress, so a call Cursor never closes can't stall the Run. */
export const toolCallOrderTiming = { releaseQuietMs: 15_000 }

export function toolCallOrder(session: { toolCallOrder?: ToolCallOrder }): ToolCallOrder {
  return session.toolCallOrder ??= { calls: [], deferred: [], progressAt: Date.now() }
}

export function noteToolCallStarted(order: ToolCallOrder, callId: string, mutating: boolean | undefined): void {
  if (order.calls.some((call) => call.callId === callId)) return
  order.calls.push(mutating === undefined ? { callId, mutating: true, provisional: true } : { callId, mutating })
  order.progressAt = Date.now()
}

/**
 * An exec of the call arrived; returns whether the call can change state. A
 * shell exec can still turn a call into a state-changing one (a background
 * spawn); for other tools the display call decides.
 */
export function noteToolCallExec(
  order: ToolCallOrder,
  callId: string | undefined,
  execMutating: boolean,
  shellExec: boolean,
): boolean {
  const call = callId ? order.calls.find((entry) => entry.callId === callId) : undefined
  if (!call) {
    if (callId) order.calls.push({ callId, mutating: execMutating })
    return execMutating
  }
  if (call.provisional) call.mutating = execMutating
  else if (shellExec) call.mutating ||= execMutating
  call.provisional = false
  return call.mutating
}

export function noteToolCallFinished(order: ToolCallOrder | undefined, callId: string | undefined): void {
  if (!order || !callId) return
  const index = order.calls.findIndex((call) => call.callId === callId)
  if (index < 0) return
  order.calls.splice(index, 1)
  order.progressAt = Date.now()
}

/** True when an exec of `callId` must wait for an unfinished call before it. */
export function toolExecMustWait(order: ToolCallOrder, callId: string | undefined, mutating: boolean): boolean {
  const index = callId ? order.calls.findIndex((call) => call.callId === callId) : -1
  const earlier = index >= 0 ? order.calls.slice(0, index) : order.calls.filter((call) => call.callId !== callId)
  const self = index >= 0 ? order.calls[index]!.mutating || mutating : mutating
  return earlier.some((call) => self || call.mutating)
}

export function deferToolExec(order: ToolCallOrder, exec: DeferredToolExec): void {
  order.deferred.push(exec)
  order.progressAt = Date.now()
}

/** The first held exec whose call may now start. */
export function takeReadyToolExec(order: ToolCallOrder | undefined): DeferredToolExec | undefined {
  if (!order) return undefined
  const index = order.deferred.findIndex((exec) => !toolExecMustWait(order, exec.callId, exec.mutating))
  if (index < 0) return undefined
  return order.deferred.splice(index, 1)[0]
}

export function forceReleaseToolExec(order: ToolCallOrder): DeferredToolExec | undefined {
  const exec = order.deferred.shift()
  if (exec) exec.forced = true
  order.progressAt = Date.now()
  return exec
}

/** Cursor withdrew a held exec: forget it and its call. */
export function dropDeferredToolExec(order: ToolCallOrder | undefined, execId: number): DeferredToolExec | undefined {
  if (!order) return undefined
  const index = order.deferred.findIndex((exec) => exec.execId === execId)
  if (index < 0) return undefined
  const [exec] = order.deferred.splice(index, 1)
  noteToolCallFinished(order, exec!.callId)
  return exec
}

export function deferredToolExecIds(order: ToolCallOrder | undefined): number[] {
  return order?.deferred.map((exec) => exec.execId) ?? []
}

export function hasDeferredToolExecs(order: ToolCallOrder | undefined): boolean {
  return (order?.deferred.length ?? 0) > 0
}

const READ_ONLY_DISPLAY_VARIANTS = new Set([
  "read_tool_call",
  "grep_tool_call",
  "glob_tool_call",
  "ls_tool_call",
  "web_search_tool_call",
  "web_fetch_tool_call",
  "fetch_tool_call",
  "task_tool_call",
  "await_tool_call",
  "read_todos_tool_call",
  "update_todos_tool_call",
  "get_mcp_tools_tool_call",
  "ask_question_tool_call",
  "switch_mode_tool_call",
  "create_plan_tool_call",
  "pi_read_tool_call",
  "pi_ls_tool_call",
  "pi_grep_tool_call",
  "pi_find_tool_call",
])

/** Whether a Cursor display call (`tool_call_started`) can change state; undefined when it doesn't say. */
export function displayToolCallMutates(variant: string, args: Record<string, unknown>, toolName?: string): boolean | undefined {
  if (variant === "shell_tool_call" || variant === "pi_bash_tool_call") {
    return typeof args.command === "string" && args.command.trim() ? !readOnlyShellCommand(args.command) : undefined
  }
  if (variant === "mcp_tool_call") return !readOnlyToolName(toolName ?? "")
  return !READ_ONLY_DISPLAY_VARIANTS.has(variant)
}

const READ_ONLY_HOST_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "ls",
  "list",
  "codesearch",
  "webfetch",
  "websearch",
  "custom_webfetch",
  "custom_websearch",
  "task",
  "subagent",
  "skill",
  "todoread",
  "todowrite",
  "question",
])

/** Whether an exec with no display call can change state. */
export function toolExecMutates(toolName: string, args: Record<string, unknown>, resultField: string): boolean {
  if (resultField === "background_shell_spawn_result") return true
  if (toolName === "bash" || toolName === "shell") return !readOnlyShellCommand(args.command) || args.background === true
  return !readOnlyToolName(toolName)
}

const READ_ONLY_TOOL_WORDS = new Set([
  "get", "list", "search", "read", "fetch", "find", "query", "describe", "view", "status", "capabilities",
])
const MUTATING_TOOL_WORDS = new Set([
  "create", "update", "upsert", "delete", "remove", "save", "set", "add", "send", "post", "put", "patch",
  "write", "edit", "move", "rename", "merge", "close", "start", "stop", "cancel", "run", "execute", "exec",
  "mark", "resolve", "submit", "upload", "share", "unshare", "retire", "restore", "archive", "assign",
  "apply", "launch", "schedule", "configure", "organize", "handoff", "fork", "interrupt", "respond",
  "promote", "reorder", "discard", "prepare", "complete", "link", "unlink", "watch", "unwatch", "click",
  "type", "press", "drag", "select", "scroll", "hover", "navigate", "resize", "record", "clone", "react",
  "approve", "reject", "install", "deploy", "commit", "push", "reset", "kill", "insert", "replace", "clear",
])

/**
 * Host and MCP tools by name: Claude Code trusts an MCP tool's `readOnlyHint`,
 * which Cursor does not pass on. A name with a reading word and no writing word.
 */
export function readOnlyToolName(name: string): boolean {
  if (READ_ONLY_HOST_TOOLS.has(name)) return true
  if (/(?:^|_)delegate_task$/.test(name)) return true
  const words = name.toLowerCase().split(/[^a-z]+/)
  return words.some((word) => READ_ONLY_TOOL_WORDS.has(word)) && !words.some((word) => MUTATING_TOOL_WORDS.has(word))
}

/** Commands with no option that writes or runs a program, so any argument is fine. */
const READ_ONLY_COMMANDS = new Set([
  "cd", "pwd", "ls", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "stat", "du",
  "df", "which", "type", "jq", "cut", "tr", "diff", "cmp", "realpath", "readlink", "basename",
  "dirname", "whoami", "id", "uname", "nproc", "uptime", "ps", "true", "false", "test", "[",
  "nl", "tac", "rev", "fold", "paste", "comm", "expand", "strings", "od", "hexdump",
  "sha256sum", "sha1sum", "md5sum", "cksum", "column", "printenv", "echo", "sleep", "free", "pgrep",
])

const GIT_READ_ONLY = new Set([
  "status", "log", "diff", "show", "rev-parse", "ls-files", "ls-tree", "blame", "describe", "shortlog",
  "cat-file", "grep", "merge-base", "name-rev", "for-each-ref", "rev-list", "count-objects", "show-ref",
  "check-ignore", "cherry", "range-diff", "whatchanged",
])

/**
 * A conservative version of Claude Code's read-only Bash check: every command
 * of the line is a known reader, with no output redirection, substitution or
 * background job. Anything it cannot tell runs in order.
 */
export function readOnlyShellCommand(command: unknown): boolean {
  if (typeof command !== "string") return false
  const text = command.trim().replace(/\s+\d?>\s*\/dev\/null(?=\s|$|'$)/g, " ").replace(/\s+2>&1(?=\s|$|'$)/g, " ")
  if (!text || text.length > 2_000) return false
  if (/[`\n\r<>]|\$\(|(?:^|[^&])&(?!&)/.test(text)) return false
  const remote = sshRemoteCommand(text)
  if (remote !== undefined) return !/[()]/.test(remote) && readOnlyShellCommand(remote)
  return text.split(/&&|\|\||;|\|/).every((segment) => readOnlyInvocation(segment.trim()))
}

/**
 * `ssh [-q] [-T] host 'command'` and nothing else: the remote shell parses the
 * quoted command again, so it gets the same check. Parentheses are refused
 * because a non-POSIX remote shell (fish) substitutes `(…)`.
 */
function sshRemoteCommand(text: string): string | undefined {
  return /^ssh(?:\s+-(?:q|T|qT|Tq))*\s+[A-Za-z0-9_][\w.@-]*\s+'([^']*)'$/.exec(text)?.[1]
}

/**
 * `expands`: has an unquoted glob or brace character or a `$`, so the shell may
 * turn it into other words; `leading`: the word starts with one.
 */
type ShellWord = { text: string; expands: boolean; leading: boolean }

/** Variables that hold an absolute path, so they never expand to a flag. */
const PATH_VARIABLE = /^\$(?:\{(?:HOME|TMPDIR|PWD|XDG_(?:RUNTIME_DIR|CACHE_HOME|CONFIG_HOME|DATA_HOME|STATE_HOME))\}|(?:HOME|TMPDIR|PWD|XDG_(?:RUNTIME_DIR|CACHE_HOME|CONFIG_HOME|DATA_HOME|STATE_HOME))(?!\w))/

/**
 * The words of one segment with quoting removed, so `'-delete'` reads as a
 * flag; undefined for an unbalanced quote, which means the line split inside
 * a quoted string and the segment is not a command of its own.
 */
function segmentWords(segment: string): ShellWord[] | undefined {
  const words: ShellWord[] = []
  let word: ShellWord | undefined
  let quote: string | undefined
  const expansion = (current: ShellWord) => {
    current.expands = true
    if (!current.text) current.leading = true
  }
  for (let index = 0; index < segment.length; index++) {
    const char = segment[index]!
    const pathVariable = char === "$" && quote !== "'" ? PATH_VARIABLE.exec(segment.slice(index))?.[0] : undefined
    if (pathVariable) {
      word ??= { text: "", expands: false, leading: false }
      word.text += pathVariable
      index += pathVariable.length - 1
      continue
    }
    if (!quote && /\s/.test(char)) {
      if (word) words.push(word)
      word = undefined
      continue
    }
    word ??= { text: "", expands: false, leading: false }
    if (quote === "'") {
      if (char === "'") quote = undefined
      else word.text += char
    } else if (quote === '"') {
      if (char === '"') quote = undefined
      else if (char === "\\" && /[$`"\\]/.test(segment[index + 1] ?? "")) word.text += segment[++index]
      else {
        if (char === "$") expansion(word)
        word.text += char
      }
    } else if (char === "'" || char === '"') quote = char
    else if (char === "\\") word.text += segment[++index] ?? ""
    else {
      if (/[*?[{$]/.test(char)) expansion(word)
      word.text += char
    }
  }
  if (quote) return undefined
  if (word) words.push(word)
  return words
}

function readOnlyInvocation(segment: string): boolean {
  const words = segmentWords(segment)
  if (!words?.length) return false
  const [command, ...args] = words.map((word) => word.text)
  if (READ_ONLY_COMMANDS.has(command!)) return true
  if (words.some((word) => word.leading || (word.expands && word.text.startsWith("-")))) return false
  if (command === "git") return readOnlyGit(args)
  if (command === "find") return !args.some((arg) => /^-(?:delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/.test(arg))
  if (command === "rg") return !args.some((arg) => abbreviatesLongOption(arg, ["--pre", "--pre-glob", "--hostname-bin"]))
  if (command === "fd") return !refusesOption(args, /^-[^-]*[xX]/, ["--exec", "--exec-batch"])
  if (command === "sort") return !refusesOption(args, /^-[^-]*o/, ["--output", "--compress-program"])
  if (command === "uniq") return args.every((arg) => arg.startsWith("-"))
  if (command === "tree" || command === "base64") return !refusesOption(args, /^-[^-]*o/, ["--output"])
  if (command === "file") return !refusesOption(args, /^-[^-]*C/, ["--compile"])
  if (command === "printf") return !args.some((arg) => /^-[^-]*v/.test(arg))
  if (command === "date") return readOnlyDate(args)
  if (command === "sed") return readOnlySed(segment, args)
  if (command === "command") return args[0] === "-v"
  if (command === "sqlite3") return !words.some((word) => word.expands) && readOnlySqlite(args)
  if (command === "journalctl") return !args.some((arg) => abbreviatesLongOption(arg, JOURNALCTL_WRITING_OPTIONS, ["--cursor"]))
  if (command === "systemctl") return readOnlySystemctl(args)
  if (command === "gh" || command === "glab") return readOnlyForgeCli(command, args)
  if (command === "tailscale") return args[0] === "status" && args.slice(1).every((arg) => /^--?(?:json|active|peers|self)(?:=(?:true|false))?$/.test(arg))
  if (command === "ss") return !args.some((arg) => /^-[^-]*[KD]/.test(arg) || abbreviatesLongOption(arg, ["--kill", "--diag"]))
  return false
}

function refusesOption(args: string[], short: RegExp, long: string[]): boolean {
  return args.some((arg) => short.test(arg) || abbreviatesLongOption(arg, long))
}

/** Display only: an operand other than `+FORMAT` sets the clock (`date MMDDhhmm`), as do `--set` and BSD `-a`. */
function readOnlyDate(args: string[]): boolean {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === "-d" || arg === "-r" || arg === "--date" || arg === "--reference") index++
    else if (arg.startsWith("-")
      ? !/^(?:-u|--utc|--universal|-R|--rfc-email|-I[a-z]*|--iso-8601(?:=[a-z]+)?|--rfc-3339=[a-z]+|--date=.*|--reference=.*)$/.test(arg)
      : !arg.startsWith("+")) return false
  }
  return true
}

/** getopt_long takes any unambiguous prefix of a long option, so `--rot` is `--rotate`. */
function abbreviatesLongOption(arg: string, options: string[], exact: string[] = []): boolean {
  const name = arg.split("=")[0]!
  return name.startsWith("--") && name.length > 2 && !exact.includes(name) && options.some((option) => option.startsWith(name))
}

/** `sed -n` printing a line range or a `/regex/` range, with no further options (`-i` may follow the script). */
function readOnlySed(segment: string, args: string[]): boolean {
  const script = /^sed\s+-n\s+('[^']*'|\S+)/.exec(segment)?.[1]
  if (args[0] !== "-n" || !script) return false
  const address = /^'[^']*'$/.test(script) ? String.raw`(?:\d+|\$|/[^/\\]*/)` : String.raw`\d+`
  return new RegExp(`^${address}(?:,${address})?p$`).test(args[1] ?? "") && args.slice(2).every((arg) => !arg.startsWith("-"))
}

const JOURNALCTL_WRITING_OPTIONS = [
  "--rotate", "--vacuum-size", "--vacuum-files", "--vacuum-time", "--flush", "--sync", "--setup-keys",
  "--relinquish-var", "--smart-relinquish-var", "--cursor-file", "--update-catalog",
]

const SQLITE_FLAGS = new Set([
  "-readonly", "-safe", "-header", "-noheader", "-csv", "-json", "-line", "-list", "-column", "-box", "-table",
  "-markdown", "-tabs", "-quote", "-html", "-ascii", "-batch", "-bail",
])
const SQLITE_DOT_COMMANDS = new Set([
  ".tables", ".schema", ".fullschema", ".indexes", ".indices", ".headers", ".mode", ".databases", ".print",
  ".width", ".nullvalue", ".separator", ".show",
])
/** `-readonly` guards the database, not the CLI's file and program functions or a temp table such as zipfile. */
const SQLITE_WRITING_SQL = /\b(?:insert|update|delete|replace|upsert|create|drop|alter|attach|detach|vacuum|reindex|analyze|writefile|edit|load_extension|fts3_tokenizer)\b/i

/**
 * `sqlite3 -readonly db 'sql'…`: at least one SQL argument, since without one
 * sqlite3 runs whatever arrives on stdin; dot-commands only from a reading set.
 */
function readOnlySqlite(args: string[]): boolean {
  const database = args.findIndex((arg) => !arg.startsWith("-"))
  if (!args.slice(0, database).includes("-readonly") || SQLITE_WRITING_SQL.test(args.join(" "))) return false
  if (args.some((arg) => arg.startsWith("-") && !SQLITE_FLAGS.has(arg))) return false
  const operands = args.filter((arg) => !arg.startsWith("-"))
  return operands.length >= 2 && operands.slice(1).every((sql) => !sql.startsWith(".") || SQLITE_DOT_COMMANDS.has(sql.split(/\s+/)[0]!))
}

const SYSTEMCTL_READ_ONLY = new Set(["status", "is-active", "is-enabled", "is-failed", "show", "list-units", "list-timers", "cat"])

/** The verb is the first operand, so every word before it must be an option that takes no separate value. */
function readOnlySystemctl(args: string[]): boolean {
  const index = args.findIndex((arg) => !arg.startsWith("-"))
  return index >= 0
    && SYSTEMCTL_READ_ONLY.has(args[index]!)
    && args.slice(0, index).every((arg) =>
      /^(?:--user|--system|--no-pager|--full|-l|--all|-a|--quiet|-q|--no-legend|--plain|--failed|--value|--(?:type|state|property|lines|output)=.*)$/.test(arg))
}

const FORGE_READ_ONLY = {
  gh: new Set(["pr view", "pr list", "pr diff", "pr checks", "pr status", "issue view", "issue list", "issue status", "run view", "run list", "repo view", "release view", "release list"]),
  glab: new Set(["mr view", "mr list", "mr diff", "issue view", "issue list", "repo view", "ci list", "ci get", "release view", "release list"]),
}

/** Listed read subcommands without `--web`/`-w`, and `api` as a plain GET (any field or input makes it a POST). */
function readOnlyForgeCli(command: "gh" | "glab", args: string[]): boolean {
  if (args.some((arg) => /^-[^-]*w/.test(arg) || /^--web(?:=|$)/.test(arg))) return false
  if (args[0] === "api") return readOnlyForgeApi(args.slice(1))
  return FORGE_READ_ONLY[command].has(`${args[0]} ${args[1]}`)
}

/** One endpoint and only flags that neither add a body nor set a method or header. */
function readOnlyForgeApi(args: string[]): boolean {
  if (args.some((arg) => /graphql/i.test(arg))) return false
  let endpoints = 0
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (!arg.startsWith("-")) endpoints++
    else if (/^(?:-[qtp]|--(?:jq|template|hostname|preview))$/.test(arg)) index++
    else if (!/^(?:-i|--(?:paginate|slurp|include|silent|verbose)|--(?:jq|template|hostname|preview)=.*)$/.test(arg)) return false
  }
  return endpoints === 1
}

function readOnlyGit(args: string[]): boolean {
  let index = 0
  while (index < args.length) {
    const arg = args[index]!
    if (arg === "--no-pager") index++
    else if (arg === "-C") index += 2
    else break
  }
  const sub = args[index]
  const rest = args.slice(index + 1)
  if (!sub || refusesOption(rest, /^-O/, ["--output", "--open-files-in-pager"])) return false
  if (GIT_READ_ONLY.has(sub)) return true
  if (sub === "branch") return rest.every((arg) => /^(?:-a|-r|-v|-vv|-l|--list|--all|--remotes|--verbose|--show-current)$/.test(arg))
  if (sub === "tag") return rest.every((arg) => arg === "-l" || arg === "--list")
  if (sub === "remote") return rest.every((arg) => arg === "-v" || arg === "--verbose")
  if (sub === "stash") return rest[0] === "list" || rest[0] === "show"
  if (sub === "worktree") return rest[0] === "list"
  if (sub === "reflog") return rest.length === 0 || rest[0] === "show"
  if (sub === "config") {
    return /^(?:--get|--get-all|--get-regexp|--list|-l)$/.test(rest[0] ?? "")
      && !rest.some((arg) => /^(?:--add|--unset|--replace|--rename|--remove|--edit|-e$)/.test(arg))
  }
  return false
}
