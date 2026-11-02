import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { encodeMessage } from "../src/protocol/messages.js"
import { toolsToDescriptors } from "../src/protocol/tools.js"
import { applyExecControl, deliverContinuationResults, pump, resetTurnStateForTests } from "../src/language-model.js"
import { sessionManager, type CursorSession, type Frame } from "../src/session.js"
import {
  displayToolCallMutates,
  readOnlyShellCommand,
  readOnlyToolName,
  toolCallOrderTiming,
} from "../src/tool-call-order.js"

const frame = (message: Record<string, unknown>): Frame => ({
  flags: 0,
  payload: encodeMessage("AgentServerMessage", message),
})
const started = (callId: string, toolCall: Record<string, unknown>) =>
  frame({ interaction_update: { tool_call_started: { call_id: callId, tool_call: toolCall } } })
const listed = (count: number) => frame({ interaction_update: { tool_requests_listed: { call_count: count } } })
const shellStarted = (callId: string, command: string) =>
  started(callId, { shell_tool_call: { args: { command, tool_call_id: callId } } })
const shellExec = (id: number, callId: string, command: string) =>
  frame({ exec_server_message: { id, shell_stream_args: { command, tool_call_id: callId } } })
const shell = (id: number, callId: string, command: string) => [shellStarted(callId, command), shellExec(id, callId, command)]
const read = (id: number, callId: string, target: string) => [
  started(callId, { read_tool_call: { args: { path: target } } }),
  frame({ exec_server_message: { id, read_args: { path: target, tool_call_id: callId } } }),
]
const editStarted = (callId: string, target: string) => started(callId, { edit_tool_call: { args: { path: target } } })
const editRead = (id: number, callId: string, target: string) =>
  frame({ exec_server_message: { id, read_args: { path: target, tool_call_id: callId } } })
const editWrite = (id: number, callId: string, target: string) =>
  frame({ exec_server_message: { id, write_args: { path: target, file_text: "new\n", tool_call_id: callId } } })

function scriptedFrames(initial: Frame[]) {
  const queue = [...initial]
  let waiting: ((result: IteratorResult<Frame>) => void) | undefined
  const frames: AsyncIterator<Frame> = {
    next: () => {
      const next = queue.shift()
      if (next) return Promise.resolve({ done: false, value: next })
      return new Promise((resolve) => { waiting = resolve })
    },
  }
  return {
    frames,
    push(next: Frame) {
      if (waiting) {
        const resolve = waiting
        waiting = undefined
        resolve({ done: false, value: next })
      } else queue.push(next)
    },
  }
}

const roots: string[] = []
function fakeSession(frames: AsyncIterator<Frame>): CursorSession {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ordered-tools-"))
  roots.push(root)
  const definitions = ["read", "write", "edit", "bash"].map((name) => ({ name, description: name }))
  const tools = toolsToDescriptors(definitions, "opencode", [])
  return {
    sessionId: "ordered",
    conversationId: "ordered-conversation",
    stream: {
      write() {},
      end() {},
      destroy() {},
      isClosed: () => false,
      frames: () => ({ [Symbol.asyncIterator]: () => frames }),
    } as any,
    frames,
    pending: new Map(),
    displayToolCalls: new Map(),
    nextBridgedExecId: 900_000,
    blobs: new Map(),
    toolCatalog: definitions,
    knownMcpServers: [],
    toolDescriptors: tools,
    requestContext: { tools, env: { workspace_paths: [root] } },
    usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
    billing: { key: "run:test", prefixTokens: 0 },
    allowTools: true,
    pumpActive: true,
    heartbeat: null,
    expiresAt: Date.now() + 10_000,
  } as unknown as CursorSession
}
const rootOf = (session: CursorSession) => (session.requestContext.env as { workspace_paths: string[] }).workspace_paths[0]!

async function pumpOnce(session: CursorSession) {
  const parts: any[] = []
  const controller = {
    enqueue(part: unknown) { parts.push(part) },
    error(error: Error) { throw error },
  } as unknown as ReadableStreamDefaultController<any>
  await pump(session, controller, { textId: "text", reasoningId: "reasoning" })
  return parts
}

const calls = (parts: any[]) => parts.filter((p) => p.type === "tool-call").map((p) => `${p.toolName}#${p.toolCallId.split("_").pop()}`)
const finishes = (parts: any[]) => parts.filter((p) => p.type === "finish").map((p) => p.finishReason.unified)

/** OpenCode ran the step's calls: hand every pending result back, as the next doStream does. */
async function deliverAll(session: CursorSession) {
  const results = [...session.pending.entries()].map(([execId, pending]) => ({
    toolCallId: `cursor_${session.sessionId}_${execId}`,
    sessionId: session.sessionId,
    execId,
    toolName: pending.toolName ?? "bash",
    output: "ok",
  }))
  expect(await deliverContinuationResults(session, results)).toBe(session)
}

describe("ordered tool calls", () => {
  afterEach(() => {
    sessionManager.dispose()
    resetTurnStateForTests()
    toolCallOrderTiming.releaseQuietMs = 15_000
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })

  it("runs a command written after an edit only once the edit's result is back", async () => {
    // Live order: Cursor answers the edit's read, and its write comes back after the command's exec.
    const script = scriptedFrames([])
    const session = fakeSession(script.frames)
    const target = path.join(rootOf(session), "NOTES.md")
    for (const next of [
      editStarted("edit", target),
      editRead(1, "edit", target),
      ...shell(2, "commit", "git commit -am notes"),
      listed(2),
      editWrite(3, "edit", target),
    ]) script.push(next)

    const first = await pumpOnce(session)
    expect(calls(first)).toEqual(["write#3"])
    expect(finishes(first)).toEqual(["tool-calls"])

    await deliverAll(session)
    const second = await pumpOnce(session)
    expect(calls(second)).toEqual(["bash#2"])
    expect(finishes(second)).toEqual(["tool-calls"])
    expect(session.toolCallOrder?.deferred).toEqual([])
    expect(session.replaySafety?.historyRebaseUnsafe).toBeFalsy()
    expect(session.replaySafety?.execs?.filter((exec) => exec.id === 2)).toHaveLength(1)
  })

  it("waits for an edit whose read goes through the host before running the next command", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ordered-outside-"))
    roots.push(outside)
    const target = path.join(outside, "memory.md")
    fs.writeFileSync(target, "old\n")
    const script = scriptedFrames([])
    const session = fakeSession(script.frames)
    for (const next of [
      editStarted("edit", target),
      editRead(1, "edit", target),
      ...shell(2, "post", "gh pr comment 1 --body-file memory.md"),
      listed(2),
    ]) script.push(next)

    const first = await pumpOnce(session)
    expect(calls(first)).toEqual(["read#1"])
    expect(session.replaySafety?.execs?.find((exec) => exec.id === 1)?.callId).toBe("edit")

    await deliverAll(session)
    const pumping = pumpOnce(session)
    await new Promise((resolve) => setTimeout(resolve, 50))
    script.push(editWrite(3, "edit", target))
    const second = await pumping
    expect(calls(second)).toEqual(["edit#3"])
    expect(session.replaySafety?.execs?.find((exec) => exec.id === 3)?.callId).toBe("edit")

    await deliverAll(session)
    const third = await pumpOnce(session)
    expect(calls(third)).toEqual(["bash#2"])
  })

  it("keeps read-only calls together and runs a state-changing call between them alone", async () => {
    const script = scriptedFrames([])
    const session = fakeSession(script.frames)
    const root = rootOf(session)
    for (const name of ["a", "b", "c"]) fs.writeFileSync(path.join(root, name), name)
    for (const next of [
      listed(4),
      ...read(1, "ra", path.join(root, "a")),
      ...shell(2, "status", "git status --short"),
      ...shell(3, "touch", "touch out.txt"),
      ...read(4, "rc", path.join(root, "c")),
    ]) script.push(next)

    const first = await pumpOnce(session)
    expect(calls(first)).toEqual(["read#1", "bash#2"])
    await deliverAll(session)
    const second = await pumpOnce(session)
    expect(calls(second)).toEqual(["bash#3"])
    await deliverAll(session)
    const third = await pumpOnce(session)
    expect(calls(third)).toEqual(["read#4"])
    expect(finishes(third)).toEqual(["tool-calls"])
  })

  it("closes a resumed step on Cursor's count instead of waiting for a quiet Run", async () => {
    const script = scriptedFrames([])
    const session = fakeSession(script.frames)
    const root = rootOf(session)
    for (const name of ["a", "b"]) fs.writeFileSync(path.join(root, name), name)
    // Live order: Cursor lists the count after the step's first execs.
    for (const next of [
      started("lookup", { get_mcp_tools_tool_call: {} }),
      listed(1),
      frame({ interaction_update: { tool_call_completed: { call_id: "lookup", tool_call: { get_mcp_tools_tool_call: {} } } } }),
      ...shell(1, "mk", "mkdir -p out"),
      ...read(2, "ra", path.join(root, "a")),
      listed(3),
      ...read(3, "rb", path.join(root, "b")),
    ]) script.push(next)

    const first = await pumpOnce(session)
    expect(calls(first)).toEqual(["bash#1"])
    await deliverAll(session)
    const startedAt = Date.now()
    const second = await pumpOnce(session)
    expect(calls(second)).toEqual(["read#2", "read#3"])
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  })

  it("runs the read-only calls held behind a state-changing call together", async () => {
    const script = scriptedFrames([])
    const session = fakeSession(script.frames)
    const root = rootOf(session)
    for (const name of ["a", "b", "c"]) fs.writeFileSync(path.join(root, name), name)
    const target = path.join(root, "NOTES.md")
    // The reads arrive while the edit's write is still to come, so they are held in the same pass.
    for (const next of [
      editStarted("edit", target),
      editRead(1, "edit", target),
      ...read(2, "ra", path.join(root, "a")),
      ...read(3, "rb", path.join(root, "b")),
      ...read(4, "rc", path.join(root, "c")),
      listed(4),
      editWrite(5, "edit", target),
    ]) script.push(next)

    expect(calls(await pumpOnce(session))).toEqual(["write#5"])
    expect(session.toolCallOrder?.deferred.map((exec) => exec.execId)).toEqual([2, 3, 4])
    await deliverAll(session)
    const second = await pumpOnce(session)
    expect(calls(second)).toEqual(["read#2", "read#3", "read#4"])
    expect(finishes(second)).toEqual(["tool-calls"])
  })

  it("forgets a held exec that Cursor aborts", async () => {
    const script = scriptedFrames([...shell(1, "a", "touch a"), ...shell(2, "b", "touch b"), listed(2)])
    const session = fakeSession(script.frames)

    const first = await pumpOnce(session)
    expect(calls(first)).toEqual(["bash#1"])
    const second = scriptedFrames([])
    session.frames = second.frames
    applyExecControl(session, { abort: { id: 2 } }, "test")
    expect(session.toolCallOrder?.deferred).toEqual([])
    expect(session.toolCallOrder?.calls.map((call) => call.callId)).toEqual(["a"])
  })

  it("releases a held exec when the Run makes no progress", async () => {
    toolCallOrderTiming.releaseQuietMs = 100
    // `x` never gets an exec or a completion, so nothing would release `y`.
    const script = scriptedFrames([shellStarted("x", "touch x"), ...shell(1, "y", "touch y")])
    const session = fakeSession(script.frames)

    const parts = await pumpOnce(session)
    expect(calls(parts)).toEqual(["bash#1"])
  })
})

describe("tool call classification", () => {
  it("treats reads, searches, subagents and waits as read-only", () => {
    for (const variant of ["read_tool_call", "grep_tool_call", "glob_tool_call", "task_tool_call", "await_tool_call", "web_fetch_tool_call"]) {
      expect(displayToolCallMutates(variant, {})).toBe(false)
    }
    for (const variant of ["edit_tool_call", "delete_tool_call", "pi_write_tool_call", "generate_image_tool_call", "unknown_tool_call"]) {
      expect(displayToolCallMutates(variant, {})).toBe(true)
    }
    expect(displayToolCallMutates("shell_tool_call", {})).toBeUndefined()
  })

  it("classifies MCP tools by name, defaulting to state-changing", () => {
    for (const name of ["linear_list_issues", "slack_slack_read_channel", "linear_get_issue", "t3-code-1_t3_thread_read", "t3-code-1_delegate_task", "skill"]) {
      expect(readOnlyToolName(name)).toBe(true)
    }
    for (const name of [
      "execute",
      "linear_save_issue",
      "slack_slack_send_message",
      "t3-code-1_t3_thread_send",
      "linear_mark_notification",
      "linear_update_issue_status",
      "database_find_or_create_record",
    ]) {
      expect(readOnlyToolName(name)).toBe(false)
    }
    expect(displayToolCallMutates("mcp_tool_call", {}, "linear_save_issue")).toBe(true)
  })

  it("accepts only shell lines it can tell are read-only", () => {
    for (const command of [
      "git status",
      "git -C /etc/nixos --no-pager log --oneline -5",
      "rg -n foo src | head -20",
      "cd src && ls -la",
      "cat a.txt 2>/dev/null",
      "git diff HEAD~1 --stat 2>&1",
      "sed -n 10,40p file.ts",
      "git branch --show-current",
      "git config --get user.email",
      "find . -name '*.ts'",
    ]) {
      expect(readOnlyShellCommand(command)).toBe(true)
    }
    for (const command of [
      "git commit -am x",
      "echo hi > out.txt",
      "cat a | tee b",
      "ls; rm -rf build",
      "find . -name x -delete",
      "git diff --output=patch",
      "sed -i s/a/b/ f",
      "sort -o out in",
      "sleep 5 &",
      "echo $(rm x)",
      "FOO=1 ls",
      "npm test",
      "git branch -D old",
      "git config user.email x",
      "rg --pre ./run foo",
      "fd --exec=rm x",
      "fd -xrm x",
      "sort -uo out in",
      "",
    ]) {
      expect(readOnlyShellCommand(command)).toBe(false)
    }
  })

  it("reads a flag through quotes, and sed options after the script", () => {
    for (const command of [
      "find . '-delete'",
      "find . -de'le'te",
      "rg '--pre=sh' foo",
      "sort \"-o\" out in",
      "sed -n 1,5p -i file",
      "sed -n 1,5p file --in-place",
      "sed -n 1,5p -e 'w out' file",
      "sed -n 1,$p file",
      "sed -n '/a/w out' file",
      "sed -n '/a/,/b/p;w out' file",
      "sed -n /a/p file",
      "cat a 2>/dev/null'x'",
      "cat a >/dev/null'x' b",
      "journalctl --rot{ate,ate}",
      "rg --{pre=sh,no-heading} needle .",
      "sed -n 1p {-n,-i} victim",
      "find . -name x -del*",
      "find . *",
      "find . $X",
      "find . \"$X\"",
      "find . $'\\x2ddelete'",
      "rg 'x|ls' --pre=sh f",
      "fd -1x rm",
      "tree -o out.txt",
      "tree -aJo out.json",
      "file -C -m magic",
      "date -s 2020-01-01",
      "git -C $W commit -m x",
      "date --se=2020-01-01",
      "date 110103002026",
      "date -us 2020-01-01",
      "date -a -1",
      "date -t 202601010000",
      "rg --hyperlink-format='file://{host}{path}' --hostname-bin=./payload needle file",
      "rg --pr=sh needle",
      "sort --compress-program=./payload big",
      "sort --out=result input",
      "fd --exec-b rm",
      "file --comp -m ./magic",
      "printf -v PATH /tmp/x && ls",
      "base64 -i input -o output",
      "git diff --out=patch",
      "git grep --open-files-in foo",
    ]) {
      expect(readOnlyShellCommand(command)).toBe(false)
    }
  })

  it("accepts read-only sed ranges, sleep, free and pgrep", () => {
    for (const command of [
      "sed -n '/Rules in force/,/^## [^R]/p' RUNBOOK.md",
      "sed -n '1,/## r8/p' REVIEW.md | head -120",
      "sed -n '5,$p' a b",
      "sed -n \"10,40p\" file.ts",
      "sleep 5 && tail -5 log.txt",
      "free -g | head -2",
      "pgrep -af pytest | head -3",
      "ls *.md && wc -l src/*.ts",
      "find . -name '*.ts' -newer \"a b\"",
      "tree -L 2 src",
      "file -b x.png",
      "date +%s",
      "date -u -d @1700000000 +%F",
      "date -r file.txt --iso-8601=seconds",
      "printf '%s\\n' a b",
      "base64 -d blob.txt | head",
      "rg --hidden -n foo",
    ]) {
      expect(readOnlyShellCommand(command)).toBe(true)
    }
  })

  it("splits a line only at operators outside quotes", () => {
    for (const command of [
      "rg -n \"def a|def b\" src/x.py",
      "rg -n 'a|b' src | rg -v 'test|spec' | head -30",
      "cat f | rg -n \"x|y\"",
      "grep -n \"a\\|b\" f",
      "jq -r '.items[] | .name' f.json",
      "git log --format='%h;%s' -3",
      "sed -n '/a|b/p' f",
      "echo \"x\\\"; rm y\"",
      "echo 'a&&b' && ls",
      "sqlite3 -readonly db \"select 1; select 2\"",
      "gh api repos/o/r/pulls --jq '.[] | .number'",
      "ssh vm3 'rg -n \"a|b\" /etc/x | head'",
      "cat ${HOME}/a \"${TMPDIR}/b\" | rg 'x|y'",
      "tree -L 2 -a src",
      "fd -a '^python3?$' ~/x | sort",
      "rg -n 'end$' f; echo \"$'\"",
    ]) {
      expect(readOnlyShellCommand(command)).toBe(true)
    }
    for (const command of [
      "echo \"a\" | rm z",
      "cat 'a;b'; rm c",
      "echo \\\"; rm y",
      "echo '\\'; rm y",
      "echo \"\\\\\"; rm y",
      "echo $'a\\' b' ; rm z ; echo $'c\\' d'",
      "echo \"a; rm z",
      "rg 'x' || rm -rf y",
      "rg 'x' && rm -rf y",
      "find . -name x -exec rm {} \\;",
      "jq -r '.a' f | sh",
      "ssh vm3 'rg \"a\" f; rm x'",
      "echo \"${q:=${d:=$}${l:=\"(\"}touch x${r:=\")\"}}${q@P}|ok\"",
      "echo \"${q:=${d:=$}${l:=\"(\"}touch x${r:=\")\"}}${q@P}\"",
      "echo ${y:=a[${d:=$}${l:=(}touch x)]} ${z:${y}}",
      "echo $[1+1]",
      "tree -R -L 2 -H .",
      "tree -aR",
      "cat =(touch victim)",
      "ls *(e:'touch x':)",
      "(rm x)",
      "sort $TMPDIR{-o,./out} /dev/null",
      "sort ${HOME}{-o,./out} /dev/null",
      "sort $HOME* in",
      "find . $XDG_STATE_HOME\"\"{-exec,touch,victim} \\;",
      "sort $XDG_STATE_HOME\"\"{-o,./out} /dev/null",
      "sort $TMPDIR\"\"-o out in",
      "sort \"$TMPDIR\"-o out in",
      "sort $HOME$TMPDIR-o out in",
    ]) {
      expect(readOnlyShellCommand(command)).toBe(false)
    }
  })

  it("accepts sqlite3 only with -readonly, an SQL argument and no writing SQL or dot-command", () => {
    for (const command of [
      "sqlite3 -readonly opencode.db \".tables\"",
      "sqlite3 -readonly opencode.db \".schema session_v2\" | head -30",
      "cd ~/.local/share/opencode; sqlite3 -readonly -header opencode.db \"select date(time_created/1000,'unixepoch') d, count(*) from session_v2 group by d\"",
      "sqlite3 -readonly -json db 'select 1' 'select 2'",
    ]) {
      expect(readOnlyShellCommand(command)).toBe(true)
    }
    for (const command of [
      "sqlite3 opencode.db 'select 1'",
      "sqlite3 -readonly opencode.db",
      "echo .shell rm x | sqlite3 -readonly db",
      "sqlite3 -readonly \"my db.sqlite\"",
      "sqlite3 -readonly db \"$Q\"",
      "sqlite3 -readonly db '.shell rm -rf x'",
      "sqlite3 -readonly db '.sh rm -rf x'",
      "sqlite3 -readonly db '.output out.txt' 'select 1'",
      "sqlite3 -readonly db '.once out.txt' 'select 1'",
      "sqlite3 -readonly db '.system touch x'",
      "sqlite3 -readonly db '.read cmds.sql'",
      "sqlite3 -readonly db '.open other.db' 'select 1'",
      "sqlite3 -readonly db \"select writefile('x', 'y')\"",
      "sqlite3 -readonly db \"select load_extension('./evil')\"",
      "sqlite3 -readonly db \"attach 'other.db' as o\"",
      "sqlite3 -readonly db \"vacuum into 'copy.db'\"",
      "sqlite3 -readonly db \"create virtual table temp.z using zipfile('a.zip')\" \"insert into z(name, data) values ('x', 'y')\"",
      "sqlite3 -readonly -cmd '.shell rm x' db 'select 1'",
      "sqlite3 -readonly -init cmds.sql db 'select 1'",
      "sqlite3 -readonly db \"select 1; .shell rm x\"",
      "sqlite3 -readonly db 'select 1' -A",
      "sqlite3 -readonly db select*",
      "sqlite3 -readonly db {.shell,touch}",
      "sqlite3 -readonly db '.sh'{ell,}",
      "sqlite3 -readonly db \"select write\"\"file('/tmp/pwn','x')\"",
      "sqlite3 -readonly db \"select load_\"exten\\sion\"('/tmp/payload')\"",
      "sqlite3 -readonly db 'select \"WriteFile\"(1, 2)'",
      "sqlite3 db 'PRAGMA user_version=1' -readonly",
    ]) {
      expect(readOnlyShellCommand(command)).toBe(false)
    }
  })

  it("accepts journalctl unless an option writes, abbreviated or not", () => {
    for (const command of [
      "journalctl --user -u imgrec-review-shadow-worker -n 15 --no-pager 2>&1 | tail -12",
      "journalctl -b -1 -n 15 --no-pager -o short-iso | cut -c1-200",
      "journalctl --list-boots --no-pager",
      "journalctl --since today -t t3-restart --no-pager --cursor=s=abc",
      "journalctl --follow --file=x.journal --reverse",
    ]) {
      expect(readOnlyShellCommand(command)).toBe(true)
    }
    for (const command of [
      "journalctl --rotate",
      "journalctl --rot",
      "journalctl --vacuum-size=1G",
      "journalctl --vacuum-time 1d",
      "journalctl --vac",
      "journalctl --flush",
      "journalctl --fl",
      "journalctl --sync",
      "journalctl --setup-keys",
      "journalctl --relinquish-var",
      "journalctl --smart-relinquish-var",
      "journalctl --cursor-file=c.txt -n 5",
      "journalctl --cursor-f c.txt",
      "journalctl --update-catalog",
      "journalctl '--rotate'",
    ]) {
      expect(readOnlyShellCommand(command)).toBe(false)
    }
  })

  it("accepts systemctl only for reading verbs, with nothing before the verb that could take it as a value", () => {
    for (const command of [
      "systemctl status nginx --no-pager",
      "systemctl --user is-active opencode",
      "systemctl --user --no-pager status t3 -n 20",
      "systemctl show opencode -p ActiveState --value",
      "systemctl list-timers --all",
      "systemctl --user cat t3.service",
      "systemctl is-enabled x; systemctl is-failed y",
    ]) {
      expect(readOnlyShellCommand(command)).toBe(true)
    }
    for (const command of [
      "systemctl restart nginx",
      "systemctl --user stop t3",
      "systemctl edit x",
      "systemctl -p status restart nginx",
      "systemctl -H status restart nginx",
      "systemctl --property status restart nginx",
      "systemctl --host=box status nginx",
      "systemctl --machine=box status nginx",
      "systemctl {status,restart} nginx",
      "systemctl daemon-reload",
      "systemctl",
    ]) {
      expect(readOnlyShellCommand(command)).toBe(false)
    }
  })

  it("accepts gh and glab read subcommands and plain GET api calls", () => {
    for (const command of [
      "glab mr view 64 -R teachxai/game-sxs 2>&1 | head -40",
      "glab mr list -R teachxai/imgrec-review --merged -P 1",
      "glab mr diff 74",
      "glab ci list",
      "gh pr view 12 --comments",
      "gh pr checks 12 --watch",
      "gh run view 123 --log",
      "gh release list -L 5",
      "gh api repos/oakimov/cursor-opencode-provider/pulls --paginate --jq .[].number",
      "glab api projects/1/merge_requests",
    ]) {
      expect(readOnlyShellCommand(command)).toBe(true)
    }
    for (const command of [
      "gh pr view 12 --web",
      "gh pr view 12 -w",
      "glab mr view 64 -w",
      "glab repo view --web",
      "gh pr merge 12",
      "gh pr create --fill",
      "gh pr checkout 12",
      "gh run rerun 123",
      "gh run download 123",
      "glab mr approve 64",
      "glab mr note 64 -m x",
      "glab ci view",
      "glab ci status",
      "glab ci retry 1",
      "gh api -X POST repos/o/r/issues",
      "gh api --method=PATCH repos/o/r",
      "gh api repos/o/r/issues -f title=x",
      "gh api repos/o/r/issues -F title=x",
      "gh api repos/o/r/issues --raw-field title=x",
      "gh api repos/o/r/issues --input body.json",
      "gh api repos/o/r -H 'X-HTTP-Method-Override: DELETE'",
      "gh api graphql",
      "glab api PUT projects/1",
      "glab api -XPUT projects/1",
      "glab api projects/1/issues --field title=x",
      "gh api repos/o/r --cache 1h",
      "gh pr view 1 -1w",
      "gh pr {view,merge} 1",
    ]) {
      expect(readOnlyShellCommand(command)).toBe(false)
    }
  })

  it("accepts tailscale status and ss without their writing options", () => {
    for (const command of [
      "tailscale status | head -3",
      "tailscale status --json | jq -r .BackendState",
      "ss -ltnp | rg 8763",
      "ss -tinp --dccp",
    ]) {
      expect(readOnlyShellCommand(command)).toBe(true)
    }
    for (const command of [
      "tailscale up",
      "tailscale status --web",
      "tailscale status --listen=0.0.0.0:80 --web",
      "ss -K dst 10.0.0.1",
      "ss -tK",
      "ss --kill",
      "ss --ki",
      "ss -D out.raw",
      "ss --diag=out.raw",
      "ss --di=out.raw",
      "ss -4K dst 127.0.0.1",
      "ss -6D diag.raw",
    ]) {
      expect(readOnlyShellCommand(command)).toBe(false)
    }
  })

  it("accepts ssh host 'command' when the remote command passes the same check", () => {
    for (const command of [
      "ssh game-sxs 'journalctl -u ttl-game-sxs-pods --since today --no-pager | tail -25'",
      "ssh -q tedo@10.77.0.2 'ls -la /home/tedo/.tmp'",
      "ssh -T -q vm3 'cd /etc/nixos && git log --oneline -3'",
      "ssh vm3 'sqlite3 -readonly db .tables 2>/dev/null'",
    ]) {
      expect(readOnlyShellCommand(command)).toBe(true)
    }
    for (const command of [
      "ssh game-sxs 'rm -rf /opt/x'",
      "ssh game-sxs 'ls; rm x'",
      "ssh game-sxs 'ls > out'",
      "ssh game-sxs 'echo $(rm x)'",
      "ssh game-sxs 'sleep 5 &'",
      "ssh game-sxs 'echo (rm x)'",
      "ssh game-sxs ls",
      "ssh game-sxs \"ls\"",
      "ssh game-sxs 'ls' 'rm x'",
      "ssh game-sxs 'ls' | tail",
      "ssh game-sxs 'ls'; rm x",
      "ssh game-sxs 'ls'x",
      "ssh -L 8080:localhost:80 game-sxs 'ls'",
      "ssh -R 8080:localhost:80 game-sxs 'ls'",
      "ssh -D 1080 game-sxs 'ls'",
      "ssh -W host:22 game-sxs 'ls'",
      "ssh -o ProxyCommand=x game-sxs 'ls'",
      "ssh -oPermitLocalCommand=yes game-sxs 'ls'",
      "ssh -F cfg game-sxs 'ls'",
      "ssh -t game-sxs 'ls'",
      "ssh -f game-sxs 'ls'",
      "ssh -N game-sxs 'ls'",
      "ssh -J jump game-sxs 'ls'",
      "ssh -p 2222 game-sxs 'ls'",
      "ssh -qv game-sxs 'ls'",
      "ssh -oLocalCommand=touch game-sxs 'ls'",
      "ssh game-sxs 'ssh other rm x'",
      "cd x && ssh game-sxs 'ls'",
      "ssh game-sxs '",
    ]) {
      expect(readOnlyShellCommand(command)).toBe(false)
    }
  })
})
