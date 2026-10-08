import { statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { OpencodeToolDef } from "../protocol/tools.js"
import {
  skillsBridge,
  type HostSkill,
} from "./skills-bridge.js"

/**
 * Cursor path-desc `agent_skills`: `{ full_path, description }` only, plus
 * `agent_skills_info_complete: true`. Catalog text in the frozen system-
 * instructions rule is the permission filter and order; locations come from
 * the structural `opencode.host.skills` bridge, else OpenCode 2 `skill.list()`
 * files remembered by the plugin, else OpenCode 1 catalog `<location>`.
 *
 * No content on the wire. Built-in / marker locations stay on the host `skill`
 * tool only.
 */

// Plugin and language-model can load separate module graphs (see image-staging).
const HOST_SKILL_FILES = Symbol.for("cursor-opencode-provider.host-skill-files")
const globals = globalThis as typeof globalThis & {
  [HOST_SKILL_FILES]?: Map<string, ReadonlyMap<string, string>>
}
const byDirectory = globals[HOST_SKILL_FILES] ??= new Map<string, ReadonlyMap<string, string>>()
const MAX_DIRECTORIES = 64

export type HostSkillFileEntry = { readonly id: string; readonly path: string }

export type AgentSkillWire = { readonly full_path: string; readonly description: string }

const CATALOG = /<available_skills>([\s\S]*?)<\/available_skills>/
// Names and descriptions are unescaped; OpenCode 1 escapes locations only.
const ENTRY_OC2 =
  /<skill>\s*<id>([\s\S]*?)<\/id>\s*<name>[\s\S]*?<\/name>\s*<description>([\s\S]*?)<\/description>\s*<\/skill>/g
const ENTRY_OC1 =
  /<skill>\s*<name>([\s\S]*?)<\/name>\s*<description>([\s\S]*?)<\/description>\s*<location>([\s\S]*?)<\/location>\s*<\/skill>/g

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

function hasUriScheme(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)
}

/** Locations Cursor can advertise; markers / builtins are omitted. */
export function isUsableSkillLocation(location: string | undefined): boolean {
  if (typeof location !== "string") return false
  const value = location.trim()
  if (!value) return false
  if (value === "<built-in>" || value === "builtin") return false
  if (value.startsWith("/builtin/")) return false
  if (hasUriScheme(value)) {
    if (value.startsWith("file:")) {
      try {
        const filePath = fileURLToPath(value)
        return path.isAbsolute(filePath) && isFile(filePath)
      } catch {
        return false
      }
    }
    // Host URIs such as skill://name — keep for bridge hosts; no disk check.
    return true
  }
  return path.isAbsolute(value) && isFile(value)
}

export function normalizeSkillLocation(location: string): string {
  const value = location.trim()
  if (value.startsWith("file:")) {
    try {
      return fileURLToPath(value)
    } catch {
      return value
    }
  }
  return value
}

export function skillToolAdvertised(tools: readonly OpencodeToolDef[] | undefined): boolean {
  return (tools ?? []).some((tool) => tool?.name === "skill")
}

/** Record skill files a Location's host currently registers (OpenCode 2 plugin). */
export function rememberHostSkillFiles(directory: string, skills: readonly HostSkillFileEntry[]): void {
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

type CatalogEntry = {
  key: string
  description: string
  location?: string
}

/** Undo OpenCode 1's escapeHtml once; literal entity text in paths must survive. */
function decodeCatalogLocation(value: string): string {
  const entities: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" }
  return value.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => entities[entity]!)
}

function parseCatalogEntries(systemText: string): CatalogEntry[] {
  const catalog = CATALOG.exec(systemText)?.[1]
  if (!catalog) return []
  const out: CatalogEntry[] = []
  const seen = new Set<string>()

  for (const match of catalog.matchAll(ENTRY_OC2)) {
    const id = match[1]?.trim()
    const description = match[2] ?? ""
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({ key: id, description: description.trim() })
  }
  if (out.length > 0) return out

  for (const match of catalog.matchAll(ENTRY_OC1)) {
    const name = match[1]?.trim()
    const description = match[2] ?? ""
    const location = match[3] ? decodeCatalogLocation(match[3].trim()) : undefined
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push({
      key: name,
      description: description.trim(),
      location: location || undefined,
    })
  }
  return out
}

function locationFromBridge(
  entry: CatalogEntry,
  bridgeSkills: readonly HostSkill[] | undefined,
): string | undefined {
  if (!bridgeSkills?.length) return undefined
  const byId = bridgeSkills.find((skill) => skill.id === entry.key && isUsableSkillLocation(skill.location))
  if (byId?.location) return normalizeSkillLocation(byId.location)
  const byName = bridgeSkills.find((skill) => skill.name === entry.key && isUsableSkillLocation(skill.location))
  if (byName?.location) return normalizeSkillLocation(byName.location)
  return undefined
}

/**
 * path-desc `agent_skills` for cataloged skills that have a usable location,
 * in catalog order. Descriptions come from the catalog (epoch-stable).
 */
export function agentSkillsForCursor(
  systemText: string | undefined,
  options: {
    skillToolAdvertised: boolean
    skillFiles?: ReadonlyMap<string, string>
    bridgeSkills?: readonly HostSkill[]
  },
): AgentSkillWire[] {
  if (!options.skillToolAdvertised || !systemText) return []
  const entries = parseCatalogEntries(systemText)
  if (entries.length === 0) return []

  const out: AgentSkillWire[] = []
  const seenPaths = new Set<string>()
  for (const entry of entries) {
    let location = locationFromBridge(entry, options.bridgeSkills)
    if (!location) {
      const file = options.skillFiles?.get(entry.key)
      if (file && isUsableSkillLocation(file)) location = file
    }
    if (!location && entry.location && isUsableSkillLocation(entry.location)) {
      location = normalizeSkillLocation(entry.location)
    }
    if (!location || seenPaths.has(location)) continue
    seenPaths.add(location)
    out.push({ full_path: location, description: entry.description })
  }
  return out
}

/** Fetch locations from the structural bridge when installed. */
export async function loadBridgeSkills(input: {
  workspaceRoot: string
  sessionID?: string
}): Promise<HostSkill[] | undefined> {
  const bridge = skillsBridge()
  if (!bridge) return undefined
  try {
    const listed = await bridge.list({
      directory: path.resolve(input.workspaceRoot),
      sessionID: input.sessionID,
    })
    if (!Array.isArray(listed)) return undefined
    return listed.filter((skill): skill is HostSkill =>
      !!skill
      && typeof skill === "object"
      && typeof skill.name === "string"
      && typeof skill.description === "string",
    )
  } catch {
    return undefined
  }
}

export function applyAgentSkillsToContext(
  context: Record<string, unknown>,
  skills: readonly AgentSkillWire[],
): void {
  if (skills.length === 0) {
    delete context.agent_skills
    delete context.agent_skills_info_complete
    return
  }
  context.agent_skills = skills.map((skill) => ({
    full_path: skill.full_path,
    description: skill.description,
  }))
  context.agent_skills_info_complete = true
}
