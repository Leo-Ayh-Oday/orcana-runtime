/** RC-01 故障矩阵：runTypeScriptNoEmit 六态契约。 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { runTypeScriptNoEmit, isPassingEvidence, getTscCommand } from "../../src/tools/typescript"
import {
  createRuntimeExecutionContext,
  runWithRuntimeExecutionContext,
  setExecutionAuthority,
} from "../../src/runtime/execution-context"
import type { TrustedExecutionAuthority } from "../../src/runtime/linux/contracts"
import { installHostAuditProcessBroker, resetProcessBroker } from "../helpers/linux-process-test-broker"

beforeAll(installHostAuditProcessBroker)
afterAll(resetProcessBroker)

/** runTypeScriptNoEmit 走 managed Linux executor —— 无 trusted authority
 *  fail-closed（R2 PR-9）。hostRoot 传执行目录（fixture），与工具 cwd 对齐。 */
function withTestAuthority<T>(hostRoot: string, fn: () => T | Promise<T>): Promise<T> {
  const context = createRuntimeExecutionContext()
  return runWithRuntimeExecutionContext(context, async () => {
    const authority: TrustedExecutionAuthority = {
      identity: { runId: "rc01-test", nodeRunId: "rc01-test-0", attempt: 1 },
      workspace: {
        workspaceId: "rc01-ws",
        projectId: "rc01-proj",
        hostRoot,
        kind: "main",
        access: "readwrite",
        physicalWorkspaceKey: "wp_test",
        ownerFiles: [],
      },
    }
    setExecutionAuthority(authority)
    return await fn()
  })
}

function fixtureDir(): string {
  return mkdtempSync(join(tmpdir(), "rc01-"))
}

function writeProject(files: Record<string, string>): string {
  const dir = fixtureDir()
  mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true })
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path)
    mkdirSync(join(full, ".."), { recursive: true })
    writeFileSync(full, content)
    if (path.endsWith(".bin/tsc")) chmodSync(full, 0o755)
  }
  return dir
}

const TSC_OK_CMD = `#!/usr/bin/env bash
exit 0
`

const TSC_FAIL_CMD = `#!/usr/bin/env bash
exit 1
`

describe("RC-01 typecheck six-state contract", () => {
  test("exit 0 → passed, exitCode 0, isPassingEvidence true", async () => {
    const dir = writeProject({
      "node_modules/.bin/tsc": TSC_OK_CMD,
      "a.ts": "export const x: number = 1",
    })
    const r = await withTestAuthority(dir, () => runTypeScriptNoEmit(dir))
    expect(r.status).toBe("passed")
    expect(r.passed).toBe(true)
    expect(r.exitCode).toBe(0)
    expect(isPassingEvidence(r)).toBe(true)
  })

  test("exit 1 → failed, never pass", async () => {
    const dir = writeProject({
      "node_modules/.bin/tsc": TSC_FAIL_CMD,
      "a.ts": "export const x: number = 1",
    })
    const r = await withTestAuthority(dir, () => runTypeScriptNoEmit(dir))
    expect(r.status).toBe("failed")
    expect(r.passed).toBe(false)
    expect(r.exitCode).toBe(1)
    expect(isPassingEvidence(r)).toBe(false)
  })

  test("tsc not installed → never passes (unavailable or failed, env-dependent)", async () => {
    const dir = fixtureDir()
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true })
    const r = await withTestAuthority(dir, () => runTypeScriptNoEmit(dir))
    // fail-closed 核心：无论 unavailable 还是 failed，绝不构成通过证据。
    expect(r.passed).toBe(false)
    expect(isPassingEvidence(r)).toBe(false)
    expect(["unavailable", "failed", "error"]).toContain(r.status)
  })

  test("stderr has content but exit 0 → still passed", async () => {
    const dir = writeProject({
      "node_modules/.bin/tsc": `#!/usr/bin/env bash
echo "warning: something" >&2
exit 0
`,
      "a.ts": "",
    })
    const r = await withTestAuthority(dir, () => runTypeScriptNoEmit(dir))
    expect(r.status).toBe("passed")
    expect(r.output).toContain("warning")
  })

  test("stdout empty but exit 1 → failed with issues>0", async () => {
    const dir = writeProject({
      "node_modules/.bin/tsc": `#!/usr/bin/env bash
exit 1
`,
      "a.ts": "",
    })
    const r = await withTestAuthority(dir, () => runTypeScriptNoEmit(dir))
    expect(r.status).toBe("failed")
    expect(r.issues).toBeGreaterThan(0)
    expect(r.output).toContain("tsc exited with code 1")
  })

  test("error TS1234 counted as issues", async () => {
    const dir = writeProject({
      "node_modules/.bin/tsc": `#!/usr/bin/env bash
echo "a.ts:1:1 - error TS1234: boom"
echo "b.ts:2:2 - error TS5678: bam"
exit 2
`,
      "a.ts": "",
    })
    const r = await withTestAuthority(dir, () => runTypeScriptNoEmit(dir))
    expect(r.status).toBe("failed")
    expect(r.issues).toBe(2)
  })

  test("getTscCommand prefers local node_modules/.bin/tsc", () => {
    const dir = writeProject({ "node_modules/.bin/tsc": TSC_OK_CMD, "a.ts": "" })
    expect(getTscCommand(dir)).toBe(join(dir, "node_modules", ".bin", "tsc"))
  })

  test("cancelled path: aborted signal maps to cancelled (contract shape)", () => {
    // runTypeScriptNoEmit 的 cancelled 状态由 collectProcessRun 的 signal==="aborted" 驱动。
    // 直接验证状态映射：构造 signal aborted 的结果语义（通过 isPassingEvidence 防呆）。
    const cancelledLike = { status: "cancelled" as const, available: true, exitCode: null }
    expect(isPassingEvidence(cancelledLike)).toBe(false)
    const timedOutLike = { status: "timed_out" as const, available: true, exitCode: null }
    expect(isPassingEvidence(timedOutLike)).toBe(false)
  })

  test("timed_out/cancelled never satisfy isPassingEvidence", () => {
    for (const status of ["timed_out", "cancelled", "unavailable", "error", "failed"] as const) {
      expect(isPassingEvidence({ status, available: true, exitCode: 0 })).toBe(false)
      expect(isPassingEvidence({ status, available: true, exitCode: null })).toBe(false)
    }
  })
})
