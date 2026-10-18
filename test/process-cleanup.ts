import { spawnSync } from "node:child_process"
import fs from "node:fs"

/** Live processes from procfs when present (minimal Linux images ship no `ps`), else `ps`. */
export function processTable(): { pid: number; ppid: number; command: string }[] {
  if (fs.existsSync("/proc/self/stat")) {
    return fs.readdirSync("/proc").filter(name => /^\d+$/.test(name)).flatMap(name => {
      try {
        const stat = fs.readFileSync(`/proc/${name}/stat`, "utf8")
        const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1])
        const command = fs.readFileSync(`/proc/${name}/cmdline`, "utf8").replaceAll("\0", " ").trim()
        return [{ pid: Number(name), ppid, command }]
      } catch { return [] }
    })
  }
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Cannot inspect test processes: ps exited ${result.status}: ${result.stderr}`)
  return result.stdout.split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! }] : []
  })
}

function killProcess(pid: number): void {
  try { process.kill(pid, "SIGKILL") } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
  }
}

/** Stop descendants first, allowing their owning shell to reap them. */
export async function stopProcessTree(pid: number): Promise<void> {
  const entries = processTable()
  const tree = [pid]
  for (let index = 0; index < tree.length; index++) {
    for (const entry of entries) {
      if (entry.ppid === tree[index] && !tree.includes(entry.pid)) tree.push(entry.pid)
    }
  }
  const waitGone = async (pids: number[]) => {
    const end = Date.now() + 2000
    while (pids.some(pid => {
      try { process.kill(pid, 0); return true } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
        return false
      }
    })) {
      if (Date.now() >= end) throw new Error(`Test processes did not stop: ${pids.join(", ")}`)
      await Bun.sleep(25)
    }
  }
  const descendants = tree.slice(1).reverse()
  for (const child of descendants) killProcess(child)
  await waitGone(descendants)
  killProcess(pid)
  await waitGone([pid])
}

/**
 * Before a test removes `dir`, wait for every process whose command line names
 * it (a terminal supervisor, launcher or collector), and kill those that do not
 * finish: they still write into `dir` and would recreate what was removed.
 */
export async function stopProcessesUsing(dir: string, waitMs = 3000): Promise<void> {
  const owners = () => processTable().filter(entry => entry.pid !== process.pid && entry.command.includes(dir))
  const settled = async (ms: number) => {
    const end = Date.now() + ms
    while (owners().length > 0) {
      if (Date.now() >= end) return false
      await Bun.sleep(25)
    }
    return true
  }
  if (await settled(waitMs)) return
  for (const { pid } of owners()) killProcess(pid)
  if (!await settled(2000)) throw new Error(`Test processes still use the temporary directory: ${owners().map(entry => entry.pid).join(", ")}`)
}
