import { describe, expect, test } from "bun:test"
import { READ_FILE } from "../src/tools/file"

describe("file runtime artifact guard", () => {
  test("blocks agent reads of run output and trace artifacts", async () => {
    for (const path of [
      "deepseek-run.out.txt",
      "deepseek-run.err.txt",
      ".orcana/runs/run_abc.jsonl",
    ]) {
      const result = await READ_FILE.execute({ path })
      expect(result.success).toBe(false)
      expect(result.metadata?.blocked).toBe(true)
      expect(result.content).toContain("Runtime artifact")
    }
  })
})
