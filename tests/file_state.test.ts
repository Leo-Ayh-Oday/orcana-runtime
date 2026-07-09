import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { FileStateLedger, fingerprintContent, fingerprintFile, validateFreshnessForEdit } from "../src/file-state"

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), "orcana-file-state-"))
}

describe("FileStateLedger", () => {
  test("full read creates a fresh baseline", () => {
    const ledger = new FileStateLedger({ now: () => 100 })
    const fp = fingerprintContent("export const x = 1\n", 99)

    const record = ledger.recordRead({
      path: "src/a.ts",
      range: { kind: "full" },
      content: "export const x = 1\n",
      totalLines: 2,
      fingerprint: fp,
    })

    expect(record.status).toBe("fresh")
    expect(record.source).toBe("read_file")
    expect(record.baseline.sha256).toBe(fp.sha256)
    expect(ledger.get("src/a.ts")).toBe(record)
  })

  test("external disk hash change marks a record stale", () => {
    const ledger = new FileStateLedger({ now: () => 200 })
    const first = fingerprintContent("old")
    const second = fingerprintContent("new")
    ledger.recordRead({ path: "src/a.ts", range: { kind: "full" }, content: "old", fingerprint: first })

    const result = ledger.checkFresh("src/a.ts", second)

    expect(result.ok).toBe(false)
    expect(result.status).toBe("stale")
    expect(result.record?.source).toBe("external_change")
  })

  test("markExternalChange preserves old baseline until a fresh read", () => {
    const ledger = new FileStateLedger()
    const first = fingerprintContent("old")
    const second = fingerprintContent("new")
    ledger.recordRead({ path: "src/a.ts", range: { kind: "full" }, content: "old", fingerprint: first })

    const marked = ledger.markExternalChange("src/a.ts", second)
    const result = ledger.checkFresh("src/a.ts", second)

    expect(marked?.baseline.sha256).toBe(first.sha256)
    expect(result.ok).toBe(false)
    expect(result.status).toBe("stale")
  })

  test("agent write updates the fresh baseline", () => {
    const ledger = new FileStateLedger()
    const oldFp = fingerprintContent("old")
    const newFp = fingerprintContent("new")
    ledger.recordRead({ path: "src/a.ts", range: { kind: "full" }, content: "old", fingerprint: oldFp })

    const record = ledger.recordAgentWrite({ path: "src/a.ts", content: "new", fingerprint: newFp })
    const result = ledger.checkFresh("src/a.ts", newFp)

    expect(record.source).toBe("agent_write")
    expect(record.status).toBe("fresh")
    expect(result.ok).toBe(true)
  })

  test("fingerprintFile returns disk hash and null for missing files", () => {
    const root = tempRepo()
    try {
      mkdirSync(join(root, "src"), { recursive: true })
      const file = join(root, "src", "a.ts")
      writeFileSync(file, "export const x = 1\n", "utf-8")

      expect(fingerprintFile(file)?.sha256).toBe(fingerprintContent("export const x = 1\n").sha256)
      expect(fingerprintFile(join(root, "missing.ts"))).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("validateFreshnessForEdit", () => {
  test("partial read blocks whole-file overwrite", () => {
    const ledger = new FileStateLedger()
    const fp = fingerprintContent("line1\nline2\n")
    ledger.recordRead({
      path: "src/a.ts",
      range: { kind: "range", startLine: 1, endLine: 1 },
      content: "line1\n",
      totalLines: 2,
      fingerprint: fp,
    })

    const result = validateFreshnessForEdit(ledger, {
      path: "src/a.ts",
      operation: "overwrite",
      requiresFullBaseline: true,
      allowsPartialBaseline: false,
    }, fp)

    expect(result.ok).toBe(false)
    expect(result.status).toBe("partial")
  })

  test("truncated read blocks patch", () => {
    const ledger = new FileStateLedger()
    const fp = fingerprintContent("long content")
    ledger.recordRead({
      path: "src/a.ts",
      range: { kind: "full" },
      content: "long",
      fingerprint: fp,
      truncated: true,
    })

    const result = validateFreshnessForEdit(ledger, {
      path: "src/a.ts",
      operation: "patch",
      requiresFullBaseline: false,
      allowsPartialBaseline: true,
    }, fp)

    expect(result.ok).toBe(false)
    expect(result.status).toBe("truncated")
  })

  test("deleted file blocks patch", () => {
    const ledger = new FileStateLedger()
    const fp = fingerprintContent("old")
    ledger.recordRead({ path: "src/a.ts", range: { kind: "full" }, content: "old", fingerprint: fp })

    const result = validateFreshnessForEdit(ledger, {
      path: "src/a.ts",
      operation: "patch",
      requiresFullBaseline: false,
      allowsPartialBaseline: true,
    }, null)

    expect(result.ok).toBe(false)
    expect(result.status).toBe("deleted")
  })

  test("fresh range baseline can authorize a range patch when allowed", () => {
    const ledger = new FileStateLedger()
    const fp = fingerprintContent("line1\nline2\n")
    ledger.recordRead({
      path: "src/a.ts",
      range: { kind: "range", startLine: 1, endLine: 1 },
      content: "line1\n",
      totalLines: 2,
      fingerprint: fp,
    })

    const result = validateFreshnessForEdit(ledger, {
      path: "src/a.ts",
      operation: "patch",
      requiresFullBaseline: false,
      allowsPartialBaseline: true,
    }, fp)

    expect(result.ok).toBe(true)
    expect(result.status).toBe("partial")
  })

  test("create is allowed only when the target is missing", () => {
    const ledger = new FileStateLedger()

    const missing = validateFreshnessForEdit(ledger, {
      path: "src/new.ts",
      operation: "create",
      requiresFullBaseline: false,
      allowsPartialBaseline: true,
    }, null)
    const existing = validateFreshnessForEdit(ledger, {
      path: "src/new.ts",
      operation: "create",
      requiresFullBaseline: false,
      allowsPartialBaseline: true,
    }, fingerprintContent("already here"))

    expect(missing.ok).toBe(true)
    expect(existing.ok).toBe(false)
    expect(existing.status).toBe("changed")
  })
})
