import fs from "node:fs"
import { BACKGROUND_SHELL_MARKER } from "../src/shell-timeout.js"
import { stopProcessTree } from "./process-cleanup.js"

/**
 * Stop a detached background spawn a test ran for real and remove the log
 * `buildBackgroundShellCommand` created for it, as named by its marker line.
 */
export async function reapBackgroundSpawn(stdout: string): Promise<void> {
  const match = new RegExp(`${BACKGROUND_SHELL_MARKER}(\\d+):(?:\\d+:)?([^\\r\\n]+)`).exec(stdout)
  if (!match) throw new Error(`no background spawn marker in: ${stdout}`)
  await stopProcessTree(Number(match[1]))
  fs.rmSync(match[2]!, { force: true })
}
