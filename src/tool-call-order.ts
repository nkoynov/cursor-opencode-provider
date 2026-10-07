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

const READ_ONLY_COMMANDS = new Set([
  "cd", "pwd", "ls", "cat", "head", "tail", "wc", "rg", "grep", "egrep", "fgrep", "stat", "file", "du",
  "df", "which", "type", "tree", "jq", "cut", "tr", "diff", "cmp", "realpath", "readlink", "basename",
  "dirname", "date", "whoami", "id", "uname", "nproc", "uptime", "ps", "true", "false", "test", "[",
  "nl", "tac", "rev", "fold", "paste", "comm", "expand", "strings", "od", "hexdump", "base64",
  "sha256sum", "sha1sum", "md5sum", "cksum", "column", "printenv", "echo", "printf",
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
  const text = command.trim().replace(/\s+\d?>\s*\/dev\/null(?=\s|$)/g, " ").replace(/\s+2>&1(?=\s|$)/g, " ")
  if (!text || text.length > 2_000) return false
  if (/[`\n\r<>]|\$\(|(?:^|[^&])&(?!&)/.test(text)) return false
  return text.split(/&&|\|\||;|\|/).every((segment) => readOnlyInvocation(segment.trim().split(/\s+/)))
}

function readOnlyInvocation(words: string[]): boolean {
  const [command, ...args] = words
  if (!command) return false
  if (command === "git") return readOnlyGit(args)
  if (command === "find") return !args.some((arg) => /^-(?:delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/.test(arg))
  if (command === "rg") return !args.some((arg) => arg.startsWith("--pre"))
  if (command === "fd") return !args.some((arg) => /^(?:-[a-zA-Z]*[xX]|--exec)/.test(arg))
  if (command === "sort") return !args.some((arg) => /^(?:-[a-zA-Z]*o|--output)/.test(arg))
  if (command === "uniq") return args.every((arg) => arg.startsWith("-"))
  if (command === "sed") return args.length >= 2 && args[0] === "-n" && /^['"]?(?:\d+|\$)(?:,(?:\d+|\$))?p['"]?$/.test(args[1]!)
  if (command === "command") return args[0] === "-v"
  return READ_ONLY_COMMANDS.has(command)
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
  if (!sub || rest.some((arg) => /^(?:--output|--open-files-in-pager|-O)/.test(arg))) return false
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
