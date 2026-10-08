import path from "node:path"
import {
  extractHostSubagentCatalog,
  toolsToMcpDescriptors,
  type HostSubagentDefinition,
  type OpencodeToolDef,
} from "../protocol/tools.js"
import {
  loadMergedConfig,
  type OpencodeJson,
} from "./rules.js"
import { collectPlugins } from "./plugins.js"
import { collectGit } from "./git.js"
import { collectProjectLayout } from "./layout.js"
import { buildEnv } from "./env.js"
import { ensureOpencodeProjectDir } from "./paths.js"
import { holdCapabilityOverlay } from "./overlay.js"
import {
  agentSkillsForCursor,
  applyAgentSkillsToContext,
  hostSkillFiles,
  loadBridgeSkills,
  skillToolAdvertised,
} from "./skills.js"
import { traceRequestContextPaths } from "../debug.js"

export type BuildRequestContextInput = {
  workspaceRoot: string
  tools?: OpencodeToolDef[]
  providerIdentifier?: string
  /** When set, skills/subagents/plugins are epoch-held for this conversation. */
  conversationId?: string
  /**
   * Preloaded merged `opencode.json` from the same Run (e.g. for interaction
   * guidance MCP server ids). Skips a second `loadMergedConfig` disk read.
   */
  mergedConfig?: OpencodeJson
  /** Host system context to deliver as the frozen system-instructions rule. */
  systemInstructions?: SystemInstructions
  /** Optional host session id for `opencode.host.skills` list(). */
  sessionID?: string
}

/**
 * Host system context (OpenCode's system prompt plus this provider's
 * interaction guidance) for one Cursor conversation.
 */
export type SystemInstructions = {
  text: string
  /**
   * True when `text` is this conversation's own frozen baseline (a Context
   * Epoch started in this process, or an ephemeral Run's prompt): it replaces
   * any rule already frozen. False when a restart recovered the epoch without
   * its bytes: the persisted rule wins and `text` only fills a missing one.
   */
  authoritative: boolean
}

/** Rule name Cursor shows for the host system context (not a file). */
export const SYSTEM_INSTRUCTIONS_RULE_PATH = "OpenCode system instructions"

/**
 * Cursor does not follow a client-seeded `system` message, and applies a rule
 * only by its type. The Cursor CLI sends AGENTS.md as `alwaysApply`
 * (`CursorRuleType.global`) and the IDE ships its own guidance as a non-file
 * global rule; the host system context goes out the same way, once, frozen
 * with the RequestContext base.
 */
export function systemInstructionsRule(text: string): Record<string, unknown> {
  return {
    full_path: SYSTEM_INSTRUCTIONS_RULE_PATH,
    content: text,
    type: { global: {} },
  }
}

function isSystemInstructionsRule(rule: unknown): rule is Record<string, unknown> {
  if (!rule || typeof rule !== "object") return false
  const record = rule as Record<string, unknown>
  const type = record.type as Record<string, unknown> | undefined
  return record.full_path === SYSTEM_INSTRUCTIONS_RULE_PATH && !!type?.global
    && typeof record.content === "string"
}

/** Text of the frozen system-instructions rule, if the context carries one. */
export function systemInstructionsRuleText(context: Record<string, unknown>): string | undefined {
  const rules = Array.isArray(context.rules) ? context.rules : []
  const rule = rules.find(isSystemInstructionsRule)
  return rule ? rule.content as string : undefined
}

/**
 * Return `context` with the system-instructions rule applied, or the same
 * object when nothing changes (see `SystemInstructions.authoritative`).
 */
export function withSystemInstructions(
  context: Record<string, unknown>,
  instructions: SystemInstructions | undefined,
): Record<string, unknown> {
  const text = instructions?.text.trim() ? instructions.text : undefined
  if (!text) return context
  const current = systemInstructionsRuleText(context)
  if (current !== undefined && (current === text || !instructions!.authoritative)) return context
  return { ...context, rules: [systemInstructionsRule(text)] }
}

/** Keep only the system-instructions rule; older bases carried untyped rules Cursor never applied. */
function keepSystemInstructionsRule(context: Record<string, unknown>): void {
  if (!Object.hasOwn(context, "rules")) return
  const rules = Array.isArray(context.rules) ? context.rules.filter(isSystemInstructionsRule) : []
  if (rules.length > 0) context.rules = rules.slice(0, 1)
  else delete context.rules
}

export const DYNAMIC_REQUEST_CONTEXT_KEYS = [
  "tools",
  "custom_subagents",
  "mcp_file_system_options",
  "mcp_meta_tool_options",
  "web_search_enabled",
  "web_fetch_enabled",
  "custom_subagents_info_complete",
  "mcp_file_system_info_complete",
  "mcp_info_complete",
  "hooks_additional_context",
] as const

export type DynamicRequestContextKey = typeof DYNAMIC_REQUEST_CONTEXT_KEYS[number]

/**
 * Derived from the system-instructions rule on every materialization (see
 * `skills.ts`); never kept on a frozen base.
 */
export const HOST_DUPLICATED_REQUEST_CONTEXT_KEYS = [
  "agent_skills",
  "agent_skills_info_complete",
] as const

type AdvertisedSubagentCatalog = {
  agents: HostSubagentDefinition[]
  complete: boolean
}

/**
 * Advertise only what the host `task` / `subagent` catalog already named.
 */
function buildAdvertisedSubagentCatalog(
  hostSubagents: ReturnType<typeof extractHostSubagentCatalog>,
): AdvertisedSubagentCatalog {
  if (!hostSubagents.executor) return { agents: [], complete: true }
  return { agents: hostSubagents.agents, complete: hostSubagents.complete }
}

function stripHostDuplicatedRequestContextFields(context: Record<string, unknown>): void {
  for (const key of HOST_DUPLICATED_REQUEST_CONTEXT_KEYS) delete context[key]
  keepSystemInstructionsRule(context)
}

/**
 * Full RequestContext payload for live UMA + exec #10 reply.
 * Workspace env/git/layout, the host system-instructions rule, and
 * host-advertised tools and subagents. The provider never looks in Cursor's
 * own directories.
 */
export async function buildRequestContext(
  input: BuildRequestContextInput,
): Promise<Record<string, unknown>> {
  const workspaceRoot = path.resolve(input.workspaceRoot || process.cwd())
  const config = input.mergedConfig ?? await loadMergedConfig(workspaceRoot)
  const [dynamic, git, layout] = await Promise.all([
    buildDynamicRequestContextFromDiscovery(input, workspaceRoot, config),
    collectGit(workspaceRoot),
    collectProjectLayout(workspaceRoot),
  ])

  const workspace: Record<string, unknown> = {
    env: buildEnv(workspaceRoot),
    repository_info: git.repositoryInfo,
    git_repos: git.gitRepos,
    project_layouts: [layout],
    rules_info_complete: true,
    env_info_complete: true,
    repository_info_complete: true,
    git_repo_info_complete: true,
    git_status_info_complete: true,
  }
  const base = withSystemInstructions(workspace, input.systemInstructions)
  const skillLocations = await resolveSkillLocations(input, workspaceRoot)
  const ctx = materializeRequestContext(base, dynamic, {
    tools: input.tools,
    ...skillLocations,
  })

  traceRequestContextPaths("buildRequestContext", ctx)
  return ctx
}

/** Locations for path-desc materialization (bridge, then remembered OC2 files). */
export async function resolveSkillLocations(
  input: Pick<BuildRequestContextInput, "tools" | "sessionID">,
  workspaceRoot: string,
): Promise<{ bridgeSkills?: Awaited<ReturnType<typeof loadBridgeSkills>>; skillFiles?: ReturnType<typeof hostSkillFiles> }> {
  if (!skillToolAdvertised(input.tools)) return {}
  return {
    bridgeSkills: await loadBridgeSkills({
      workspaceRoot,
      sessionID: input.sessionID,
    }),
    skillFiles: hostSkillFiles(workspaceRoot),
  }
}

async function buildDynamicRequestContextFromDiscovery(
  input: BuildRequestContextInput,
  workspaceRoot: string,
  config: OpencodeJson,
): Promise<Record<string, unknown>> {
  const providerIdentifier = input.providerIdentifier ?? "opencode"
  const tools = input.tools ?? []
  const plugins = await collectPlugins(workspaceRoot, config)

  const mcpServerNames = Object.keys(config.mcp ?? {})
  const slim = toolsToMcpDescriptors(tools, providerIdentifier, mcpServerNames, { namesOnly: true })
  const projectDir = ensureOpencodeProjectDir(workspaceRoot)
  const hostSubagents = extractHostSubagentCatalog(tools)
  const advertisedSubagents = buildAdvertisedSubagentCatalog(hostSubagents)
  const customSubagents = advertisedSubagents.agents.map((agent) => ({
    full_path: "",
    name: agent.name,
    description: agent.description || "Host-configured subagent.",
    prompt: `Delegate to the host-configured ${agent.name} subagent; its host instructions and tools apply.`,
  }))
  const livePlugins = plugins.map((p) => ({
    id: p.id,
    line: `opencode-plugin:${p.source}:${p.id}`,
  }))
  const overlay = input.conversationId
    ? holdCapabilityOverlay(input.conversationId, {
        subagents: customSubagents,
        plugins: livePlugins,
      })
    : { subagents: customSubagents, plugins: livePlugins }

  const dynamic: Record<string, unknown> = {
    mcp_file_system_options: {
      enabled: true,
      // Cursor metadata root (mcps / agent-tools), not the git workspace.
      workspace_project_dir: projectDir,
    },
    mcp_meta_tool_options: {
      enabled: true,
      ...(slim.length > 0 ? { mcp_descriptors: slim } : {}),
    },
    // This provider always rejects native web_search/web_fetch interaction
    // queries with a headless-UI reason (see interactions.ts). Advertise that
    // unavailability up front so Cursor prefers the collision-safe
    // custom_web* aliases instead of routing through a query doomed to fail.
    web_search_enabled: false,
    web_fetch_enabled: false,
    custom_subagents_info_complete: advertisedSubagents.complete,
    mcp_file_system_info_complete: true,
    mcp_info_complete: true,
  }
  if (overlay.subagents.length > 0) dynamic.custom_subagents = overlay.subagents

  if (overlay.plugins.length > 0) {
    dynamic.hooks_additional_context = overlay.plugins.map((p) => p.line).join("\n")
  }

  return dynamic
}

/** Rediscover only capability/plugin sections that may change during a chat. */
export async function buildDynamicRequestContext(
  input: BuildRequestContextInput,
): Promise<Record<string, unknown>> {
  const workspaceRoot = path.resolve(input.workspaceRoot || process.cwd())
  const config = input.mergedConfig
    ? input.mergedConfig
    : await loadMergedConfig(workspaceRoot)
  return buildDynamicRequestContextFromDiscovery(input, workspaceRoot, config)
}

export type MaterializeRequestContextOptions = {
  tools?: OpencodeToolDef[]
  skillFiles?: ReadonlyMap<string, string>
  bridgeSkills?: Awaited<ReturnType<typeof loadBridgeSkills>>
}

/**
 * Keep expensive workspace state frozen while replacing every live capability
 * field. Skill locations (bridge / OpenCode 2 files / OpenCode 1 catalog
 * paths) turn the skill catalog in the system-instructions rule into Cursor's
 * path-desc `agent_skills`.
 */
export function materializeRequestContext(
  base: Record<string, unknown>,
  dynamic: Record<string, unknown>,
  options?: MaterializeRequestContextOptions,
): Record<string, unknown> {
  const context = structuredClone(base)
  stripHostDuplicatedRequestContextFields(context)
  for (const key of DYNAMIC_REQUEST_CONTEXT_KEYS) delete context[key]
  for (const key of DYNAMIC_REQUEST_CONTEXT_KEYS) {
    if (Object.hasOwn(dynamic, key)) context[key] = structuredClone(dynamic[key])
  }
  const skills = agentSkillsForCursor(systemInstructionsRuleText(context), {
    skillToolAdvertised: skillToolAdvertised(options?.tools),
    skillFiles: options?.skillFiles,
    bridgeSkills: options?.bridgeSkills,
  })
  applyAgentSkillsToContext(context, skills)
  return context
}

/** Strip live capability fields before retaining/persisting a conversation base. */
export function requestContextBase(
  context: Record<string, unknown>,
): Record<string, unknown> {
  const base = structuredClone(context)
  stripHostDuplicatedRequestContextFields(base)
  for (const key of DYNAMIC_REQUEST_CONTEXT_KEYS) delete base[key]
  return base
}
