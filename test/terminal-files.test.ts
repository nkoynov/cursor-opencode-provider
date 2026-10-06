import { describe, it, expect, afterEach } from "bun:test"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { buildTerminalFileReadMessages, mapCursorArgsToOpencode, parseExecServerMessage, toolsToDescriptors } from "../src/protocol/tools.js"
import { pump, resetTurnStateForTests } from "../src/language-model.js"
import { sessionManager, type CursorSession, type Frame } from "../src/session.js"
import {
  buildBackgroundShellCommand,
  buildSoftBackgroundCommand,
  consumeCursorShellResult,
  registerCursorShellCall,
  resetCursorShellCalls,
  shellPolicyFromMetadata,
  sweepStaleTerminalFiles,
} from "../src/shell-timeout.js"

const roots: string[] = []
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-terminals-"))
  roots.push(dir)
  return dir
}

function run(script: string, env?: Record<string, string>): string {
  return spawnSync("sh", ["-c", script], { encoding: "utf8", timeout: 20_000, env: { ...process.env, ...env } }).stdout
}

/** Like `run`, but lets other scripts run meanwhile. */
function runConcurrently(shell: string, script: string, env: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(shell, ["-c", script], { env: { ...process.env, ...env } })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (data) => (stdout += data))
    child.stderr.on("data", (data) => (stderr += data))
    child.on("close", (status) => resolve({ status, stdout, stderr }))
  })
}

const dash = spawnSync("sh", ["-c", "command -v dash"], { encoding: "utf8" }).stdout.trim()
const wrapperShells = ["sh", ...(dash ? [dash] : [])]

/** A PATH whose `name` exits with `code` without running anything. */
function failingShim(name: string, code: number): string {
  const shim = tempDir()
  fs.writeFileSync(path.join(shim, name), `#!/bin/sh\nexit ${code}\n`, { mode: 0o755 })
  return `${shim}:${process.env.PATH}`
}

/** A PATH whose `name` fails after `seconds`, past the time a launcher used to wait for its runner. */
function slowFailingShim(name: string, seconds: number): string {
  const shim = tempDir()
  fs.writeFileSync(path.join(shim, name), `#!/bin/sh\nsleep ${seconds}\nexit 1\n`, { mode: 0o755 })
  return `${shim}:${process.env.PATH}`
}

function readyMarkers(tmp: string): string[] {
  return fs.readdirSync(tmp).filter((name) => name.startsWith("cursor-opencode-shell-ready."))
}

async function finished(file: string, polls = 200): Promise<string> {
  for (let i = 0; i < polls; i++) {
    const text = fs.readFileSync(file, "utf8")
    if (/\nexit_code: -?\d+\nelapsed_ms: \d+\nended_at: \S+\n---\n$/.test(text) && !text.includes("status: running")) return text
    await Bun.sleep(25)
  }
  throw new Error(`terminal file never finished: ${fs.readFileSync(file, "utf8")}`)
}

function terminalFile(pid: string, cwd: string, status: string, output: string, exitCode: number): RegExp {
  const escaped = output.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(
    `^---\\npid: ${pid}\\ncwd: "${cwd}"\\ncommand: ".*"\\n(?:title: ".*"\\n)?status: ${status.padEnd(9)}\\nstarted_at: \\S+\\n` +
      `running_for_ms: [\\d ]{9}\\n---\\n${escaped}\\n---\\nexit_code: ${exitCode}\\nelapsed_ms: \\d+\\nended_at: \\S+\\n---\\n$`,
  )
}

afterEach(() => {
  resetCursorShellCalls()
  sessionManager.dispose()
  resetTurnStateForTests()
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe("background spawn into a Cursor terminal file", () => {
  it("writes the file under the returned shell id and finishes it", async () => {
    const folder = tempDir()
    const stdout = run(buildBackgroundShellCommand("printf 'one\\n'; sleep 0.3; printf 'two\\n'", { folder, cwd: "/w" }))
    const [, pid, file] = /__CURSOR_BACKGROUND_SHELL__(\d+):(.+)\n/.exec(stdout)!
    expect(file).toBe(path.join(folder, `${pid}.txt`))
    expect(fs.readFileSync(file!, "utf8")).toStartWith(`---\npid: ${pid}\ncwd: "/w"\ncommand: "printf 'one\\\\n'; sleep 0.3; printf 'two\\\\n'"\nstatus: running  \n`)

    expect(await finished(file!)).toMatch(terminalFile(pid!, "/w", "succeeded", "one\ntwo\n", 0))
  })

  it("refreshes running_for_ms in the header while the command runs", async () => {
    const folder = tempDir()
    const stdout = run(buildBackgroundShellCommand("sleep 7", { folder, cwd: "/w" }))
    const [, , file] = /__CURSOR_BACKGROUND_SHELL__(\d+):(.+)\n/.exec(stdout)!
    await Bun.sleep(5_800)
    expect(fs.readFileSync(file!, "utf8")).toMatch(/\nstatus: running  \nstarted_at: \S+\nrunning_for_ms: [5-9]\d{3} {5}\n---\n$/)
    expect(await finished(file!)).toMatch(/\nstatus: succeeded\n/)
  }, 20_000)

  it("caps running_for_ms at its nine characters so the rewrite never reaches the output", async () => {
    const folder = tempDir()
    const shim = tempDir()
    const realDate = spawnSync("sh", ["-c", "command -v date"], { encoding: "utf8" }).stdout.trim()
    fs.writeFileSync(path.join(shim, "date"), [
      "#!/bin/sh",
      `case "$1" in +%s|+%s%3N) if [ -e "${shim}/started" ]; then v=3000000; else : > "${shim}/started"; v=1000000; fi; if [ "$1" = +%s ]; then echo $v; else echo \${v}000; fi;; *) exec ${realDate} "$@";; esac`,
      "",
    ].join("\n"), { mode: 0o755 })
    const script = buildBackgroundShellCommand("printf PAYLOAD", { folder, cwd: "/w" })
    const stdout = spawnSync("sh", ["-c", script], { encoding: "utf8", env: { ...process.env, PATH: `${shim}:${process.env.PATH}` } }).stdout
    const [, pid, file] = /__CURSOR_BACKGROUND_SHELL__(\d+):(.+)\n/.exec(stdout)!
    expect(await finished(file!)).toMatch(terminalFile(pid!, "/w", "succeeded", "PAYLOAD", 0))
    expect(fs.readFileSync(file!, "utf8")).toContain("running_for_ms: 999999999\n")
  })

  it("puts the call's description in the header as its title", async () => {
    const folder = tempDir()
    const stdout = run(buildBackgroundShellCommand("printf ok", { folder, cwd: "/w", title: 'Start "dev" server' }))
    const [, pid, file] = /__CURSOR_BACKGROUND_SHELL__(\d+):(.+)\n/.exec(stdout)!
    const text = await finished(file!)
    expect(text).toContain('\ncommand: "printf ok"\ntitle: "Start \\"dev\\" server"\nstatus: succeeded\n')
    expect(text).toMatch(terminalFile(pid!, "/w", "succeeded", "ok", 0))
  })

  it("records a failing command's output and exit code", async () => {
    const folder = tempDir()
    const stdout = run(buildBackgroundShellCommand("echo oops >&2; exit 3", { folder, cwd: "/w" }))
    const [, pid, file] = /__CURSOR_BACKGROUND_SHELL__(\d+):(.+)\n/.exec(stdout)!
    expect(await finished(file!)).toMatch(terminalFile(pid!, "/w", "failed", "oops\n", 3))
  })

  it("returns the shell id only once the runner's own header replaced an earlier file at its path", () => {
    const folder = tempDir()
    const shim = tempDir()
    const tmp = tempDir()
    const realMv = spawnSync("sh", ["-c", "command -v mv"], { encoding: "utf8" }).stdout.trim()
    fs.writeFileSync(path.join(shim, "mv"), `#!/bin/sh\n[ -e "$3" ] || { printf 'stale\\n' >"$3"; sleep 0.5; }\nexec ${realMv} "$@"\n`, { mode: 0o755 })
    const stdout = run(buildBackgroundShellCommand("true", { folder, cwd: "/w" }), { PATH: `${shim}:${process.env.PATH}`, TMPDIR: tmp })
    const [, pid, file] = /__CURSOR_BACKGROUND_SHELL__(\d+):(.+)\n/.exec(stdout)!
    expect(fs.readFileSync(file!, "utf8")).toStartWith(`---\npid: ${pid}\n`)
    expect(fs.readdirSync(tmp).filter((name) => name.startsWith("cursor-opencode-shell-ready."))).toEqual([])
  })

  it("fails without a shell id when the runner exits before its header is in place", () => {
    for (const shell of wrapperShells) {
      for (const [name, code] of [["mv", 1], ["nohup", 127], ["nohup", 0]] as const) {
        const folder = tempDir()
        const tmp = tempDir()
        const marker = path.join(tempDir(), "ran")
        const started = Date.now()
        const result = spawnSync(shell, ["-c", buildBackgroundShellCommand(`echo ran > '${marker}'`, { folder, cwd: "/w" })], {
          encoding: "utf8",
          timeout: 20_000,
          env: { ...process.env, PATH: failingShim(name, code), TMPDIR: tmp },
        })
        expect({ shell, name, code, status: result.status, stdout: result.stdout }).toEqual({ shell, name, code, status: 1, stdout: "" })
        expect(result.stderr).toContain("The background shell exited before it started the command.")
        expect(Date.now() - started).toBeLessThan(1_500)
        expect(readyMarkers(tmp)).toEqual([])
        expect(fs.existsSync(marker)).toBe(false)

        registerCursorShellCall("cursor_bg_1", { background_shell_spawn: true, command: "true", working_directory: "", terminals_folder: folder, terminal_cwd: "/w" })
        expect(consumeCursorShellResult("cursor_bg_1", result.stdout + result.stderr).outcome).toBeUndefined()
      }
    }
  })

  it("waits for a runner slow to start, and fails without a shell id when it never starts the command", () => {
    const folder = tempDir()
    const tmp = tempDir()
    const marker = path.join(tempDir(), "ran")
    const result = spawnSync("sh", ["-c", buildBackgroundShellCommand(`echo ran > '${marker}'`, { folder, cwd: "/w" })], {
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, PATH: slowFailingShim("mv", 4), TMPDIR: tmp },
    })
    expect({ status: result.status, stdout: result.stdout }).toEqual({ status: 1, stdout: "" })
    expect(result.stderr).toContain("The background shell exited before it started the command.")
    expect(readyMarkers(tmp)).toEqual([])
    expect(fs.existsSync(marker)).toBe(false)
  }, 20_000)

  it("keeps its ready marker in the terminals folder when the temporary directory is unavailable", async () => {
    const folder = tempDir()
    const stdout = run(buildBackgroundShellCommand("printf ok", { folder, cwd: "/w" }), { TMPDIR: path.join(tempDir(), "missing") })
    const [, pid, file] = /__CURSOR_BACKGROUND_SHELL__(\d+):(.+)\n/.exec(stdout)!
    expect(await finished(file!)).toMatch(terminalFile(pid!, "/w", "succeeded", "ok", 0))
    expect(fs.readdirSync(folder)).toEqual([`${pid}.txt`])
  })

  it("reports the terminal's directory when Cursor sent none", () => {
    const folder = tempDir()
    const command = "true"
    registerCursorShellCall("cursor_bg_1", { background_shell_spawn: true, command, working_directory: "", terminals_folder: folder, terminal_cwd: "/w" })
    const result = consumeCursorShellResult("cursor_bg_1", run(buildBackgroundShellCommand(command, { folder, cwd: "/w" })))
    expect(result.outcome).toMatchObject({ kind: "backgrounded", workingDirectory: "/w" })
  })

  it.skipIf(process.getuid?.() === 0)("still runs the command when files cannot be created in the terminals folder", async () => {
    for (const mode of [0o555, 0o222]) {
      const folder = tempDir()
      const tmp = tempDir()
      const marker = path.join(tempDir(), "ran")
      fs.chmodSync(folder, mode)
      const stdout = run(buildBackgroundShellCommand(`echo ran > '${marker}'`, { folder, cwd: "/w" }), { TMPDIR: tmp })
      const [, , log] = /__CURSOR_BACKGROUND_SHELL__(\d+):(.+)\n/.exec(stdout)!
      expect(path.dirname(path.dirname(log!))).toBe(tmp)
      for (let i = 0; i < 200 && !fs.existsSync(marker); i++) await Bun.sleep(25)
      expect(fs.readFileSync(marker, "utf8")).toBe("ran\n")
      fs.chmodSync(folder, 0o755)
      expect(fs.readdirSync(folder)).toEqual([])
    }
  })

  it("keeps output a descendant writes just after the command exits before the footer", async () => {
    const folder = tempDir()
    const stdout = run(buildBackgroundShellCommand("(sleep 1; echo late) & echo early", { folder, cwd: "/w" }))
    const [, pid, file] = /__CURSOR_BACKGROUND_SHELL__(\d+):(.+)\n/.exec(stdout)!
    expect(await finished(file!)).toMatch(terminalFile(pid!, "/w", "succeeded", "early\nlate\n", 0))
  })

  it("still finishes the file when the output pipe's reader fails", async () => {
    const folder = tempDir()
    const shim = tempDir()
    fs.writeFileSync(path.join(shim, "cat"), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
    const script = buildBackgroundShellCommand("true", { folder, cwd: "/w" })
    const stdout = spawnSync("sh", ["-c", script], { encoding: "utf8", env: { ...process.env, PATH: `${shim}:${process.env.PATH}` } }).stdout
    const [, pid, file] = /__CURSOR_BACKGROUND_SHELL__(\d+):(.+)\n/.exec(stdout)!
    expect(await finished(file!)).toMatch(terminalFile(pid!, "/w", "succeeded", "", 0))
  })

  it("finishes the file 5 s after the command exits while a descendant still holds its output", async () => {
    const folder = tempDir()
    const started = Date.now()
    const stdout = run(buildBackgroundShellCommand("(sleep 9; echo too-late) & echo early", { folder, cwd: "/w" }))
    const [, pid, file] = /__CURSOR_BACKGROUND_SHELL__(\d+):(.+)\n/.exec(stdout)!
    const text = await finished(file!, 300)
    expect(Date.now() - started).toBeLessThan(7_000)
    expect(text).toMatch(terminalFile(pid!, "/w", "succeeded", "early\n", 0))
  }, 20_000)
})

describe("soft-background shell into a Cursor terminal file", () => {
  const softPolicy = (folder: string, command: string, timeoutMs: number, hardTimeoutMs?: number) => {
    const metadata = {
      shell_stream: true,
      command,
      working_directory: "",
      timeout_ms: timeoutMs,
      timeout_behavior: 2,
      ...(hardTimeoutMs ? { hard_timeout_ms: hardTimeoutMs } : {}),
      terminals_folder: folder,
      terminal_cwd: "/w",
    }
    registerCursorShellCall("cursor_soft_1", metadata)
    return buildSoftBackgroundCommand(shellPolicyFromMetadata(metadata)!)
  }

  it("returns a command that ends in its window as a plain exit, without a terminal file", () => {
    const folder = tempDir()
    const result = consumeCursorShellResult("cursor_soft_1", run(softPolicy(folder, "printf 'hi\\n'; exit 4", 2_000)))
    expect(result.outcome).toEqual({ kind: "exit", code: 4 })
    expect(result.output).toBe("hi\n")
    expect(fs.readdirSync(folder)).toEqual([])
  })

  it("reports a command that ends inside a short window as a plain exit", () => {
    for (const hardTimeoutMs of [undefined, 300]) {
      const folder = tempDir()
      const result = consumeCursorShellResult("cursor_soft_1", run(softPolicy(folder, "printf DONE", 300, hardTimeoutMs)))
      expect(result.outcome).toEqual({ kind: "exit", code: 0 })
      expect(result.output).toBe("DONE\n")
    }
  })

  it("reports a command that exits in its window while a descendant holds its output as a plain exit", () => {
    for (const hardTimeoutMs of [undefined, 500]) {
      const folder = tempDir()
      const tmp = tempDir()
      const result = consumeCursorShellResult("cursor_soft_1", run(softPolicy(folder, "(sleep 2; echo child) & echo parent; exit 3", 500, hardTimeoutMs), { TMPDIR: tmp }))
      expect(result).toEqual({ output: "parent\nchild\n", outcome: { kind: "exit", code: 3 } })
      expect(fs.readdirSync(folder)).toEqual([])
      expect(fs.readdirSync(tmp)).toEqual([])
    }
  }, 15_000)

  it("keeps the command's exit code and leaves the footer out when a descendant writes after it", () => {
    const folder = tempDir()
    // The descendant outlives the test; it must stop once the test removes the folder.
    const late = `(until grep -q '^status: failed' ${folder}/*.txt 2>/dev/null; do [ -d ${folder} ] || exit 0; sleep 0.02; done; printf 'exit_code: 9\\n') & echo parent; exit 3`
    const result = consumeCursorShellResult("cursor_soft_1", run(softPolicy(folder, late, 8_000)))
    expect(result.outcome).toEqual({ kind: "exit", code: 3 })
    expect(result.output).toBe("parent\n")
  }, 20_000)

  it("hands a command that outlives its window to its terminal file", async () => {
    const folder = tempDir()
    const stdout = run(softPolicy(folder, "printf 'start\\n'; sleep 1; printf 'end\\n'", 300))
    const result = consumeCursorShellResult("cursor_soft_1", stdout)
    expect(result.outcome).toMatchObject({ kind: "backgrounded", msToWait: 300, workingDirectory: "/w" })
    expect(result.output).toStartWith("start\n")
    const pid = String((result.outcome as { shellId: number }).shellId)

    expect(await finished(path.join(folder, `${pid}.txt`))).toMatch(terminalFile(pid, "/w", "succeeded", "start\nend\n", 0))
  })

  it("reports a failure, not the command's exit, when the runner exits before its header is in place", () => {
    for (const shell of wrapperShells) {
      for (const [name, code] of [["mv", 1], ["nohup", 127], ["nohup", 0]] as const) {
        const folder = tempDir()
        const tmp = tempDir()
        const marker = path.join(tempDir(), "ran")
        const stdout = spawnSync(shell, ["-c", softPolicy(folder, `echo ran > '${marker}'`, 2_000)], {
          encoding: "utf8",
          timeout: 20_000,
          env: { ...process.env, PATH: failingShim(name, code), TMPDIR: tmp },
        }).stdout
        const result = consumeCursorShellResult("cursor_soft_1", stdout)
        expect({ shell, name, code, kind: result.outcome?.kind }).toEqual({ shell, name, code, kind: "exit" })
        expect((result.outcome as { code: number }).code).not.toBe(0)
        expect(result.output).toBe("The shell runner exited before reporting the command's exit status.\n")
        expect(readyMarkers(tmp)).toEqual([])
        expect(fs.readdirSync(folder)).toEqual([])
        expect(fs.existsSync(marker)).toBe(false)
      }
    }
  }, 30_000)

  it("waits through a zero window for a runner slow to start, and reports when it never starts the command", () => {
    const folder = tempDir()
    const tmp = tempDir()
    const marker = path.join(tempDir(), "ran")
    const stdout = spawnSync("sh", ["-c", softPolicy(folder, `echo ran > '${marker}'`, 0)], {
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, PATH: slowFailingShim("mv", 4), TMPDIR: tmp },
    }).stdout
    const result = consumeCursorShellResult("cursor_soft_1", stdout)
    expect(result.outcome?.kind).toBe("exit")
    expect((result.outcome as { code: number }).code).not.toBe(0)
    expect(readyMarkers(tmp)).toEqual([])
    expect(fs.existsSync(marker)).toBe(false)
  }, 20_000)

  it("gives up after 10 s on a runner stuck before it starts the command, which then never runs it", async () => {
    // A stuck `mv` would put the header in place, and a stuck `mkfifo` make the pipe, after the launcher gave up.
    const go = path.join(tempDir(), "go")
    const delayed = (name: string) => {
      const shim = tempDir()
      const real = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim()
      fs.writeFileSync(path.join(shim, name), `#!/bin/sh\nuntil [ -e '${go}' ]; do sleep 0.1; done\nexec ${real} "$@"\n`, { mode: 0o755 })
      return shim
    }
    const explicit = { folder: tempDir(), tmp: tempDir(), marker: path.join(tempDir(), "ran"), shim: delayed("mv") }
    const soft = { folder: tempDir(), tmp: tempDir(), marker: path.join(tempDir(), "ran"), shim: delayed("mkfifo") }
    const env = ({ shim, tmp }: { shim: string; tmp: string }) => ({ PATH: `${shim}:${process.env.PATH}`, TMPDIR: tmp })
    const started = Date.now()
    const [background, foreground] = await Promise.all([
      runConcurrently(
        dash || "sh",
        buildBackgroundShellCommand(`echo ran > '${explicit.marker}'`, { folder: explicit.folder, cwd: "/w" }),
        env(explicit),
      ),
      runConcurrently("sh", softPolicy(soft.folder, `echo ran > '${soft.marker}'`, 0), env(soft)),
    ])
    expect(Date.now() - started).toBeLessThan(20_000)
    expect(Date.now() - started).toBeGreaterThan(9_000)

    expect({ status: background.status, stdout: background.stdout }).toEqual({ status: 1, stdout: "" })
    expect(background.stderr).toContain("The background shell did not start the command within 10 s.")
    const result = consumeCursorShellResult("cursor_soft_1", foreground.stdout)
    expect(result.outcome?.kind).toBe("exit")
    expect((result.outcome as { code: number }).code).not.toBe(0)
    expect(result.output).toBe("The shell runner did not start the command within 10 s.\n")
    fs.writeFileSync(go, "")
    await Bun.sleep(1_000)
    for (const { folder, tmp, marker, shim } of [explicit, soft]) {
      expect(fs.existsSync(marker)).toBe(false)
      expect(fs.readdirSync(tmp)).toEqual([])
      expect(fs.readdirSync(folder)).toEqual([])
      expect(spawnSync("pgrep", ["-f", folder], { encoding: "utf8" }).stdout).toBe("")
      expect(spawnSync("pgrep", ["-f", shim], { encoding: "utf8" }).stdout).toBe("")
    }
  }, 30_000)

  it("reports a command that ends while its handoff is being prepared as a plain exit, and leaves no control file", () => {
    const shim = tempDir()
    const realWc = spawnSync("sh", ["-c", "command -v wc"], { encoding: "utf8" }).stdout.trim()
    fs.writeFileSync(path.join(shim, "wc"), `#!/bin/sh\nsleep 0.5\nexec ${realWc} "$@"\n`, { mode: 0o755 })
    for (const shell of wrapperShells) {
      for (const hardTimeoutMs of [undefined, 5_000]) {
        const folder = tempDir()
        const tmp = tempDir()
        const stdout = spawnSync(shell, ["-c", softPolicy(folder, "printf 'start\\n'; sleep 0.2", 100, hardTimeoutMs)], {
          encoding: "utf8",
          timeout: 20_000,
          env: { ...process.env, PATH: `${shim}:${process.env.PATH}`, TMPDIR: tmp },
        }).stdout
        expect({ shell, hardTimeoutMs, result: consumeCursorShellResult("cursor_soft_1", stdout) })
          .toEqual({ shell, hardTimeoutMs, result: { output: "start\n", outcome: { kind: "exit", code: 0 } } })
        expect(fs.readdirSync(folder)).toEqual([])
        expect(fs.readdirSync(tmp)).toEqual([])
      }
    }
  }, 30_000)

  it("hands off only the output from before the command ended, and its control files go once it is done", async () => {
    const shim = tempDir()
    const realAwk = spawnSync("sh", ["-c", "command -v awk"], { encoding: "utf8" }).stdout.trim()
    fs.writeFileSync(path.join(shim, "awk"), `#!/bin/sh\nsleep 0.6\nexec ${realAwk} "$@"\n`, { mode: 0o755 })
    for (const shell of wrapperShells) {
      const folder = tempDir()
      const tmp = tempDir()
      const stdout = spawnSync(shell, ["-c", softPolicy(folder, "printf 'start\\n'; sleep 0.3; printf 'end\\n'", 100, 5_000)], {
        encoding: "utf8",
        timeout: 20_000,
        env: { ...process.env, PATH: `${shim}:${process.env.PATH}`, TMPDIR: tmp },
      }).stdout
      const result = consumeCursorShellResult("cursor_soft_1", stdout)
      expect({ shell, kind: result.outcome?.kind }).toEqual({ shell, kind: "backgrounded" })
      const pid = String((result.outcome as { shellId: number }).shellId)
      expect(result.output).toBe(`start\nStill running in the background (pid ${pid}) after 100ms.\n`)
      expect(await finished(path.join(folder, `${pid}.txt`))).toMatch(terminalFile(pid, "/w", "succeeded", "start\nend\n", 0))
      for (let i = 0; i < 80 && fs.readdirSync(tmp).length > 0; i++) await Bun.sleep(25)
      expect(fs.readdirSync(tmp)).toEqual([])
    }
  }, 30_000)

  it("hands off output that ends inside a character only up to that character", async () => {
    for (const shell of wrapperShells) {
      const folder = tempDir()
      const command = "printf 'start-\\342\\202'; sleep 0.6; printf '\\254 end\\n'"
      const stdout = spawnSync(shell, ["-c", softPolicy(folder, command, 100, 5_000)], { encoding: "utf8", timeout: 20_000 }).stdout
      const result = consumeCursorShellResult("cursor_soft_1", stdout)
      expect({ shell, kind: result.outcome?.kind }).toEqual({ shell, kind: "backgrounded" })
      const pid = String((result.outcome as { shellId: number }).shellId)
      expect(result.output).toBe(`start-\nStill running in the background (pid ${pid}) after 100ms.\n`)
      expect(await finished(path.join(folder, `${pid}.txt`))).toMatch(terminalFile(pid, "/w", "succeeded", "start-€ end\n", 0))
    }
  }, 30_000)

  it("keeps its control files in the terminals folder when the temporary directory is unavailable", async () => {
    const TMPDIR = path.join(tempDir(), "missing")
    for (const shell of wrapperShells) {
      for (const hardTimeoutMs of [undefined, 8_000]) {
        const folder = tempDir()
        const command = "(sleep 1; echo child) & echo parent; exit 3"
        const stdout = spawnSync(shell, ["-c", softPolicy(folder, command, 3_000, hardTimeoutMs)], { encoding: "utf8", timeout: 20_000, env: { ...process.env, TMPDIR } }).stdout
        expect({ shell, hardTimeoutMs, result: consumeCursorShellResult("cursor_soft_1", stdout) })
          .toEqual({ shell, hardTimeoutMs, result: { output: "parent\nchild\n", outcome: { kind: "exit", code: 3 } } })
        expect(fs.readdirSync(folder)).toEqual([])
      }
      const folder = tempDir()
      const stdout = spawnSync(shell, ["-c", softPolicy(folder, "sleep 30", 5_000, 300)], { encoding: "utf8", timeout: 20_000, env: { ...process.env, TMPDIR } }).stdout
      expect({ shell, outcome: consumeCursorShellResult("cursor_soft_1", stdout).outcome }).toEqual({ shell, outcome: { kind: "timeout", timeoutMs: 300 } })
      expect(fs.readdirSync(folder)).toEqual([])
    }

    // After a handoff, the runner and the watchdog remove them once done.
    const folder = tempDir()
    const result = consumeCursorShellResult("cursor_soft_1", run(softPolicy(folder, "sleep 1", 300, 5_000), { TMPDIR }))
    expect(result.outcome).toMatchObject({ kind: "backgrounded" })
    const pid = String((result.outcome as { shellId: number }).shellId)
    await finished(path.join(folder, `${pid}.txt`))
    for (let i = 0; i < 80 && fs.readdirSync(folder).length > 1; i++) await Bun.sleep(25)
    expect(fs.readdirSync(folder)).toEqual([`${pid}.txt`])
  }, 60_000)

  it("keeps a command from starting when the hard timeout stops the runner while it starts up", () => {
    for (const shell of wrapperShells) {
      const folder = tempDir()
      const tmp = tempDir()
      const marker = path.join(tempDir(), "ran")
      const shim = tempDir()
      const realMkfifo = spawnSync("sh", ["-c", "command -v mkfifo"], { encoding: "utf8" }).stdout.trim()
      fs.writeFileSync(path.join(shim, "mkfifo"), `#!/bin/sh\nsleep 2.5\nexec ${realMkfifo} "$@"\n`, { mode: 0o755 })
      // The window ends while the runner is still starting up, and the hard timeout before it is done.
      const started = Date.now()
      const stdout = spawnSync(shell, ["-c", softPolicy(folder, `echo ran > '${marker}'`, 200, 1_000)], {
        encoding: "utf8",
        timeout: 20_000,
        env: { ...process.env, PATH: `${shim}:${process.env.PATH}`, TMPDIR: tmp },
      }).stdout
      expect({ shell, outcome: consumeCursorShellResult("cursor_soft_1", stdout).outcome }).toEqual({ shell, outcome: { kind: "timeout", timeoutMs: 1_000 } })
      expect(Date.now() - started).toBeLessThan(2_000)
      Bun.sleepSync(Math.max(0, started + 3_000 - Date.now()))
      expect(fs.existsSync(marker)).toBe(false)
      expect(fs.readdirSync(tmp)).toEqual([])
      expect(fs.readdirSync(folder)).toEqual([])
    }
  }, 30_000)

  it("does not take output that looks like a footer for the exit code of a killed runner", () => {
    for (const shell of wrapperShells) {
      const folder = tempDir()
      const command = "printf 'exit_code: 0\\n'; sleep 0.2; kill -KILL $PPID; sleep 0.3"
      const stdout = spawnSync(shell, ["-c", softPolicy(folder, command, 3_000)], { encoding: "utf8", timeout: 20_000 }).stdout
      const result = consumeCursorShellResult("cursor_soft_1", stdout)
      expect({ shell, kind: result.outcome?.kind }).toEqual({ shell, kind: "exit" })
      expect((result.outcome as { code: number }).code).not.toBe(0)
    }
  }, 20_000)

  it("reports the hard timeout and stops the command", () => {
    const folder = tempDir()
    const started = Date.now()
    const result = consumeCursorShellResult("cursor_soft_1", run(softPolicy(folder, "sleep 30", 5_000, 300)))
    expect(result.outcome).toEqual({ kind: "timeout", timeoutMs: 300 })
    expect(Date.now() - started).toBeLessThan(4_000)
    expect(fs.readdirSync(folder)).toEqual([])
  })

  it("marks a command the hard timeout stops after the handoff as aborted, and leaves no status file", async () => {
    const folder = tempDir()
    const tmp = tempDir()
    const stdout = run(softPolicy(folder, "trap 'exit 0' TERM; printf 'start\\n'; sleep 5 >/dev/null 2>&1 & wait", 200, 1500), { TMPDIR: tmp })
    const result = consumeCursorShellResult("cursor_soft_1", stdout)
    expect(result.outcome).toMatchObject({ kind: "backgrounded" })
    const pid = String((result.outcome as { shellId: number }).shellId)

    expect(await finished(path.join(folder, `${pid}.txt`))).toMatch(terminalFile(pid, "/w", "aborted", "start\n", 0))
    for (let i = 0; i < 40 && fs.readdirSync(tmp).length > 0; i++) await Bun.sleep(25)
    expect(fs.readdirSync(tmp)).toEqual([])
  }, 15_000)

  it.skipIf(process.getuid?.() === 0)("falls back to a temporary folder when the terminals folder is not writable", () => {
    const folder = tempDir()
    const tmp = tempDir()
    fs.chmodSync(folder, 0o555)
    const quick = consumeCursorShellResult("cursor_soft_1", run(softPolicy(folder, "printf 'hi\\n'; exit 4", 2_000), { TMPDIR: tmp }))
    expect(quick).toEqual({ output: "hi\n", outcome: { kind: "exit", code: 4 } })
    expect(fs.readdirSync(tmp)).toEqual([])

    const slow = consumeCursorShellResult("cursor_soft_1", run(softPolicy(folder, "printf 'start\\n'; sleep 1", 300), { TMPDIR: tmp }))
    expect(slow.outcome).toMatchObject({ kind: "backgrounded", msToWait: 300 })
    expect(slow.output).toStartWith("start\n")
    expect(fs.readdirSync(folder)).toEqual([])
  })
})

describe("exec mapping", () => {
  const context = { terminalsFolder: "/cache/terminals", workspaceRoot: "/w" }

  it("points background spawns at the advertised terminals folder", () => {
    const parsed = parseExecServerMessage({ id: 1, background_shell_spawn_args: { command: "npm run dev" } }, undefined, context)!
    expect(parsed.resultMetadata).toMatchObject({ terminals_folder: "/cache/terminals", terminal_cwd: "/w" })
    expect(parsed.args.command).toContain("cursor-shell")
    expect(parsed.args.command).toContain("bg_dir='/cache/terminals'")

    const legacy = parseExecServerMessage({ id: 1, background_shell_spawn_args: { command: "npm run dev" } })!
    expect(legacy.resultMetadata).not.toHaveProperty("terminals_folder")
    expect(legacy.args.command).toContain("cursor-opencode-bg")
  })

  it("gives only soft-background shells a terminal target", () => {
    const soft = parseExecServerMessage({
      id: 2,
      shell_stream_args: { command: "make", working_directory: "/w/sub", timeout: 1000, timeout_behavior: 2 },
    }, undefined, context)!
    expect(soft.resultMetadata).toMatchObject({ terminals_folder: "/cache/terminals", terminal_cwd: "/w/sub" })
    const foreground = parseExecServerMessage({ id: 3, shell_stream_args: { command: "make" } }, undefined, context)!
    expect(foreground.resultMetadata).not.toHaveProperty("terminals_folder")
  })

  it("passes the call's description on as the terminal title", () => {
    const context = { terminalsFolder: "/cache/terminals", workspaceRoot: "/w" }
    const spawn = parseExecServerMessage({
      id: 4,
      background_shell_spawn_args: { command: "npm run dev", description: "Start dev server" },
    }, undefined, context)!
    expect(spawn.resultMetadata).toMatchObject({ terminal_title: "Start dev server" })
    expect(String(spawn.args.command)).toContain(`'title: "Start dev server"'`)
    const soft = parseExecServerMessage({
      id: 5,
      shell_stream_args: { command: "make", timeout: 1000, timeout_behavior: 2, description: "Build" },
    }, undefined, context)!
    expect(soft.resultMetadata).toMatchObject({ terminal_title: "Build" })
  })

  it("keeps OpenCode's background flag on an MCP shell call", () => {
    expect(mapCursorArgsToOpencode("shell", { command: "npm run dev", background: true }).args)
      .toEqual({ command: "npm run dev", background: true })
    expect(mapCursorArgsToOpencode("shell", { command: "ls", background: false }).args).toEqual({ command: "ls" })
  })
})

describe("terminal file reads", () => {
  const READ_AND_SHELL = [{ name: "read", description: "Read" }, { name: "bash", description: "Shell" }]

  function readSession(
    payloads: Uint8Array[],
    writes: Uint8Array[],
    root: string,
    folder: string,
    definitions = READ_AND_SHELL,
  ): CursorSession {
    let index = 0
    const frames: AsyncIterator<Frame> = {
      next: async () => index < payloads.length
        ? { done: false, value: { flags: 0, payload: payloads[index++]! } }
        : { done: true, value: undefined },
    }
    return {
      sessionId: "terminal-read-session",
      conversationId: "terminal-read-conversation",
      stream: {
        write(data: Uint8Array) { writes.push(data) },
        end() {},
        destroy() {},
        frames: () => ({ [Symbol.asyncIterator]: () => frames }),
      } as any,
      frames,
      pending: new Map(),
      displayToolCalls: new Map(),
      nextBridgedExecId: 900_000,
      blobs: new Map(),
      toolCatalog: definitions,
      toolDescriptors: toolsToDescriptors(definitions, "opencode", []),
      requestContext: { env: { workspace_paths: [root], terminals_folder: folder } },
      usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
      allowTools: true,
      pumpActive: true,
      heartbeat: null,
      expiresAt: Date.now() + 10_000,
    } as unknown as CursorSession
  }

  async function readThroughPump(
    root: string,
    folder: string,
    readArgs: Record<string, unknown>,
    variant = "read_args",
    definitions = READ_AND_SHELL,
    permitted?: string[],
  ) {
    const writes: Uint8Array[] = []
    const parts: any[] = []
    const session = readSession([
      encodeMessage("AgentServerMessage", { exec_server_message: { id: 31, [variant]: readArgs } }),
      encodeMessage("AgentServerMessage", { interaction_update: { turn_ended: { input_tokens: 1, output_tokens: 1 } } }),
    ], writes, root, folder, definitions)
    if (permitted) session.permittedToolNames = new Set(permitted)
    await pump(session, {
      enqueue(part: unknown) { parts.push(part) },
      error(error: Error) { throw error },
    } as unknown as ReadableStreamDefaultController<any>, { textId: "text", reasoningId: "reasoning" })
    const results = writes
      .map((frame) => decodeMessage<any>("AgentClientMessage", frame).exec_client_message?.read_result)
      .filter((result) => result !== undefined)
    return { results, toolCalls: parts.filter((part) => part.type === "tool-call") }
  }

  it("answers a read of a terminal file itself, with the requested line range", async () => {
    const root = tempDir()
    const folder = tempDir()
    const file = path.join(folder, "4242.txt")
    fs.writeFileSync(file, "---\npid: 4242\n---\nl1\nl2\nl3\n")

    const whole = await readThroughPump(root, folder, { path: file })
    expect(whole.toolCalls).toHaveLength(0)
    expect(whole.results[0].success).toMatchObject({ path: file, content: "---\npid: 4242\n---\nl1\nl2\nl3\n", range_applied: false })

    const range = await readThroughPump(root, folder, { path: file, offset: 4, limit: 2 })
    expect(range.results[0].success).toMatchObject({ content: "l1\nl2\n", range_applied: true })

    const past = await readThroughPump(root, folder, { path: file, offset: 40 })
    expect(past.results[0].success).toMatchObject({ content: "", range_applied: false })
  })

  it("says so when a line range past the read size limit stops at the byte limit", async () => {
    const root = tempDir()
    const folder = tempDir()
    const file = path.join(folder, "80.txt")
    fs.writeFileSync(file, "---\npid: 80\n---\n")
    fs.truncateSync(file, 51 * 1024 * 1024)
    fs.appendFileSync(file, "\nlast\n")

    const read = await readThroughPump(root, folder, { path: file, offset: 4, limit: 1 })

    const success = read.results[0].success
    expect(success).toMatchObject({ truncated: true, range_applied: true })
    expect(success.content).toEndWith("\n\n[Partial read: the content above stops at the 1048576-byte limit, inside line 4. It is NOT the complete range requested.]")
  })

  it("does not cut a multi-byte character at the byte limit", async () => {
    const folder = tempDir()
    const file = path.join(folder, "81.txt")
    const limit = 1024 * 1024
    // Line 1 reaches the limit at the end of the first chunk read; line 3 inside a later one.
    fs.writeFileSync(file, `${"a".repeat(limit - 1)}€\nshort\n${"b".repeat(limit - 2)}€€\n`)
    fs.truncateSync(file, 51 * 1024 * 1024)
    for (const [offset, kept] of [[1, "a".repeat(limit - 1)], [3, `${"b".repeat(limit - 2)}`]] as const) {
      const frames = await buildTerminalFileReadMessages(31, file, file, { offset, limit: 1 })
      const content: string = decodeMessage<any>("AgentClientMessage", frames![0]!).exec_client_message.read_result.success.content
      expect(content.startsWith(`${kept}\n\n[Partial read:`)).toBe(true)
      expect(content).not.toContain("\uFFFD")
    }
  })

  it("leaves a terminal file read to OpenCode for an agent whose shell is not permitted this turn", async () => {
    const root = tempDir()
    const folder = tempDir()
    const file = path.join(folder, "4246.txt")
    fs.writeFileSync(file, "---\npid: 4246\n---\nok\n")

    const read = await readThroughPump(root, folder, { path: file }, "read_args", READ_AND_SHELL, ["read"])

    expect(read.results).toHaveLength(0)
    expect(read.toolCalls.map((call) => call.toolName)).toEqual(["read"])
  })

  it("answers a terminal file read for an agent with a shell but no read tool", async () => {
    const root = tempDir()
    const folder = tempDir()
    const file = path.join(folder, "4244.txt")
    fs.writeFileSync(file, "---\npid: 4244\n---\nok\n")

    const read = await readThroughPump(root, folder, { path: file }, "read_args", [{ name: "bash", description: "Shell" }])

    expect(read.toolCalls).toHaveLength(0)
    expect(read.results[0].success).toMatchObject({ content: "---\npid: 4244\n---\nok\n" })
  })

  it("applies a requested line range to a terminal file past the read size limit", async () => {
    const root = tempDir()
    const folder = tempDir()
    const file = path.join(folder, "78.txt")
    fs.writeFileSync(file, "---\npid: 78\n---\n")
    fs.truncateSync(file, 51 * 1024 * 1024)
    fs.appendFileSync(file, "\nlast\n")

    const read = await readThroughPump(root, folder, { path: file, offset: 2, limit: 1 })

    expect(read.results[0].success).toMatchObject({ content: "pid: 78\n", total_lines: 6, range_applied: true, truncated: false })
  })

  it("keeps the end of a single output line longer than the tail it shows", async () => {
    const root = tempDir()
    const folder = tempDir()
    const file = path.join(folder, "79.txt")
    fs.writeFileSync(file, "---\npid: 79\n---\n")
    fs.truncateSync(file, 51 * 1024 * 1024)
    fs.appendFileSync(file, "END OF THE LINE\n---\nexit_code: 0\nended_at: 2026-10-06T00:00:00Z\n---\n")

    const read = await readThroughPump(root, folder, { path: file })

    expect(read.results[0].success.content).toContain("END OF THE LINE\n---\nexit_code: 0\n")
  })

  it("keeps the header and latest output of a terminal file past the read size limit", async () => {
    const root = tempDir()
    const folder = tempDir()
    const file = path.join(folder, "77.txt")
    const header = '---\npid: 77\ncwd: "/w"\ncommand: "npm run dev"\ntitle: "Dev server"\nstatus: running  \nstarted_at: 2026-10-06T00:00:00Z\nrunning_for_ms: 0        \n---\n'
    fs.writeFileSync(file, `${header}first line of output\n`)
    fs.truncateSync(file, 51 * 1024 * 1024)
    fs.appendFileSync(file, "\nlatest line of output\n")

    const read = await readThroughPump(root, folder, { path: file })

    expect(read.toolCalls).toHaveLength(0)
    const success = read.results[0].success
    expect(success.truncated).toBe(true)
    expect(success.total_lines).toBe(13)
    expect(success.content).toStartWith(`${header}[`)
    expect(success.content).toContain("bytes of earlier output omitted]\n")
    expect(success.content).toEndWith("latest line of output\n")
  })

  it("keeps a header longer than 64 KiB on a terminal file past the read size limit", async () => {
    const root = tempDir()
    const folder = tempDir()
    const file = path.join(folder, "76.txt")
    const header = `---\npid: 76\ncwd: "/w"\ncommand: "${"x".repeat(200 * 1024)}"\nstatus: running  \nstarted_at: 2026-10-06T00:00:00Z\nrunning_for_ms: 0        \n---\n`
    fs.writeFileSync(file, `${header}first line of output\n`)
    fs.truncateSync(file, 51 * 1024 * 1024)
    fs.appendFileSync(file, "\nlatest line of output\n")

    const read = await readThroughPump(root, folder, { path: file })

    expect(read.results[0].success.content).toStartWith(`${header}[`)
  })

  it("answers a read of a terminal file not written yet with file_not_found", async () => {
    const root = tempDir()
    const folder = tempDir()
    const file = path.join(folder, "55.txt")

    const read = await readThroughPump(root, folder, { path: file })

    expect(read.toolCalls).toHaveLength(0)
    expect(read.results[0].file_not_found).toMatchObject({ path: file })
  })

  it("refuses a terminal file reached through a terminals folder that is a link", async () => {
    const real = tempDir()
    fs.writeFileSync(path.join(real, "7.txt"), "---\npid: 7\n---\n")
    const folder = path.join(tempDir(), "terminals")
    fs.symlinkSync(real, folder)

    expect(await buildTerminalFileReadMessages(31, path.join(folder, "7.txt"))).toBeUndefined()
  })

  it("leaves a terminal file read to OpenCode for an agent without a shell", async () => {
    const root = tempDir()
    const folder = tempDir()
    const file = path.join(folder, "4245.txt")
    fs.writeFileSync(file, "---\npid: 4245\n---\nok\n")

    const read = await readThroughPump(root, folder, { path: file }, "read_args", [{ name: "read", description: "Read" }])

    expect(read.results).toHaveLength(0)
    expect(read.toolCalls.map((call) => call.toolName)).toEqual(["read"])
  })

  it("reads a terminal file without holding up other work, and counts its lines afresh each time", async () => {
    const folder = tempDir()
    const file = path.join(folder, "75.txt")
    const success = async (range: { offset?: number; limit?: number }) =>
      decodeMessage<any>("AgentClientMessage", (await buildTerminalFileReadMessages(31, file, file, range))![0]!)
        .exec_client_message.read_result.success

    for (const size of [20 * 1024 * 1024, 51 * 1024 * 1024]) {
      fs.writeFileSync(file, "\n".repeat(size))
      let ticks = 0
      const timer = setInterval(() => ticks++, 1)
      const read = await success({ offset: 3, limit: 1 })
      clearInterval(timer)
      expect(read).toMatchObject({ content: "\n", total_lines: size + 1 })
      expect(ticks).toBeGreaterThan(0)
    }

    fs.writeFileSync(file, "---\npid: 75\n---\n")
    fs.truncateSync(file, 51 * 1024 * 1024)
    const lines = Array.from({ length: 70_000 }, (_, i) => `line ${i + 1}\n`).join("")
    fs.appendFileSync(file, `\n${lines}`)
    expect(await success({ offset: 70_000, limit: 2 })).toMatchObject({ content: "line 69996\nline 69997\n", total_lines: 70_005 })
    fs.appendFileSync(file, "line 70001\n")
    expect(await success({ offset: 70_005, limit: 1 })).toMatchObject({ content: "line 70001\n", total_lines: 70_006 })

    // Rewritten in place to the same size and the same end, with lines of other lengths before it.
    const rewrite = (line: string, count: number) => {
      const fd = fs.openSync(file, "r+")
      fs.ftruncateSync(fd, 0)
      fs.writeSync(fd, Buffer.alloc(51 * 1024 * 1024, "y"), 0, 51 * 1024 * 1024, 0)
      fs.writeSync(fd, `\n${line.repeat(count)}bbbb\nend\n`, 51 * 1024 * 1024)
      fs.closeSync(fd)
    }
    rewrite("aa\n", 65_536)
    expect(await success({ offset: 65_538, limit: 1 })).toMatchObject({ content: "bbbb\n", total_lines: 65_540 })
    rewrite("a\n", 98_304)
    expect(await success({ offset: 65_538, limit: 1 })).toMatchObject({ content: "a\n", total_lines: 98_308 })
    expect(await success({ offset: 98_306, limit: 1 })).toMatchObject({ content: "bbbb\n", total_lines: 98_308 })
  }, 20_000)

  it("leaves a Pi read of a terminal file to OpenCode, which answers with its own result type", async () => {
    const root = tempDir()
    const folder = tempDir()
    const file = path.join(folder, "4243.txt")
    fs.writeFileSync(file, "---\npid: 4243\n---\nok\n")

    const read = await readThroughPump(root, folder, { path: file }, "pi_read_args")

    expect(read.results).toHaveLength(0)
    expect(read.toolCalls.map((call) => call.toolName)).toEqual(["read"])
  })

  it("leaves other files in the folder, and links out of it, to OpenCode", async () => {
    const root = tempDir()
    const folder = tempDir()
    const outside = path.join(tempDir(), "secret.txt")
    fs.writeFileSync(outside, "secret\n")
    fs.symlinkSync(outside, path.join(folder, "7.txt"))
    fs.writeFileSync(path.join(folder, "notes.txt"), "notes\n")
    fs.symlinkSync("notes.txt", path.join(folder, "8.txt"))

    for (const name of ["7.txt", "notes.txt", "8.txt"]) {
      const read = await readThroughPump(root, folder, { path: path.join(folder, name) })
      expect(read.results).toHaveLength(0)
      expect(read.toolCalls.map((call) => call.toolName)).toEqual(["read"])
      sessionManager.dispose()
    }
  })

  it("refuses a link out of the folder swapped in after the caller's check", async () => {
    const folder = tempDir()
    const outside = path.join(tempDir(), "secret.txt")
    fs.writeFileSync(outside, "secret\n")
    const file = path.join(folder, "7.txt")
    fs.symlinkSync(outside, file)

    expect(await buildTerminalFileReadMessages(31, file)).toBeUndefined()
  })

  it("leaves a hard link to a file outside the folder to OpenCode", async () => {
    const root = tempDir()
    const folder = tempDir()
    const outside = path.join(tempDir(), "secret.txt")
    fs.writeFileSync(outside, "secret\n")
    fs.linkSync(outside, path.join(folder, "9.txt"))

    const read = await readThroughPump(root, folder, { path: path.join(folder, "9.txt") })

    expect(read.results).toHaveLength(0)
    expect(read.toolCalls.map((call) => call.toolName)).toEqual(["read"])
  })

  it("does not block on a FIFO swapped in at a terminal path", async () => {
    const folder = tempDir()
    const file = path.join(folder, "10.txt")
    expect(spawnSync("mkfifo", [file]).status).toBe(0)

    expect(await buildTerminalFileReadMessages(31, file)).toBeUndefined()
  })
})

describe("terminal file sweep", () => {
  it("removes terminal files untouched for a week and nothing else", () => {
    const folder = tempDir()
    const old = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000
    const gone = `${spawnSync("true").pid}.txt`
    const live = `${process.pid}.txt`
    for (const name of [gone, live, "2.txt", "notes.txt"]) fs.writeFileSync(path.join(folder, name), "x")
    for (const name of [gone, live, "notes.txt"]) fs.utimesSync(path.join(folder, name), old, old)

    sweepStaleTerminalFiles(folder)

    // A process with that pid may be a runner about to replace the old file with its own.
    expect(fs.readdirSync(folder).sort()).toEqual([live, "2.txt", "notes.txt"].sort())
  })

  it("leaves a terminal-named link to an old file outside the folder", () => {
    const folder = tempDir()
    const outside = path.join(tempDir(), "kept.txt")
    fs.writeFileSync(outside, "x")
    const old = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000
    fs.utimesSync(outside, old, old)
    fs.symlinkSync(outside, path.join(folder, "3.txt"))

    sweepStaleTerminalFiles(folder)

    expect(fs.readdirSync(folder)).toEqual(["3.txt"])
    expect(fs.existsSync(outside)).toBe(true)
  })

  it("leaves old files in a folder reached through a terminals folder that is a link", () => {
    const real = tempDir()
    fs.writeFileSync(path.join(real, "1.txt"), "x")
    const old = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000
    fs.utimesSync(path.join(real, "1.txt"), old, old)
    const folder = path.join(tempDir(), "terminals")
    fs.symlinkSync(real, folder)

    sweepStaleTerminalFiles(folder)

    expect(fs.readdirSync(real)).toEqual(["1.txt"])
  })
})
