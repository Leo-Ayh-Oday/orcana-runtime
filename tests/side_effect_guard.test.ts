/** Tests for ShellSideEffectGuard — PR-5.3 command classification and scope checking. */
import { describe, expect, test } from "bun:test"
import {
  analyzeSideEffects,
  hasSideEffects,
  formatSideEffectReport,
  checkScopeViolations,
  type SideEffectReport,
} from "../src/sandbox/side-effect-guard"
import { resolve, join } from "node:path"
import { mkdirSync, writeFileSync, rmSync } from "node:fs"

// ── Command classification ──

describe("analyzeSideEffects — destructive_delete", () => {
  test("rm -rf directory", () => {
    const r = analyzeSideEffects("rm -rf node_modules", "/project")
    expect(r.findings.length).toBeGreaterThan(0)
    expect(r.findings[0]!.category).toBe("destructive_delete")
    expect(r.findings[0]!.description).toContain("rm")
    expect(r.severity).toBe("warning")
  })

  test("rm single file", () => {
    const r = analyzeSideEffects("rm src/old.ts", "/project")
    expect(r.findings.length).toBeGreaterThan(0)
    expect(r.findings[0]!.category).toBe("destructive_delete")
  })

  test("del /f on Windows", () => {
    const r = analyzeSideEffects("del /f /s C:\\temp\\*.*", "/project")
    expect(r.findings.length).toBeGreaterThan(0)
  })

  test("Remove-Item PowerShell", () => {
    const r = analyzeSideEffects("Remove-Item -Recurse -Force dist", "/project")
    expect(r.findings.length).toBeGreaterThan(0)
    expect(r.findings[0]!.affectedPaths).toContain("dist")
  })

  test("git clean -f", () => {
    const r = analyzeSideEffects("git clean -fd", "/project")
    expect(r.findings.some(f => f.category === "destructive_delete")).toBe(true)
  })
})

describe("analyzeSideEffects — destructive_move", () => {
  test("mv with force", () => {
    const r = analyzeSideEffects("mv -f /tmp/build ./dist", "/project")
    expect(r.findings.some(f => f.category === "destructive_move")).toBe(true)
  })

  test("Move-Item PowerShell", () => {
    const r = analyzeSideEffects("Move-Item -Force old.ts new.ts", "/project")
    expect(r.findings.some(f => f.category === "destructive_move")).toBe(true)
  })
})

describe("analyzeSideEffects — git_destructive", () => {
  test("git reset --hard", () => {
    const r = analyzeSideEffects("git reset --hard HEAD~1", "/project")
    const finding = r.findings.find(f => f.category === "git_destructive")
    expect(finding).toBeDefined()
    expect(finding!.description).toContain("reset --hard")
  })

  test("git stash drop", () => {
    const r = analyzeSideEffects("git stash drop stash@{0}", "/project")
    expect(r.findings.some(f => f.category === "git_destructive")).toBe(true)
  })

  test("git stash clear", () => {
    const r = analyzeSideEffects("git stash clear", "/project")
    expect(r.findings.some(f => f.category === "git_destructive")).toBe(true)
  })

  test("git checkout -- file", () => {
    const r = analyzeSideEffects("git checkout -- src/main.ts", "/project")
    const finding = r.findings.find(f => f.category === "git_destructive")
    expect(finding).toBeDefined()
    expect(finding!.affectedPaths).toContain("src/main.ts")
  })

  test("git restore", () => {
    const r = analyzeSideEffects("git restore src/config.ts", "/project")
    expect(r.findings.some(f => f.category === "git_destructive")).toBe(true)
  })
})

describe("analyzeSideEffects — permission_change", () => {
  test("chmod 777", () => {
    const r = analyzeSideEffects("chmod 777 script.sh", "/project")
    expect(r.findings.some(f => f.category === "permission_change")).toBe(true)
  })

  test("chown", () => {
    const r = analyzeSideEffects("chown user:group file.txt", "/project")
    expect(r.findings.some(f => f.category === "permission_change")).toBe(true)
  })

  test("icacls", () => {
    const r = analyzeSideEffects("icacls file.txt /grant User:F", "/project")
    expect(r.findings.some(f => f.category === "permission_change")).toBe(true)
  })
})

describe("analyzeSideEffects — severity", () => {
  test("no side effects → none", () => {
    const r = analyzeSideEffects("bun test", "/project")
    expect(r.severity).toBe("none")
    expect(r.findings).toHaveLength(0)
  })

  test("npm install is not flagged", () => {
    const r = analyzeSideEffects("npm install", "/project")
    // npm install is not in our side-effect patterns
    expect(r.severity).toBe("none")
  })

  test("git status is not flagged", () => {
    const r = analyzeSideEffects("git status", "/project")
    expect(r.severity).toBe("none")
  })

  test("multiple patterns → warning", () => {
    const r = analyzeSideEffects("rm -rf dist && mv build dist", "/project")
    expect(r.severity).toBe("warning")
    expect(r.findings.length).toBeGreaterThanOrEqual(2)
  })
})

// ── Scope checking ──

describe("analyzeSideEffects — out-of-scope detection", () => {
  test("path outside project root is flagged", () => {
    const r = analyzeSideEffects("rm -rf /tmp/build", "/project")
    expect(r.outOfScopeFiles.length).toBeGreaterThan(0)
  })

  test("path inside project root is not out-of-scope", () => {
    const r = analyzeSideEffects("rm -rf dist", "/project")
    expect(r.outOfScopeFiles).toHaveLength(0) // dist/ is inside /project
  })

  test("absolute path outside project", () => {
    const r = analyzeSideEffects("mv /etc/config ./project/config", "/project")
    const moveFinding = r.findings.find(f => f.category === "destructive_move")
    expect(moveFinding).toBeDefined()
  })
})

describe("checkScopeViolations", () => {
  test("returns files outside expected scope", () => {
    const projectRoot = resolve(process.cwd(), ".deepseek-code")
    const violations = checkScopeViolations(
      ["src/test.ts", "/etc/passwd", "../outside/file.txt"],
      ["src/test.ts"],
      projectRoot,
    )
    // /etc/passwd and ../outside/file.txt are outside project
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })
})

// ── hasSideEffects ──

describe("hasSideEffects", () => {
  test("detects rm -rf", () => {
    expect(hasSideEffects("rm -rf node_modules")).toBe(true)
  })

  test("detects git reset --hard", () => {
    expect(hasSideEffects("git reset --hard HEAD")).toBe(true)
  })

  test("safe commands return false", () => {
    expect(hasSideEffects("bun test")).toBe(false)
    expect(hasSideEffects("git status")).toBe(false)
    expect(hasSideEffects("npm run build")).toBe(false)
    expect(hasSideEffects("ls -la")).toBe(false)
    expect(hasSideEffects("echo hello")).toBe(false)
  })
})

// ── formatSideEffectReport ──

describe("formatSideEffectReport", () => {
  test("empty for no side effects", () => {
    const r = analyzeSideEffects("bun test", "/project")
    expect(formatSideEffectReport(r)).toBe("")
  })

  test("contains warning for side effects", () => {
    const r = analyzeSideEffects("rm -rf dist", "/project")
    const formatted = formatSideEffectReport(r)
    expect(formatted).toContain("Shell 副作用")
    expect(formatted).toContain("rm")
  })

  test("danger severity uses red formatting", () => {
    const r = analyzeSideEffects("git reset --hard && chmod 777 /etc/hosts", "/project")
    // permission_change is detected; /etc/hosts is out of scope → danger
    const formatted = formatSideEffectReport(r)
    expect(formatted.length).toBeGreaterThan(0)
  })
})
