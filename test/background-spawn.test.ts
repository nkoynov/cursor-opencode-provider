import { expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { buildBackgroundShellCommand } from "../src/shell-timeout.js"
import { reapBackgroundSpawn } from "./background-spawn.js"

it("keeps a background spawn running when the host kills its exited launcher's process group", async () => {
  if (!Bun.which("setsid")) return
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-bg-evict-"))
  let stdout = ""
  try {
    const go = path.join(root, "go")
    const done = path.join(root, "done")
    const quoted = (file: string) => `'${file.replaceAll("'", "'\\''")}'`
    const command = `while [ ! -f ${quoted(go)} ]; do sleep 0.05; done; echo finished > ${quoted(done)}`
    const launcher = Bun.spawn([Bun.which("setsid")!, "/bin/sh", "-c", buildBackgroundShellCommand(command, "/bin/sh")], { stdout: "pipe", stderr: "pipe" })
    stdout = await new Response(launcher.stdout).text()
    await launcher.exited
    // The daemon kills the group only after 25 later commands exited, long
    // after the spawn's own setsid ran; wait for that instead of racing it.
    const spawned = /__CURSOR_BACKGROUND_SHELL__(\d+):/.exec(stdout)![1]
    const group = () => { try { return Number(fs.readFileSync(`/proc/${spawned}/stat`, "utf8").split(") ")[1]!.split(" ")[2]) } catch { return 0 } }
    const settle = Date.now() + 2000
    while (group() === launcher.pid && Date.now() < settle) await Bun.sleep(10)
    try { process.kill(-launcher.pid, "SIGKILL") } catch { /* no member left */ }
    fs.writeFileSync(go, "")
    const end = Date.now() + 5000
    while (!fs.existsSync(done) && Date.now() < end) await Bun.sleep(25)
    expect(fs.readFileSync(done, "utf8")).toBe("finished\n")
  } finally {
    if (stdout) await reapBackgroundSpawn(stdout)
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 15_000)

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
