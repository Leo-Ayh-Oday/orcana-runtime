import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { classifyCommandFailure, discoverVerification, parseClaims, targetedKinds } from "../../src/tools/verification"
import { DISCOVER_VERIFICATION_TOOL, CLASSIFY_COMMAND_FAILURE_TOOL } from "../../src/tools/verification"

// RT-10: verification toolchain — discovery, targeted sets, failure
// classification, claim parsing.

describe("RT-10 discoverVerification", () => {
  test("parses package.json scripts into a typed catalog", () => {
    const dir = mkdtempSync(join(tmpdir(), "rt10-"))
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({
        name: "demo",
        scripts: {
          "typecheck": "tsc --noEmit",
          "test": "vitest run",
          "build": "vite build",
          "lint": "eslint src",
        },
      }))
      const found = discoverVerification(dir)
      expect(found.commands).toHaveLength(4)
      expect(found.commands.find((c) => c.name === "typecheck")!.kind).toBe("typecheck")
      expect(found.commands.find((c) => c.name === "test")!.kind).toBe("test")
      expect(found.commands.find((c) => c.name === "build")!.kind).toBe("build")
      expect(found.commands.find((c) => c.name === "lint")!.kind).toBe("lint")
      expect(found.packages).toContain("demo")
      expect(found.sourceRefs).toContain("package.json")
      expect(found.confidence).toBeGreaterThan(0.5)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("empty project yields low confidence, no crash", () => {
    const dir = mkdtempSync(join(tmpdir(), "rt10-empty-"))
    try {
      const found = discoverVerification(dir)
      expect(found.commands).toEqual([])
      expect(found.confidence).toBe(0.1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("RT-10 targeted kinds", () => {
  test("TS files demand typecheck; test files demand tests", () => {
    expect(targetedKinds(["src/a.ts"])).toContain("typecheck")
    expect(targetedKinds(["src/a.test.ts"])).toContain("test")
    expect(targetedKinds(["src/a.test.ts"])).toContain("typecheck") // still TS
  })
})

describe("RT-10 classifyCommandFailure", () => {
  test("classifies TypeScript errors with signature and files", () => {
    const cls = classifyCommandFailure({
      command: "tsc",
      stdout: "",
      stderr: "src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.\nsrc/b.ts(1,1): error TS1005: ';' expected.",
    })
    expect(cls.category).toBe("typecheck")
    expect(cls.failureSignature).toContain("TS")
    expect(cls.relatedFiles).toContain("src/a.ts")
    expect(cls.relatedFiles).toContain("src/b.ts")
  })

  test("classifies test failures without raw megabyte logs", () => {
    const cls = classifyCommandFailure({
      command: "vitest run",
      stdout: " FAIL src/x.test.ts > adds\nAssertionError: expected 1 to be 2",
      stderr: "",
    })
    expect(cls.category).toBe("test_failure")
    expect(cls.failureSignature).toBe("tests_failed")
    expect(cls.rootCauses.length).toBeGreaterThan(0)
  })

  test("classifies command-not-found and timeout", () => {
    expect(classifyCommandFailure({ command: "x", stdout: "", stderr: "sh: x: command not found" }).category).toBe("command_not_found")
    expect(classifyCommandFailure({ command: "x", stdout: "", stderr: "", timedOut: true }).category).toBe("timeout")
  })

  test("strips ANSI codes", () => {
    const cls = classifyCommandFailure({ command: "tsc", stdout: "[31merror[0m", stderr: "" })
    expect(cls.rootCauses.some((c) => c.includes(""))).toBe(false)
  })
})

describe("RT-10 parseClaims", () => {
  test("extracts claim kinds from completion text", () => {
    expect(parseClaims("Typecheck passed and all tests passed.")).toEqual(["typecheck_passed", "tests_passed"])
    expect(parseClaims("Build succeeded.")).toEqual(["build_passed"])
    expect(parseClaims("just chatting")).toEqual([])
  })
})

describe("RT-10 tools", () => {
  test("discover_verification tool returns the catalog", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rt10-tool-"))
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc" } }))
      const result = await DISCOVER_VERIFICATION_TOOL.execute!({ cwd: dir })
      expect(result.success).toBe(true)
      expect(result.content).toContain("typecheck")
      expect(result.content).toContain("confidence")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("classify_command_failure tool returns structured classification", async () => {
    const result = await CLASSIFY_COMMAND_FAILURE_TOOL.execute!({
      command: "tsc",
      stdout: "",
      stderr: "src/a.ts(1,1): error TS1005: ';' expected.",
    })
    expect(result.success).toBe(true)
    const cls = (result.metadata as { classification: { category: string; failureSignature: string } }).classification
    expect(cls.category).toBe("typecheck")
    expect(cls.failureSignature).toContain("TS1005")
  })
})
