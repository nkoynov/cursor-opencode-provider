import { expect, it, spyOn } from "bun:test"
import * as childProcess from "node:child_process"
import fs from "node:fs"
import { processTable, stopProcessesUsing } from "./process-cleanup.js"

function mockPs(stdout: string, status = 0) {
  const exists = fs.existsSync
  const procfs = spyOn(fs, "existsSync").mockImplementation(file => String(file) === "/proc/self/stat" ? false : exists(file))
  const ps = spyOn(childProcess, "spawnSync").mockReturnValue({
    pid: 0, output: [null, stdout, "inspection denied"], stdout, stderr: "inspection denied", status, signal: null,
  })
  return () => { ps.mockRestore(); procfs.mockRestore() }
}

it("fails cleanup explicitly when the process table cannot be inspected", () => {
  const restore = mockPs("", 1)
  try { expect(processTable).toThrow("Cannot inspect test processes") } finally { restore() }
})

it("does not swallow permission errors when stopping a test writer", async () => {
  const restore = mockPs("123456 1 test-writer cleanup-fixture\n")
  const kill = spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("kill denied"), { code: "EPERM" })
  })
  try {
    await expect(stopProcessesUsing("cleanup-fixture", 0)).rejects.toThrow("kill denied")
  } finally { kill.mockRestore(); restore() }
})

it("refuses to remove a directory while a writer survives termination", async () => {
  const restore = mockPs("123456 1 test-writer cleanup-fixture\n")
  const kill = spyOn(process, "kill").mockReturnValue(true)
  try {
    await expect(stopProcessesUsing("cleanup-fixture", 0)).rejects.toThrow("Test processes still use the temporary directory")
  } finally { kill.mockRestore(); restore() }
})
