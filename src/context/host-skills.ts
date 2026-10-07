import { statSync } from "node:fs"
import path from "node:path"

/**
 * Cursor models load a skill the way Cursor's own clients present one: an
 * `agent_skills` entry with the SKILL.md path, which they read. OpenCode's
 * skill catalog (in the host system context) names each skill but not its
 * file, and the `skill` tool is reachable only through the dynamic catalog,
 * so a Cursor model never loads a host skill on its own.
 *
 * The catalog in the frozen system-instructions rule decides which skills are
 * advertised (already filtered by the host's permissions, and byte-stable for
 * the epoch); the plugin's `skill.list()` supplies each file. A skill without a
 * real file (OpenCode's `/builtin/` skills) stays reachable through the
 * `skill` tool only. No content is sent: the model reads the file.
 */

// The plugin and the model can run in separate module graphs (see image-staging.ts).
const HOST_SKILL_FILES = Symbol.for("cursor-opencode-provider.host-skill-files")
const globals = globalThis as typeof globalThis & {
  [HOST_SKILL_FILES]?: Map<string, ReadonlyMap<string, string>>
}
const byDirectory = globals[HOST_SKILL_FILES] ??= new Map<string, ReadonlyMap<string, string>>()
const MAX_DIRECTORIES = 64

export type HostSkillEntry = { readonly id: string; readonly path: string }

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

/** Record the skill files a Location's host currently registers. */
export function rememberHostSkillFiles(directory: string, skills: readonly HostSkillEntry[]): void {
  const key = path.resolve(directory)
  const files = new Map<string, string>()
  for (const skill of skills) {
    if (typeof skill?.id !== "string" || typeof skill.path !== "string") continue
    if (!path.isAbsolute(skill.path) || !isFile(skill.path)) continue
    files.set(skill.id, skill.path)
  }
  byDirectory.delete(key)
  byDirectory.set(key, files)
  while (byDirectory.size > MAX_DIRECTORIES) {
    const oldest = byDirectory.keys().next().value as string | undefined
    if (oldest === undefined) break
    byDirectory.delete(oldest)
  }
}

export function hostSkillFiles(directory: string | undefined): ReadonlyMap<string, string> | undefined {
  return directory ? byDirectory.get(path.resolve(directory)) : undefined
}

/** Test helper. */
export function resetHostSkillFilesForTests(): void {
  byDirectory.clear()
}

const CATALOG = /<available_skills>([\s\S]*?)<\/available_skills>/
// OpenCode does not escape these fields, so a name may itself contain `<`.
const ENTRY = /<skill>\s*<id>([\s\S]*?)<\/id>\s*<name>[\s\S]*?<\/name>\s*<description>([\s\S]*?)<\/description>\s*<\/skill>/g

/**
 * `agent_skills` for the skills OpenCode's catalog (`core/skill-guidance`)
 * lists in `systemText`, in catalog order, for those with a known file.
 */
export function hostSkillsForCursor(
  systemText: string | undefined,
  files: ReadonlyMap<string, string> | undefined,
): Array<{ full_path: string; description: string }> {
  if (!systemText || !files || files.size === 0) return []
  const catalog = CATALOG.exec(systemText)?.[1]
  if (!catalog) return []
  const out: Array<{ full_path: string; description: string }> = []
  const seen = new Set<string>()
  for (const [, id, description] of catalog.matchAll(ENTRY)) {
    const file = files.get(id)
    if (!file || seen.has(id)) continue
    seen.add(id)
    out.push({ full_path: file, description: description.trim() })
  }
  return out
}
