import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { WorldStore } from "../../../src/kernel/world"

const CHILD = join(import.meta.dir, "schema-bootstrap-child.ts")

function waitForExit(child: ChildProcess): Promise<{ code: number | null; stderr: string }> {
  let stderr = ""
  child.stderr?.on("data", chunk => {
    stderr += String(chunk)
  })
  return new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", code => resolve({ code, stderr }))
  })
}

describe("AK-1 WorldDB schema bootstrap", () => {
  test("concurrent first open serializes bootstrap and validation", async () => {
    const root = mkdtempSync(join(tmpdir(), "orcana-world-schema-race-"))
    const children: ChildProcess[] = []
    const exits: Array<Promise<{ code: number | null; stderr: string }>> = []
    try {
      for (let index = 0; index < 4; index += 1) {
        const child = spawn(process.execPath, [CHILD, root], {
          cwd: join(import.meta.dir, "../../.."),
          stdio: ["ignore", "ignore", "pipe"],
        })
        children.push(child)
        exits.push(waitForExit(child))
      }
      expect(await Promise.all(exits)).toEqual([
        { code: 0, stderr: "" },
        { code: 0, stderr: "" },
        { code: 0, stderr: "" },
        { code: 0, stderr: "" },
      ])
      const store = new WorldStore(root)
      try {
        expect(store.verifyIntegrity()).toEqual([])
      } finally {
        store.close()
      }
    } finally {
      for (const child of children) {
        if (child.exitCode === null) child.kill()
      }
      rmSync(root, { recursive: true, force: true })
    }
  })
})
