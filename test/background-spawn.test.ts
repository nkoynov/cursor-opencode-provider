import { expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { buildBackgroundShellCommand } from "../src/shell-timeout.js"
import { reapBackgroundSpawn } from "./background-spawn.js"

it("reaps a background shell's descendants before removing its log", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-bg-reap-"))
  let child: number | undefined
  let stdout = ""
  try {
    const pidFile = path.join(root, "child.pid")
    const command = `sleep 30 & echo $! > '${pidFile.replaceAll("'", "'\\''")}'; wait`
    const result = Bun.spawnSync(["/bin/sh", "-c", buildBackgroundShellCommand(command, "/bin/sh")], {
      stdout: "pipe", stderr: "pipe",
    })
    stdout = result.stdout.toString()
    const end = Date.now() + 3000
    while (!fs.existsSync(pidFile) && Date.now() < end) await Bun.sleep(10)
    child = Number(fs.readFileSync(pidFile, "utf8"))
    await reapBackgroundSpawn(stdout)
    expect(() => process.kill(child!, 0)).toThrow()
    const log = /__CURSOR_BACKGROUND_SHELL__\d+:([^\r\n]+)/.exec(stdout)![1]!
    expect(fs.existsSync(log)).toBe(false)
  } finally {
    if (child) { try { process.kill(child, "SIGKILL") } catch { /* already exited */ } }
    if (stdout) await reapBackgroundSpawn(stdout)
    fs.rmSync(root, { recursive: true, force: true })
  }
})
