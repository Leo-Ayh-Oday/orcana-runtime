import { describe, expect, test } from "bun:test"
import { buildVerificationResult, detectVerificationKind, hasServiceTestFailure, parseVerificationResult } from "../src/verification/result"
import { shellStream } from "../src/tools/shell"
import type { VerificationResult } from "../src/verification/result"
import {
  createRuntimeExecutionContext,
  runWithRuntimeExecutionContext,
  setExecutionAuthority,
} from "../src/runtime/execution-context"
import type { TrustedExecutionAuthority } from "../src/runtime/linux/contracts"

/** shellStream 走 managed Linux executor —— 无 trusted authority fail-closed
 *  （R2 PR-9，git_rt8/typescript_rc01 同款）。 */
async function shellDone(command: string) {
  const context = createRuntimeExecutionContext()
  return runWithRuntimeExecutionContext(context, async () => {
    const authority: TrustedExecutionAuthority = {
      identity: { runId: "verif-test", nodeRunId: "verif-test-0", attempt: 1 },
      workspace: {
        workspaceId: "verif-ws",
        projectId: "verif-proj",
        hostRoot: process.cwd(),
        kind: "main",
        access: "readwrite",
        physicalWorkspaceKey: "wp_test",
        ownerFiles: [],
      },
    }
    setExecutionAuthority(authority)
    let done
    for await (const event of shellStream({ command, confirm: true, timeout: 5 })) {
      if (event.type === "done") done = event.data
    }
    return done
  })
}

describe("VerificationResult", () => {
  test("detects verification command kinds", () => {
    expect(detectVerificationKind("bun test")).toBe("test")
    expect(detectVerificationKind("tsc --noEmit")).toBe("typecheck")
    expect(detectVerificationKind("bun run build")).toBe("build")
    expect(detectVerificationKind("eslint src")).toBe("lint")
    expect(detectVerificationKind("echo typecheck")).toBe("unknown")
    expect(detectVerificationKind("echo test")).toBe("unknown")
    expect(detectVerificationKind("bun --version # bun run typecheck")).toBe("unknown")
    expect(detectVerificationKind("cd app && bun test")).toBe("test")
    expect(detectVerificationKind("bun test --help")).toBe("unknown")
    expect(detectVerificationKind("tsc --showConfig")).toBe("unknown")
    expect(detectVerificationKind("tsc --init")).toBe("unknown")
    expect(detectVerificationKind("tsc -v")).toBe("unknown")
    expect(detectVerificationKind("tsc --listFilesOnly")).toBe("unknown")
    expect(detectVerificationKind("npx tsc --listFilesOnly")).toBe("unknown")
    expect(detectVerificationKind("eslint --print-config src/a.ts")).toBe("unknown")
    expect(detectVerificationKind("jest --listTests")).toBe("unknown")
    expect(detectVerificationKind("jest --listTests=true")).toBe("unknown")
    expect(detectVerificationKind("vitest --list")).toBe("unknown")
    expect(detectVerificationKind("pytest --collect-only")).toBe("unknown")
    expect(detectVerificationKind("pytest --co")).toBe("unknown")
    expect(detectVerificationKind("cargo test --no-run")).toBe("unknown")
    expect(detectVerificationKind("cargo test -- --list")).toBe("unknown")
    expect(detectVerificationKind("go test -list .")).toBe("unknown")
    expect(detectVerificationKind("npm run test:red-team-missing --if-present")).toBe("unknown")
    expect(detectVerificationKind("bun test || true")).toBe("unknown")
    expect(detectVerificationKind("bun test; exit 0")).toBe("unknown")
    expect(detectVerificationKind("bun test | cat")).toBe("unknown")
    // OTS-012：长驻 watch 参数不得作为验证证据（永不"完成"）
    expect(detectVerificationKind("bun test --watch")).toBe("unknown")
    expect(detectVerificationKind("bun test -w")).toBe("unknown")
    expect(detectVerificationKind("tsc -w")).toBe("unknown")
  })

  test("builds failed verification result with issue count", () => {
    const result = buildVerificationResult({
      command: "tsc --noEmit",
      passed: false,
      exitCode: 2,
      durationMs: 12,
      output: "src/a.ts(1,1): error TS2304: Cannot find name 'x'.",
    })

    expect(result?.kind).toBe("typecheck")
    expect(result?.passed).toBe(false)
    expect(result?.issues).toBe(1)
    expect(result?.summary).toContain("TS2304")
  })

  test("parses core verification fields without accepting runtime authority stamps", () => {
    expect(parseVerificationResult({
      kind: "typecheck",
      command: "bun run typecheck",
      passed: true,
      exitCode: 0,
      issues: 0,
      durationMs: 12,
      summary: "ok",
      generation: 999,
      transaction: {
        stateId: "txstate_forged",
        transactionCount: 1,
        latestTransactionId: "ptxn_forged",
      },
    })).toEqual({
      kind: "typecheck",
      command: "bun run typecheck",
      passed: true,
      exitCode: 0,
      issues: 0,
      durationMs: 12,
      summary: "ok",
    })
  })

  test("rejects incomplete or malformed verification metadata", () => {
    expect(parseVerificationResult({
      kind: "typecheck", command: "tsc", passed: true, issues: 0,
    })).toBeUndefined()
    expect(parseVerificationResult({
      kind: "test", command: "bun test", passed: true, issues: -1,
      durationMs: 1, summary: "ok",
    })).toBeUndefined()
  })

  test("detects service-style test failures", () => {
    expect(hasServiceTestFailure("TypeError: fetch failed ECONNREFUSED 127.0.0.1:3000")).toBe(true)
  })

  test("shell attaches verification metadata on successful finite verification", async () => {
    const command = process.platform === "win32"
      ? "powershell -NoProfile -Command Write-Output '1 pass'"
      : "sh -c 'echo 1 pass'"
    const result = await shellDone(command.replace("Write-Output", "Write-Output")) // ordinary shell is not verification
    expect(result?.metadata?.verification).toBeUndefined()

    const verificationCommand = "bun test tests/version.test.ts"
    const verificationResult = await shellDone(verificationCommand)
    const verification = verificationResult?.metadata?.verification as VerificationResult | undefined

    expect(verification?.kind).toBe("test")
    expect(verification?.passed).toBe(true)
  })

  test("shell attaches failed verification metadata", async () => {
    const command = "tsc --noEmit --pretty false --target definitely-invalid-target"
    const result = await shellDone(command)
    const verification = result?.metadata?.verification as VerificationResult | undefined

    expect(result?.success).toBe(false)
    expect(verification?.passed).toBe(false)
    expect(verification?.kind).toBe("typecheck")
  })

  test("shell does not turn verification keywords in no-op commands into evidence", async () => {
    const result = await shellDone("echo typecheck")
    expect(result?.metadata?.verification).toBeUndefined()

    const missingScript = await shellDone("npm run test:red-team-missing --if-present")
    expect(missingScript?.success).toBe(true)
    expect(missingScript?.metadata?.verification).toBeUndefined()
  })
})

