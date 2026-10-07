import { describe, expect, it } from "bun:test"
import {
  buildDynamicCatalogRoutingInstruction,
  buildHostToolRouteLines,
  dynamicToolRoute,
  listAdvertisedMcpServers,
  resolveHostToolRoutes,
} from "../src/context/dynamic-catalog.js"
import { toolsToMcpDescriptors, type OpencodeToolDef } from "../src/protocol/tools.js"

const named = (...names: string[]): OpencodeToolDef[] => names.map((name) => ({ name }))

describe("listAdvertisedMcpServers", () => {
  it("names only configured servers that own an advertised tool", () => {
    expect(
      listAdvertisedMcpServers(
        [
          "skill",
          "read",
          "apply_patch",
          "cursor_image_save",
          "foo_bar",
          "context7_query-docs",
          "codesearch_find",
          "todowrite",
          "github_create_pull_request",
        ],
        ["github", "context7", "codesearch", "unused"],
      ),
    ).toEqual(["context7", "codesearch", "github"])
  })

  it("never infers servers from underscores without config", () => {
    expect(listAdvertisedMcpServers(["apply_patch", "foo_bar", "context7_query-docs"])).toEqual([])
  })

  it("resolves sanitized and prefix-overlapping server ids like the descriptors", () => {
    expect(
      listAdvertisedMcpServers(["my_docs_search", "git_hub_issue", "git_log"], ["my.docs", "git", "git_hub"]),
    ).toEqual(["my_docs", "git_hub", "git"])
  })
})

describe("buildDynamicCatalogRoutingInstruction", () => {
  it("returns undefined without skill or configured MCP tools", () => {
    expect(
      buildDynamicCatalogRoutingInstruction({
        toolNames: ["read", "grep", "custom_websearch", "apply_patch"],
      }),
    ).toBeUndefined()
  })

  it("names skill and configured MCP servers for GetDynamicTools routing", () => {
    const line = buildDynamicCatalogRoutingInstruction({
      toolNames: ["skill", "context7_query-docs", "read"],
      knownMcpServers: ["context7"],
    })
    expect(line).toContain("including `skill` and MCP servers such as `context7`")
    expect(line).toContain("GetDynamicTools / CallDynamicTool")
    expect(line).toContain("before Grep/Shell fallbacks")
    expect(line).toContain("Use the `skill` tool to load a skill when a task matches its description")
    expect(line).toContain("does not need to be invoked again")
  })

  it("reports servers beyond the listed limit", () => {
    const servers = Array.from({ length: 10 }, (_, i) => `srv${i}`)
    const line = buildDynamicCatalogRoutingInstruction({
      toolNames: servers.map((server) => `${server}_tool`),
      knownMcpServers: servers,
    })
    expect(line).toContain("`srv7` (+2 more)")
    expect(line).not.toContain("`srv8`")
  })
})

describe("resolveHostToolRoutes", () => {
  it("routes bridged host tools to native Cursor tools and every other tool through CallDynamicTool", () => {
    const tools = [
      ...named("edit", "execute", "glob", "grep", "question", "read", "shell", "skill"),
      { name: "subagent", description: "Available subagents: - general: General." },
      ...named("t3-code-abc_t3_thread_read", "linear_list_issues", "todowrite", "write"),
      { name: "custom_websearch", sourceName: "websearch" },
    ]
    const routes = resolveHostToolRoutes(tools)
    expect(Object.fromEntries(routes.native)).toEqual({
      shell: "Shell",
      read: "Read",
      write: "Write",
      edit: "StrReplace",
      glob: "Glob",
      grep: "Grep",
      question: "AskQuestion",
      subagent: "Task",
    })
    expect([...routes.dynamic.keys()]).toEqual([
      "execute",
      "skill",
      "t3-code-abc_t3_thread_read",
      "linear_list_issues",
      "todowrite",
      "custom_websearch",
    ])
    for (const target of routes.dynamic.values()) expect(target.namespace).toBe("opencode")
    expect(routes.dynamic.get("custom_websearch")?.toolName).toBe("custom_websearch")
  })

  it("names the namespace and tool name Cursor's catalog lists", () => {
    const tools = [
      ...named("read", "context7_query-docs", "github_create_pull_request", "execute"),
      { name: "custom_docs", sourceName: "context7_resolve" },
    ]
    const known = ["context7", "github"]
    const routes = resolveHostToolRoutes(tools, known)
    const catalog = toolsToMcpDescriptors(tools, "opencode", known, { namesOnly: true }).flatMap((server) =>
      (server.tools as Array<{ tool_name: string }>).map((tool) => `${server.server_identifier}/${tool.tool_name}`),
    )
    for (const tool of tools) {
      const target = routes.dynamic.get(tool.name)
      if (target) expect(catalog).toContain(`${target.namespace}/${target.toolName}`)
    }
    expect(routes.dynamic.get("context7_query-docs")).toEqual({ namespace: "context7", toolName: "query-docs" })
    expect(routes.dynamic.get("custom_docs")).toEqual({ namespace: "context7", toolName: "custom_docs" })
    expect(dynamicToolRoute(routes, "execute")).toBe(" through CallDynamicTool (namespace `opencode`)")
    expect(dynamicToolRoute(routes, "github_create_pull_request")).toBe(
      " through CallDynamicTool (namespace `github`, tool `create_pull_request`)",
    )
    expect(dynamicToolRoute(routes, "read")).toBe("")
  })

  it("follows the provider's executor, shell and apply_patch choices", () => {
    const both = resolveHostToolRoutes(named("task", "subagent", "bash", "shell", "edit", "write", "apply_patch"))
    expect(both.native.get("task")).toBe("Task")
    expect(both.native.get("bash")).toBe("Shell")
    expect(both.native.has("subagent")).toBe(false)
    expect(both.native.has("shell")).toBe(false)
    expect(both.native.has("apply_patch")).toBe(false)
    expect(both.dynamic.has("subagent")).toBe(true)

    expect(resolveHostToolRoutes(named("apply_patch", "read")).native.get("apply_patch")).toBe("StrReplace, Write")
    expect(resolveHostToolRoutes(named("apply_patch", "edit")).native.get("apply_patch")).toBe("Write")
    const interactions = resolveHostToolRoutes(named("plan_enter", "plan_exit", "cursor_plan_stage", "cursor_image_save"))
    expect(Object.fromEntries(interactions.native)).toEqual({
      plan_enter: "SwitchMode",
      plan_exit: "SwitchMode",
      cursor_plan_stage: "CreatePlan",
      cursor_image_save: "GenerateImage",
    })
  })
})

describe("buildHostToolRouteLines", () => {
  it("groups tools by route in advertised order", () => {
    const tools = named("read", "linear_list_issues", "execute", "shell", "context7_query-docs")
    const lines = buildHostToolRouteLines(tools, resolveHostToolRoutes(tools, ["context7"]))
    expect(lines).toEqual([
      "OpenCode host tools for this turn. None of these names is a Cursor top-level tool, so never call one by its own name as a top-level tool:",
      "- Through Cursor's native tools: `read` (Read), `shell` (Shell).",
      "- Through CallDynamicTool with namespace `opencode` and the tool name shown: `linear_list_issues`, `execute`.",
      "- Through CallDynamicTool with namespace `context7` and the tool name shown: `query-docs`.",
    ])
  })

  it("omits a group with no tools", () => {
    const nativeOnly = named("read", "grep")
    expect(buildHostToolRouteLines(nativeOnly, resolveHostToolRoutes(nativeOnly)).join("\n")).not.toContain("CallDynamicTool")
    const dynamicOnly = named("execute")
    expect(buildHostToolRouteLines(dynamicOnly, resolveHostToolRoutes(dynamicOnly)).join("\n")).not.toContain("native tools")
  })
})
