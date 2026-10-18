// Import first in every Node test script: the `bun test` preload's TMPDIR guard
// (test/preload.ts) for scripts that run under node. The script gets a private
// TMPDIR, anything it leaves there fails it, and the directory is removed.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const runTmp = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-node-test-"))
process.env.TMPDIR = runTmp
process.env.TMP = runTmp
process.env.TEMP = runTmp

process.on("exit", () => {
  const left = fs.readdirSync(runTmp)
  fs.rmSync(runTmp, { recursive: true, force: true })
  if (left.length > 0) {
    console.error(`${path.basename(process.argv[1] ?? "node test")} left ${left.length} entries in TMPDIR: ${left.slice(0, 20).join(", ")}`)
    process.exitCode = 1
  }
})
