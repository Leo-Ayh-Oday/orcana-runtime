/** RC-01 故障矩阵：runTypeScriptNoEmit 六态契约。 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { runTypeScriptNoEmit, isPassingEvidence, getTscCommand } from "../../src/tools/typescript"

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
    const r = await runTypeScriptNoEmit(dir)
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
    const r = await runTypeScriptNoEmit(dir)
    expect(r.status).toBe("failed")
    expect(r.passed).toBe(false)
    expect(r.exitCode).toBe(1)
    expect(isPassingEvidence(r)).toBe(false)
  })

  test("tsc not installed → never passes (unavailable or failed, env-dependent)", async () => {
    const dir = fixtureDir()
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true })
    const r = await runTypeScriptNoEmit(dir)
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
    const r = await runTypeScriptNoEmit(dir)
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
    const r = await runTypeScriptNoEmit(dir)
    expect(r.status).toBe("failed")
    expect(r.issues).toBeGreaterThan(0)
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
    const r = await runTypeScriptNoEmit(dir)
    expect(r.status).toBe("failed")
    expect(r.issues).toBe(2)
  })

  test("getTscCommand prefers local node_modules/.bin/tsc", () => {
    const dir = writeProject({ "node_modules/.bin/tsc": TSC_OK_CMD, "a.ts": "" })
    expect(getTscCommand(dir)).toBe(join(dir, "node_modules", ".bin", "tsc"))
  })
})
