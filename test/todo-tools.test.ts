import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import {
  clearAllSessionTodos,
  clearSessionTodos,
  getSessionTodos,
  normalizeSessionTodos,
  setSessionTodos,
} from "../src/todo-store.js"
import {
  CURSOR_OPENCODE2_TODOS_ENV,
  hostHasTool,
  isOpenCode2TodosEnabled,
  OPENCODE2_DIRECT_TOOL_OPTIONS,
  registerTodoTools,
  TODO_OUTPUT_SCHEMA,
} from "../src/opencode2/todo-tools.js"
import type { ToolDraft, ToolDefinition, ToolExecutionContext } from "../src/opencode2/types.js"

const originalTodosGate = process.env[CURSOR_OPENCODE2_TODOS_ENV]

function restoreTodosGate() {
  if (originalTodosGate === undefined) delete process.env[CURSOR_OPENCODE2_TODOS_ENV]
  else process.env[CURSOR_OPENCODE2_TODOS_ENV] = originalTodosGate
}

beforeEach(() => {
  clearAllSessionTodos()
})

afterEach(() => {
  restoreTodosGate()
})

describe("session todo store", () => {
  test("replace-all write then read", () => {
    const written = setSessionTodos("ses_1", [
      { content: "one", status: "in_progress", priority: "high" },
      { id: "keep", content: "two", status: "pending", priority: "low" },
    ])
    expect(written).toEqual([
      { id: "1", content: "one", status: "in_progress", priority: "high" },
      { id: "keep", content: "two", status: "pending", priority: "low" },
    ])
    expect(getSessionTodos("ses_1")).toEqual(written)
    expect(getSessionTodos("ses_other")).toEqual([])
  })

  test("drops empty content and fills defaults", () => {
    expect(normalizeSessionTodos([
      { content: "  " },
      { content: "ok" },
      null,
    ])).toEqual([
      { id: "1", content: "ok", status: "pending", priority: "medium" },
    ])
  })

  test("clear is per session", () => {
    setSessionTodos("a", [{ content: "a" }])
    setSessionTodos("b", [{ content: "b" }])
    clearSessionTodos("a")
    expect(getSessionTodos("a")).toEqual([])
    expect(getSessionTodos("b")[0]?.content).toBe("b")
  })

  test("bounds retained session lists", () => {
    for (let i = 0; i < 257; i++) setSessionTodos(`s-${i}`, [{ content: `todo ${i}` }])
    expect(getSessionTodos("s-0")).toEqual([])
    expect(getSessionTodos("s-256")[0]?.content).toBe("todo 256")
  })
})

describe("OpenCode 2 todo gate", () => {
  test("is off by default", () => {
    delete process.env[CURSOR_OPENCODE2_TODOS_ENV]
    expect(isOpenCode2TodosEnabled()).toBe(false)
    const added: string[] = []
    registerTodoTools({ add(tool) { added.push(tool.name) } })
    expect(added).toEqual([])
  })

  test("force-enables on 1 or true", () => {
    process.env[CURSOR_OPENCODE2_TODOS_ENV] = "1"
    expect(isOpenCode2TodosEnabled()).toBe(true)
    process.env[CURSOR_OPENCODE2_TODOS_ENV] = "TRUE"
    expect(isOpenCode2TodosEnabled()).toBe(true)
  })

  test("stays off for other values", () => {
    process.env[CURSOR_OPENCODE2_TODOS_ENV] = "0"
    expect(isOpenCode2TodosEnabled()).toBe(false)
    process.env[CURSOR_OPENCODE2_TODOS_ENV] = "false"
    expect(isOpenCode2TodosEnabled()).toBe(false)
    process.env[CURSOR_OPENCODE2_TODOS_ENV] = "yes"
    expect(isOpenCode2TodosEnabled()).toBe(false)
  })
})

describe("registerTodoTools", () => {
  beforeEach(() => {
    process.env[CURSOR_OPENCODE2_TODOS_ENV] = "1"
  })

  test("adds todowrite and todoread when the host has neither", () => {
    const added: string[] = []
    const draft: ToolDraft = {
      add(tool) {
        added.push(tool.name)
      },
    }
    registerTodoTools(draft)
    expect(added).toEqual(["todowrite", "todoread"])
  })

  test("skips tools the host already owns", () => {
    const existing = new Set(["todowrite"])
    const added: string[] = []
    const stub = (name: string): ToolDefinition & { id: string } => ({
      id: name,
      name,
      description: "",
      input: {},
      execute: async () => ({}),
    })
    const draft: ToolDraft = {
      add(tool) {
        added.push(tool.name)
      },
      get(id) {
        return existing.has(id) ? stub(id) : undefined
      },
    }
    registerTodoTools(draft)
    expect(added).toEqual(["todoread"])
  })

  test("write then read through the registered execute path", async () => {
    const tools = new Map<string, ToolDefinition>()
    registerTodoTools({
      add(tool) {
        tools.set(tool.name, tool)
      },
    })
    const ctx: ToolExecutionContext = {
      sessionID: "ses_exec",
      agent: "build",
      messageID: "msg_exec",
      id: "call_exec",
      progress: async () => {},
    }
    const written = await tools.get("todowrite")!.execute(
      { todos: [{ content: "ship", status: "in_progress", priority: "high" }] },
      ctx,
    )
    expect(written.content).toContain("ship")
    expect(written.output).toEqual({
      todos: [{ id: "1", content: "ship", status: "in_progress", priority: "high" }],
    })
    const read = await tools.get("todoread")!.execute({}, ctx)
    expect(JSON.parse(read.content)).toEqual([
      { id: "1", content: "ship", status: "in_progress", priority: "high" },
    ])
    expect(read.output).toEqual(written.output)
  })

  test("refuses a missing session id instead of sharing an empty-key list", async () => {
    const tools = new Map<string, ToolDefinition>()
    registerTodoTools({ add: (tool) => void tools.set(tool.name, tool) })
    expect(tools.get("todowrite")!.execute({ todos: [{ content: "unsafe" }] }, {} as ToolExecutionContext))
      .rejects.toThrow("did not provide a sessionID")
    expect(getSessionTodos("")).toEqual([])
  })

  test("registers as OpenCode 2 direct catalog tools with an output schema", () => {
    const tools = new Map<string, ToolDefinition>()
    registerTodoTools({
      add(tool) {
        tools.set(tool.name, tool)
      },
    })
    for (const name of ["todowrite", "todoread"] as const) {
      const tool = tools.get(name)!
      expect(tool.options).toEqual(OPENCODE2_DIRECT_TOOL_OPTIONS)
      expect(tool.output).toEqual(TODO_OUTPUT_SCHEMA)
    }
  })

  test("hostHasTool uses list() when get() is absent", () => {
    const draft: ToolDraft = {
      add() {},
      list: () => [{ id: "todowrite", name: "todowrite", description: "", input: {}, execute: async () => ({}) }],
    }
    expect(hostHasTool(draft, "todowrite")).toBe(true)
    expect(hostHasTool(draft, "todoread")).toBe(false)
  })
})
