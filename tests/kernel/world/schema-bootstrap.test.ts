import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { WorldStore } from "../../../src/kernel/world"
import { removeTestWorldRoot } from "./helpers"

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
      removeTestWorldRoot(root)
    }
  })

  test("a stale bootstrap lock recovers a partially written first database", () => {
    const root = mkdtempSync(join(tmpdir(), "orcana-world-schema-crash-"))
    try {
      mkdirSync(join(root, "recovery"))
      writeFileSync(join(root, "world.db"), "partial sqlite image")
      writeFileSync(join(root, "world.db-wal"), "")
      writeFileSync(join(root, "world.db-shm"), "")
      writeFileSync(join(root, "world.db-journal"), "")
      writeFileSync(join(root, "recovery", "worlddb-bootstrap.lock"), "999999\n")

      const store = new WorldStore(root)
      try {
        expect(store.verifyIntegrity()).toEqual([])
        expect(existsSync(join(root, "recovery", "worlddb-bootstrap.complete"))).toBe(true)
        expect(existsSync(join(root, "recovery", "worlddb-bootstrap.lock"))).toBe(false)
        expect(readFileSync(join(root, "world.db")).subarray(0, 15).toString()).toBe(
          "SQLite format 3",
        )
      } finally {
        store.close()
      }
    } finally {
      removeTestWorldRoot(root)
    }
  })

  test("a non-empty database without bootstrap provenance fails closed", () => {
    const root = mkdtempSync(join(tmpdir(), "orcana-world-schema-unproven-"))
    const unproven = Buffer.from("unproven database bytes")
    try {
      writeFileSync(join(root, "world.db"), unproven)
      expect(() => new WorldStore(root)).toThrow(/WORLD_DB_BOOTSTRAP_MARKER_MISSING/)
      expect(readFileSync(join(root, "world.db"))).toEqual(unproven)
    } finally {
      removeTestWorldRoot(root)
    }
  })
})
