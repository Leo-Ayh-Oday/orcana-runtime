/** RC-16 G10: tokenEstimate must be computed from actual content size, not
 *  from the digit count of a number string. */

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildRepoMap } from "../src/tools/repo-map"

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "rc16-tokest-"))
  mkdirSync(join(dir, "src"), { recursive: true })
  const lines: string[] = []
  for (let i = 0; i < 40; i++) {
    lines.push(`export function func${i}(input: string): string {`)
    lines.push(`  return \`fn-${i}-\${input}\``)
    lines.push(`}`)
  }
  writeFileSync(join(dir, "src", "many.ts"), lines.join("\n"), "utf-8")
  return dir
}

describe("repo map token estimate (RC-16 G10)", () => {
  test("tokenEstimate scales with actual scanned content", () => {
    const dir = makeProject()
    try {
      const files = ["src/many.ts"]
      const totalChars = files.reduce(
        (n, f) => n + readFileSync(join(dir, f), "utf-8").length,
        0,
      )
      expect(totalChars).toBeGreaterThan(1_000)

      const map = buildRepoMap({ projectRoot: dir })
      const expected = Math.ceil(totalChars / 3)
      expect(map.tokenEstimate).toBeGreaterThan(100)
      expect(Math.abs(map.tokenEstimate - expected)).toBeLessThanOrEqual(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
