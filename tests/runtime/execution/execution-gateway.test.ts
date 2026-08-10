/** LR2-0D（ADR-LR2-001）：ExecutionGateway 验收 —— 统一入口 + 受信
 *  Context + shadow parity + run_process 路由。
 *
 *  Gates: DIRECT_PRODUCT_PROCESS_BYPASS（工具不再直接 spawn）/
 *  CAPABILITY_MISMATCH fail-closed / CONTEXT_MISSING fail-closed。
 */

import { describe, expect, test } from "bun:test"
import { platform } from "node:os"
import { getExecutionGateway } from "../../../src/runtime/execution/execution-gateway"
import type { ExecutionIntent } from "../../../src/runtime/execution/execution-intent"
import { runWithExecutionContext, type ExecutionContext } from "../../../src/runtime/execution/execution-context"
import type { TrustedExecutionAuthority } from "../../../src/runtime/linux/contracts"

const linuxOnly = platform() === "linux" ? test : test.skip

function testAuthority(): TrustedExecutionAuthority {
  return {
    identity: { runId: `gw-${Math.random().toString(36).slice(2, 8)}`, nodeRunId: "gw:n1", attempt: 1 },
    workspace: {
      workspaceId: "ws_gw",
      projectId: "gw",
      hostRoot: process.cwd(),
      kind: "main",
      access: "readwrite",
      physicalWorkspaceKey: "wp_gw",
      ownerFiles: [],
    },
  }
}

function intent(overrides: Partial<ExecutionIntent> = {}): ExecutionIntent {
  return {
    requestId: `req-${Math.random().toString(36).slice(2, 8)}`,
    tool: { capabilityId: "run_process", executable: "/bin/true", args: [] },
    workload: { kind: "build", readonly: false },
    ...overrides,
  }
}

function context(authority: TrustedExecutionAuthority = testAuthority()): ExecutionContext {
  return { approvedCapabilityId: "run_process", sideEffectClass: "write", authority }
}

describe("ExecutionGateway (LR2-0D)", () => {
  test("capability mismatch is rejected fail-closed", async () => {
    const gateway = getExecutionGateway()
    await expect(
      gateway.collect(intent(), { ...context(), approvedCapabilityId: "other_tool" }),
    ).rejects.toMatchObject({ code: "EXECUTION_CAPABILITY_MISMATCH" })
  })

  test("missing context authority is fail-closed", async () => {
    const gateway = getExecutionGateway()
    await expect(
      gateway.collect(intent(), { approvedCapabilityId: "run_process", sideEffectClass: "write", authority: undefined as unknown as TrustedExecutionAuthority }),
    ).rejects.toMatchObject({ code: "EXECUTION_CONTEXT_MISSING" })
  })

  test("intent without requestId is rejected", async () => {
    const gateway = getExecutionGateway()
    await expect(
      gateway.collect({ ...intent(), requestId: "" }, context()),
    ).rejects.toMatchObject({ code: "EXECUTION_INTENT_FORBIDDEN_FIELD" })
  })

  linuxOnly("collect executes via broker and returns a receipt", async () => {
    const gateway = getExecutionGateway()
    const result = await gateway.collect(intent(), context())
    expect(result.exitCode).toBe(0)
    expect(result.receipt).toBeDefined()
    // LR2-0H：Receipt metrics 必须三态（observed/unknown），禁止空对象冒充。
    expect(["observed", "unknown", "unsupported"]).toContain(result.receipt!.metrics.status)
  })

  linuxOnly("execute streams events", async () => {
    const gateway = getExecutionGateway()
    const types: string[] = []
    for await (const event of gateway.execute(intent(), context())) {
      types.push(event.type)
    }
    expect(types).toContain("status")
    expect(types).toContain("exit")
    expect(types).toContain("receipt")
  })

  test("shadow mode records parity view", async () => {
    const gateway = getExecutionGateway({ mode: "shadow" })
    await gateway.collect(intent({ tool: { capabilityId: "run_process", executable: "/bin/true", args: ["--flag"] } }), context())
    const records = gateway.parityRecords()
    expect(records).toHaveLength(1)
    expect(records[0]!.command).toBe("/bin/true")
    expect(records[0]!.capabilityId).toBe("run_process")
  })

  linuxOnly("shadow parity: compile view is deterministic across identities", async () => {
    // LR2-0D #13：同一 intent 的编译视图（CellSpecBuilder）必须是确定性的
    // —— 身份（runId/cellId）每次不同，但 policyDigest 只覆盖策略字段，
    // 两次编译必须一致（否则缓存/重放/Evidence 建立在错误摘要上）。
    const gateway = getExecutionGateway()
    const v1 = gateway.compileView(intent(), context(testAuthority()))
    const v2 = gateway.compileView(intent(), context(testAuthority()))
    expect(v1).toBeDefined()
    expect(v2).toBeDefined()
    if (v1 && v2) {
      expect(v1.policyDigest).toBe(v2.policyDigest)
      expect(v1.spec.identity.cellId).not.toBe(v2.spec.identity.cellId)
      expect(v1.policyDigest).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  linuxOnly("runProcess routes through the gateway when authority is bound", async () => {
    const { runProcess } = await import("../../../src/tools/process")
    const result = await runWithExecutionContext(context(), () =>
      runProcess({ command: "/bin/true", args: [] }),
    )
    expect(result.exitCode).toBe(0)
  })
})
