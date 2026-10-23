import { afterEach, describe, expect, it } from "bun:test"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { getPriority } from "node:os"
import path from "node:path"
import {
  CURSOR_TIMEOUT_BACKGROUND,
  armCursorShellCreate,
  captureCursorShellResult,
  prepareCursorShellArgs,
  prepareCursorShellCreate,
  registerCursorShellCall,
  releaseCursorShellEnv,
  resetCursorShellCalls,
} from "../src/shell-timeout.js"
import { DEFAULT_TOOL_NICE, TOOL_NICE_ENV, niceShellAdapter, toolNiceIncrement } from "../src/tool-nice.js"

const lowered = (increment: number) => Math.min(19, getPriority() + increment)
const createEvent = (command: string, cwd = "/tmp") =>
  ({ command, cwd, timeout: 0, shell: "/bin/sh", env: {} as Record<string, string | undefined> })
const niceOf = (shell: string, env: Record<string, string> = {}) => {
  // Builtins only, so it also runs with an empty PATH.
  const result = Bun.spawnSync([shell, "-c", "read -r s < /proc/$$/stat; set -- $s; shift 18; echo $1"], {
    env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe",
  })
  expect(result.exitCode).toBe(0)
  return Number(result.stdout.toString().trim())
}
const onLinux = process.platform === "linux" ? it : it.skip

afterEach(() => {
  delete process.env[TOOL_NICE_ENV]
  resetCursorShellCalls()
})

describe("tool nice increment", () => {
  it.each([
    [undefined, DEFAULT_TOOL_NICE],
    ["", DEFAULT_TOOL_NICE],
    ["0", 0],
    [" 7 ", 7],
    ["25", 19],
    ["-3", DEFAULT_TOOL_NICE],
    ["ten", DEFAULT_TOOL_NICE],
  ])("reads %j as %d", (raw, expected) => {
    expect(toolNiceIncrement(raw === undefined ? {} : { [TOOL_NICE_ENV]: raw })).toBe(expected)
  })
})

describe("tool shells run at the nice increment", () => {
  onLinux("lowers an armed tool call's shell and keeps the shell's name", async () => {
    await armCursorShellCreate("cursor_nice_plain", { input: { command: "echo plain" } })
    const event = createEvent("echo plain")
    prepareCursorShellCreate(event)
    expect(path.basename(event.shell)).toBe("sh")
    expect(event.shell).not.toBe("/bin/sh")
    expect(niceOf(event.shell)).toBe(lowered(DEFAULT_TOOL_NICE))
  })

  it("leaves a shell command no tool call armed at its priority", () => {
    const event = createEvent("echo by hand")
    prepareCursorShellCreate(event)
    expect(event.shell).toBe("/bin/sh")
  })

  it("leaves tool calls alone when the increment is 0", async () => {
    process.env[TOOL_NICE_ENV] = "0"
    await armCursorShellCreate("cursor_nice_off", { input: { command: "echo off" } })
    const event = createEvent("echo off")
    prepareCursorShellCreate(event)
    expect(event.shell).toBe("/bin/sh")
  })

  onLinux("honours a configured increment", async () => {
    process.env[TOOL_NICE_ENV] = "4"
    await armCursorShellCreate("cursor_nice_four", { input: { command: "echo four" } })
    const event = createEvent("echo four")
    prepareCursorShellCreate(event)
    expect(niceOf(event.shell)).toBe(lowered(4))
  })

  onLinux("lowers a wrapped call's payload through the call's own adapter", async () => {
    const id = "cursor_nice_wrapped"
    const command = "cut -d' ' -f19 /proc/$$/stat"
    registerCursorShellCall(id, {
      shell_stream: true, command, working_directory: "/tmp", timeout_ms: 10_000, timeout_behavior: CURSOR_TIMEOUT_BACKGROUND,
    })
    const args: Record<string, unknown> = { command }
    prepareCursorShellArgs(id, args, { deferToShellHook: true })
    await armCursorShellCreate(id, { input: args })
    const event = createEvent(command)
    prepareCursorShellCreate(event)
    const script = readFileSync(event.shell, "utf8")
    expect(script).toContain(`exec nice -n ${DEFAULT_TOOL_NICE} /bin/sh '`)
    const result = Bun.spawnSync([event.shell, "-c", command], { stdout: "pipe", stderr: "pipe" })
    expect(Number(captureCursorShellResult(id, result.stdout.toString()).trim())).toBe(lowered(DEFAULT_TOOL_NICE))
    releaseCursorShellEnv(id)
  })

  onLinux("runs the shell unlowered when nice is not installed", () => {
    const adapter = niceShellAdapter("/bin/sh", DEFAULT_TOOL_NICE)
    expect(niceOf(adapter, { PATH: "/nonexistent" })).toBe(getPriority())
  })

  it("rewrites an adapter that temp cleanup removed", () => {
    const adapter = niceShellAdapter("/bin/sh", DEFAULT_TOOL_NICE)
    rmSync(path.dirname(path.dirname(adapter)), { recursive: true, force: true })
    const again = niceShellAdapter("/bin/sh", DEFAULT_TOOL_NICE)
    expect(existsSync(again)).toBe(true)
    expect(path.basename(again)).toBe("sh")
  })

  it("quotes a shell path with spaces and quotes", () => {
    const adapter = niceShellAdapter("/opt/my shell's/bash", DEFAULT_TOOL_NICE)
    expect(path.basename(adapter)).toBe("bash")
    expect(readFileSync(adapter, "utf8")).toContain(`'/opt/my shell'\\''s/bash' "$@"`)
  })
})
