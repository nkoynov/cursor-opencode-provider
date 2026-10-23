import { createHash } from "node:crypto"
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"

/**
 * Tool processes share the OpenCode server's cgroup, so without a nice
 * increment a busy test suite gets the same CPU share per process as the
 * server's single JavaScript thread and can starve its event stream.
 */
export const TOOL_NICE_ENV = "CURSOR_PROVIDER_TOOL_NICE"
export const DEFAULT_TOOL_NICE = 10
const MAX_NICE = 19

export function toolNiceIncrement(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[TOOL_NICE_ENV]?.trim()
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_TOOL_NICE
  return Math.min(MAX_NICE, Number(raw))
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** `exec <target>` lowered by `nice` when it is installed; `target` is already shell-quoted. */
export function niceExecLines(target: string, nice: number): string[] {
  if (nice <= 0) return [`exec ${target}`]
  return [
    `if command -v nice >/dev/null 2>&1; then exec nice -n ${nice} ${target}; fi`,
    `exec ${target}`,
  ]
}

// One directory per user, shared by servers and restarts: the adapters are
// keyed by their content, so a server killed by a signal leaves nothing new.
function adapterDirectory(): string {
  return join(tmpdir(), `cursor-opencode-nice-${process.getuid?.() ?? "user"}`)
}

/** Tests only: servers share the directory. */
export function resetToolNiceAdapters(): void {
  rmSync(adapterDirectory(), { recursive: true, force: true })
}

/**
 * An executable with the shell's basename (OpenCode picks `-c` and its
 * permission parser by that name) that runs the shell at `nice`. One per
 * shell and increment, rewritten when temp cleanup removed it.
 */
export function niceShellAdapter(shell: string, nice: number): string {
  const key = createHash("sha256").update(`${nice}\0${shell}`).digest("hex").slice(0, 16)
  const directory = join(adapterDirectory(), key)
  const executable = join(directory, basename(shell))
  if (existsSync(executable)) return executable
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const script = ["#!/bin/sh", ...niceExecLines(`${shellQuote(shell)} "$@"`, nice), ""].join("\n")
  const partial = `${executable}.${process.pid}.tmp`
  writeFileSync(partial, script, { mode: 0o700 })
  renameSync(partial, executable)
  return executable
}
