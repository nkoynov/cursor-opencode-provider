import { describe, expect, test } from "bun:test"
import {
  createDirectMcpPlacement,
  exposeDirectMcpTools,
  mcpServerNamespace,
  rememberDirectMcpNamespaces,
} from "../src/opencode2/mcp-direct.js"
import type { ToolDraft } from "../src/opencode2/types.js"

type Tool = {
  id: string
  options?: { namespace?: string; permission?: string; codemode?: boolean; pinned?: boolean }
}

function editor(tools: Tool[]): ToolDraft {
  return {
    add: () => {},
    list: () => tools.map((tool) => ({
      name: tool.id,
      description: tool.id,
      input: {},
      execute: async () => ({}),
      ...tool,
    })),
    update: (id, update) => {
      const tool = tools.find((item) => item.id === id)
      if (tool) update(tool)
    },
  }
}

describe("rememberDirectMcpNamespaces", () => {
  test("keeps every server that did not explicitly opt into Code Mode", () => {
    const namespaces = new Set<string>(["stale"])
    // Host MCP server configs carry more than `codemode`.
    const servers: ReadonlyArray<readonly [string, { readonly type: string; readonly codemode?: boolean }]> = [
      ["github", { type: "local" }],
      ["my.docs", { type: "remote", codemode: false }],
      ["executor", { type: "local", codemode: true }],
    ]
    rememberDirectMcpNamespaces(namespaces, servers)
    expect(namespaces).toEqual(new Set(["github", "my_docs"]))
    expect(mcpServerNamespace("my.docs")).toBe("my_docs")
  })

  test("replaces a previous snapshot", () => {
    const namespaces = new Set<string>(["github"])
    rememberDirectMcpNamespaces(namespaces, [])
    expect(namespaces.size).toBe(0)
  })

  test("does not let an MCP server named opencode select the host's own tools", () => {
    const namespaces = new Set<string>()
    rememberDirectMcpNamespaces(namespaces, [["opencode", {}]])
    const tools: Tool[] = [
      { id: "opencode_session_rename", options: { namespace: "opencode", codemode: true, pinned: true } },
    ]
    exposeDirectMcpTools(editor(tools), namespaces)
    expect(tools[0]?.options).toEqual({ namespace: "opencode", codemode: true, pinned: true })
  })

  test("honors explicit Code Mode when server names normalize to the same namespace", () => {
    for (const servers of [
      [["my.docs", {}], ["my_docs", { codemode: true }]],
      [["my_docs", { codemode: true }], ["my.docs", {}]],
    ] as const) {
      const namespaces = new Set<string>()
      rememberDirectMcpNamespaces(namespaces, servers)
      const tools: Tool[] = [
        { id: "my_docs_search", options: { namespace: "my_docs", codemode: true } },
      ]
      exposeDirectMcpTools(editor(tools), namespaces)
      expect(tools[0]?.options?.codemode).toBe(true)
    }
  })
})

describe("exposeDirectMcpTools", () => {
  test("moves matching MCP tools onto the direct catalog", () => {
    const tools: Tool[] = [
      { id: "github_create_pull_request", options: { namespace: "github", codemode: true, permission: "github_create_pull_request" } },
      { id: "my_docs_search", options: { namespace: "my_docs", codemode: false } },
      { id: "executor_run", options: { namespace: "executor", codemode: true, pinned: true } },
      { id: "opencode_session_rename", options: { namespace: "opencode", codemode: true } },
      { id: "read", options: { codemode: false } },
    ]
    exposeDirectMcpTools(editor(tools), new Set(["github", "my_docs"]))
    expect(tools[0]?.options).toEqual({
      namespace: "github",
      permission: "github_create_pull_request",
      codemode: false,
    })
    expect(tools[1]?.options?.codemode).toBe(false)
    expect(tools[2]?.options).toEqual({ namespace: "executor", codemode: true, pinned: true })
    expect(tools[3]?.options?.codemode).toBe(true)
    expect(tools[4]?.options?.codemode).toBe(false)
  })

  test("does nothing without a namespace set or an editor that cannot update", () => {
    const tools: Tool[] = [{ id: "github_echo", options: { namespace: "github", codemode: true } }]
    exposeDirectMcpTools(editor(tools), new Set())
    exposeDirectMcpTools({ add: () => {} }, new Set(["github"]))
    expect(tools[0]?.options?.codemode).toBe(true)
  })
})

describe("createDirectMcpPlacement", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  const mcpTools = (): Tool[] => [
    { id: "github_echo", options: { namespace: "github", codemode: true } },
    { id: "linear_list_issues", options: { namespace: "linear", codemode: true } },
  ]

  test("reloads tools once when namespaces arrive after the tool transform ran", async () => {
    const tools = mcpTools()
    let reloads = 0
    const placement = createDirectMcpPlacement(async () => {
      reloads++
      placement.expose(editor(tools))
    })

    placement.expose(editor(tools))
    placement.rememberServers([["github", {}]])
    placement.rememberServers([["github", {}], ["linear", {}]])
    expect(reloads).toBe(0)
    await settle()

    expect(reloads).toBe(1)
    expect(tools.map((tool) => tool.options?.codemode)).toEqual([false, false])
  })

  test("does not reload when MCP state replays first or does not change", async () => {
    const tools = mcpTools()
    let reloads = 0
    const placement = createDirectMcpPlacement(async () => void reloads++)

    placement.rememberServers([["github", {}]])
    await settle()
    placement.expose(editor(tools))
    placement.rememberServers([["github", { codemode: false }]])
    await settle()

    expect(reloads).toBe(0)
    expect(tools.map((tool) => tool.options?.codemode)).toEqual([false, true])
  })

  test("skips the reload when the tool transform catches up first", async () => {
    let reloads = 0
    const placement = createDirectMcpPlacement(async () => void reloads++)

    placement.expose(editor(mcpTools()))
    placement.rememberServers([["github", {}]])
    placement.expose(editor(mcpTools()))
    await settle()

    expect(reloads).toBe(0)
  })

  test("reloads again after a failed reload", async () => {
    let attempts = 0
    const placement = createDirectMcpPlacement(() => {
      attempts++
      if (attempts === 1) throw new Error("plugin scope closed")
      return Promise.reject(new Error("still closed"))
    })

    placement.expose(editor(mcpTools()))
    placement.rememberServers([["github", {}]])
    await settle()
    placement.rememberServers([["linear", {}]])
    await settle()

    expect(attempts).toBe(2)
  })
})
