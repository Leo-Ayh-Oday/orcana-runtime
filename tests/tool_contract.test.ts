import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { getToolRisk } from "../src/agent/tool-risk"
import { assembleRuntimeToolDefs, BUILTIN_TOOL_DEFS } from "../src/tools/builtins"
import { buildTool, Result, type ToolContractMetadata, type ToolDef } from "../src/tools/registry"

function contractHash(defn: ToolDef): string {
  const contract = buildTool(defn).contract
  return createHash("sha256").update(JSON.stringify(contract)).digest("hex")
}

function readonlyTool(inputSchema: Record<string, unknown>, contract?: ToolContractMetadata): ToolDef {
  return {
    name: "schema_probe",
    description: "Probe schema metadata",
    isReadonly: true,
    inputSchema,
    contract,
    execute: async () => Result.ok("ok"),
  }
}

describe("ToolContract projection", () => {
  test("buildTool exposes one detached, deeply immutable contract without changing execution", async () => {
    const inputSchema: Record<string, unknown> = {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    }
    const contractMetadata: ToolContractMetadata = {
      pathPolicy: "workspace_only",
      stateRequirement: "fresh_full_baseline",
      stateUpdates: ["file_state"],
    }
    const tool = buildTool({
      name: "edit_demo",
      description: "Edit a demo file",
      isReadonly: false,
      category: "file",
      requiresConfirmation: true,
      inputSchema,
      contract: contractMetadata,
      async execute(params) {
        return Result.ok(String(params.content))
      },
    })

    expect(tool.contract).toEqual({
      name: "edit_demo",
      description: "Edit a demo file",
      declaredArgsSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
      provenance: "local",
      category: "file",
      access: "write",
      concurrencySafe: true,
      permission: "category_default",
      confirmation: {
        declared: true,
        requiredByBaseRisk: false,
      },
      risk: {
        baseLevel: 2,
        maxLevel: 2,
        invocationSensitive: false,
        sessionAllowableAtBase: true,
        evaluation: "per_invocation",
      },
      sideEffects: ["workspace_write"],
      path: {
        parameters: ["path"],
        policy: "workspace_only",
      },
      state: {
        requirement: "fresh_full_baseline",
        updates: ["file_state"],
      },
      resultBudget: {
        maxChars: null,
        maxLines: null,
        overflow: "handler_defined",
      },
      execution: {
        streaming: false,
        cooperativeCancellation: false,
      },
    })

    const declaredProperties = tool.contract.declaredArgsSchema.properties as Record<string, unknown>
    expect(Object.isFrozen(tool.contract)).toBe(true)
    expect(Object.isFrozen(tool.contract.risk)).toBe(true)
    expect(Object.isFrozen(tool.contract.sideEffects)).toBe(true)
    expect(Object.isFrozen(tool.contract.path.parameters)).toBe(true)
    expect(Object.isFrozen(tool.contract.state.updates)).toBe(true)
    expect(Object.isFrozen(tool.contract.declaredArgsSchema)).toBe(true)
    expect(Object.isFrozen(declaredProperties)).toBe(true)

    ;(inputSchema.properties as Record<string, unknown>).later = { type: "string" }
    contractMetadata.stateUpdates!.push("checkpoint")
    expect(declaredProperties.later).toBeUndefined()
    expect(tool.contract.state.updates).toEqual(["file_state"])
    expect(() => (tool.contract.state.updates as string[]).push("evidence")).toThrow()

    const result = await tool.execute({ path: "demo.ts", content: "unchanged behavior" })
    expect(result.success).toBe(true)
    expect(result.content).toBe("unchanged behavior")
  })

  test("all built-in tools have stable full-contract fingerprints", () => {
    const fingerprints = BUILTIN_TOOL_DEFS.map(defn => `${defn.name}:${contractHash(defn)}`)

    for (const defn of BUILTIN_TOOL_DEFS) {
      const contract = buildTool(defn).contract
      expect(contract.description).toBe(defn.description)
      expect(contract.declaredArgsSchema).toEqual(defn.inputSchema)
    }

    expect(fingerprints).toEqual([
      "read_file:8d19854eb1907fc5dcf02102a47a6e2e741d2e9d2c9bb28933ae78f619d6c774",
      "write_file:2218c0aef6985044266acabe2cc488069185efbb87188db6da5e70bb635d67c9",
      "edit_file:f0331d1876fcfdca52a0c02014cac5eb119a947bca69f0b45b80c7785bf23621",
      "multi_edit:bd01af46e7ffe175654bb58e7646e1f5041cba74a0f888034ff94b7bd322d48d",
      "edit_fim:e29cc0b0cd58c9496d9698a589b51465acacc9876b30cd55c769bf32c64df0b5",
      "rollback_transaction:bd4ceed1a486ff0148894eca74974868a20731709d009cf8858553a3c9f26495",
      "shell:5163d7bdacab8e07f9c612a574d9fbf53feb9d417114b2f53ff4b8cb8e669969",
      "start_service:483dc391fdcd57e97a5664b0f6215072fbccc10efe6c9426222792e6f6d45ea5",
      "git_status:a5085bd45df5b65723dff6a2f114372f62bf76ca8f3548e167770235281b72bf",
      "git_diff:4ba26f60a84a579be5f4ab90e5258470061fa6ce1dc9239669e03fcd88d90fef",
      "git_log:866a6ce10058db55e50a7b426fa9e8fdb519b31665e1ce1e9289f99f417f2fa5",
      "git_blame:1150bcb635d35bd17bf2254a6d73d0796f18cfa2c848d70796137a4aa458749b",
      "web_search:7948eb13fabc637739a6abc0176e635404e3ad30776e14cc1f5e05f52ed117b0",
      "web_fetch:e58f5947a76b35bd7bf1013812e3a374fcc070c1659ee8eb2aca18cecca58ed8",
      "find_symbol:a98ea218fc64e3de3ae325e2ac553b4e31a2c61237e1999b7a74ac61581b6de3",
      "find_references:0bae3b44d68cd0ee400f32a6ac0ee3c86edb0f32c861b1f146d9447766f846db",
      "project_structure:9a1b48e2672ecc604ddc51e6d5a089de91ea4fa74fe37e4987f7f955dda7dcbd",
      "lsp_diagnostics:d986b96c2347989c49f5dd4c32615e825c36857fe282b3f40aab1774fa132c99",
      "lsp_hover:e34068cc9085964da281c7ab79c5a2f6edc487bf113c416e280af3818a9a6e1b",
      "lsp_definition:c2c070697bf5a58538155b9ab990a0824322f020eef2f80822dd1b95070f6e2f",
      "lsp_references:5c90731b68387837636e725b831bb9dddf11400ccaf1a479403d3f899e6f85da",
      "typecheck:988b2d28102d1855754fb4992112700eed5b2e3694415eb62164ac9c9f79212b",
      "task:6e2c71b5c3f9ac407b80832d68ca44538c3bc924fb93425ed3be4356aabc2b7d",
      "request_deeper_thinking:8e3e934be816e9410ac9b196e2cdf1099def6b74f6a89ec5028d6702cb316184",
    ])
  })

  test("keeps one frozen catalog and inserts MCP tools before meta-tools", () => {
    const mcpDef = {
      ...readonlyTool({ type: "object", properties: {} }),
      name: "mcp__server__probe",
      contract: { provenance: "mcp" as const },
    }
    const assembled = assembleRuntimeToolDefs([mcpDef])
    const builtinNames = BUILTIN_TOOL_DEFS.map(defn => defn.name)
    const metaToolStart = builtinNames.length - 2

    expect(Object.isFrozen(BUILTIN_TOOL_DEFS)).toBe(true)
    expect(assembled.map(defn => defn.name)).toEqual([
      ...builtinNames.slice(0, metaToolStart),
      "mcp__server__probe",
      ...builtinNames.slice(metaToolStart),
    ])
    expect(assembled.filter(defn => defn === mcpDef)).toHaveLength(1)
    expect(BUILTIN_TOOL_DEFS.some(defn => defn === mcpDef)).toBe(false)
  })

  test("discovers nested and composed path parameters once in stable order", () => {
    const schema = {
      type: "object",
      properties: {
        workspace: {
          type: "object",
          properties: { cwd: { type: "string" } },
        },
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: { path: { type: "string" } },
          },
        },
      },
      allOf: [
        { properties: { path: { type: "string" } } },
        { properties: { path: { type: "string" } } },
      ],
      anyOf: [{ properties: { file_path: { type: "string" } } }],
      oneOf: [{ properties: { file: { type: "string" } } }],
    }

    expect(buildTool(readonlyTool(schema)).contract.path).toEqual({
      parameters: ["workspace.cwd", "edits[].path", "path", "file_path", "file"],
      policy: "handler_defined",
    })
  })

  test("explicit path metadata wins and cyclic or over-deep schemas remain bounded", () => {
    expect(buildTool(readonlyTool(
      { type: "object", properties: { path: { type: "string" } } },
      { pathParameters: ["target", "target"], pathPolicy: "workspace_only" },
    )).contract.path).toEqual({ parameters: ["target"], policy: "workspace_only" })

    const cyclic: Record<string, unknown> = { type: "object" }
    cyclic.properties = { self: cyclic }
    expect(() => buildTool(readonlyTool(cyclic))).not.toThrow()
    expect(buildTool(readonlyTool(cyclic)).contract.path).toEqual({ parameters: [], policy: "none" })

    const deep: Record<string, unknown> = { type: "object" }
    let cursor = deep
    for (let index = 0; index < 80; index++) {
      const child: Record<string, unknown> = { type: "object" }
      cursor.properties = { nested: child }
      cursor = child
    }
    cursor.properties = { path: { type: "string" } }
    expect(buildTool(readonlyTool(deep)).contract.path.parameters).toEqual([])
  })

  test("reports base and maximum risk without replacing per-invocation authorization", () => {
    const shellDef = BUILTIN_TOOL_DEFS.find(defn => defn.name === "shell")!
    const serviceDef = BUILTIN_TOOL_DEFS.find(defn => defn.name === "start_service")!
    const writeDef = BUILTIN_TOOL_DEFS.find(defn => defn.name === "write_file")!
    const shellContract = buildTool(shellDef).contract
    const serviceContract = buildTool(serviceDef).contract
    const writeContract = buildTool(writeDef).contract

    expect(shellContract.risk).toEqual({
      baseLevel: 4,
      maxLevel: 5,
      invocationSensitive: true,
      sessionAllowableAtBase: false,
      evaluation: "per_invocation",
    })
    expect(writeContract.risk).toEqual({
      baseLevel: 2,
      maxLevel: 5,
      invocationSensitive: true,
      sessionAllowableAtBase: true,
      evaluation: "per_invocation",
    })
    expect(serviceContract.risk).toEqual({
      baseLevel: 4,
      maxLevel: 5,
      invocationSensitive: true,
      sessionAllowableAtBase: false,
      evaluation: "per_invocation",
    })
    expect(getToolRisk("shell", { command: "rm -rf /" }, { defn: shellDef }).level).toBe(5)

    const mcpContract = buildTool({
      ...readonlyTool({ type: "object", properties: {} }),
      name: "mcp__remote__probe",
      category: "safe",
      contract: { provenance: "mcp" },
    }).contract
    expect(mcpContract.provenance).toBe("mcp")
    expect(mcpContract.risk).toEqual({
      baseLevel: 4,
      maxLevel: 5,
      invocationSensitive: true,
      sessionAllowableAtBase: false,
      evaluation: "per_invocation",
    })
    expect(mcpContract.confirmation.requiredByBaseRisk).toBe(true)
    expect(mcpContract.sideEffects).toEqual(["network", "external_process"])
  })
})
