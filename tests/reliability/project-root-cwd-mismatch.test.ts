/** IC01: PROJECT_ROOT_CWD_MISMATCH = 0 —— freshness preflight 与工具执行
 *  使用同一 authority base。
 *
 *  regression（审核要求）：
 *    process.cwd() = A（测试进程真实 cwd = orcana repo，其下无 src/a.txt）
 *    projectRoot   = B（fixture，B/src/a.txt 存在且内容已知）
 *
 *  执行 freshness-bound 写工具（write/edit）后，baseline /
 *  approvedContents / expectedBaseHashes 必须全部绑定 B/src/a.txt，
 *  而不是 process.cwd()/src/a.txt。
 */

import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { buildTool } from "../../src/tools/registry"
import { READ_FILE, WRITE_FILE, EDIT_FILE } from "../../src/tools/file"
import { validateToolContractFreshness } from "../../src/file-state/contract-freshness"

function fixtureProject(): string {
  const root = mkdtempSync(join(tmpdir(), "ic01-freshness-b-"))
  mkdirSync(join(root, "src"), { recursive: true })
  writeFileSync(join(root, "src", "a.txt"), "PROJECT-B-CONTENT", "utf-8")
  return root
}

/** freshness 契约要求先读后写：通过 read_file 在 B/src/a.txt 上建立 ledger 基线。 */
async function establishBaseline(root: string): Promise<void> {
  const read = buildTool(READ_FILE)
  const result = await read.execute(
    { path: "src/a.txt" },
    { projectRoot: root, abortSignal: new AbortController().signal },
  )
  expect(result.success).toBe(true)
}

describe("IC01 PROJECT_ROOT_CWD_MISMATCH — freshness preflight binds projectRoot", () => {
  test("write_file: expectedBaseHashes/approvedContents 绑定 B/src/a.txt（cwd 侧无该文件）", async () => {
    const rootB = fixtureProject()
    try {
      // 前置条件：cwd（A = 仓库）下不存在 src/a.txt —— 若 freshness 错误
      // 绑定 cwd，baseline 将判定 absent。
      expect(existsSync(resolve(process.cwd(), "src", "a.txt"))).toBe(false)

      await establishBaseline(rootB)
      const write = buildTool(WRITE_FILE)
      const approval = await validateToolContractFreshness(
        write.contract,
        { path: "src/a.txt", content: "x" },
        { projectRoot: rootB },
      )
      expect(approval.ok).toBe(true)
      if (!approval.ok) return
      const target = resolve(rootB, "src", "a.txt")
      // baseline 绑定 projectRoot 路径，且 approvedContents 取到 B 的内容。
      expect(approval.approval.expectedBaseHashes[target]).toBeDefined()
      expect(approval.approval.approvedContents[target]).toBe("PROJECT-B-CONTENT")
      // 绝不绑定 cwd 路径。
      expect(approval.approval.expectedBaseHashes[resolve(process.cwd(), "src", "a.txt")]).toBeUndefined()

      // 端到端：写工具执行成功，落盘于 B/src/a.txt。
      const result = await write.execute(
        { path: "src/a.txt", content: "PROJECT-B-NEW" },
        { projectRoot: rootB, abortSignal: new AbortController().signal },
      )
      expect(result.success).toBe(true)
      expect(readFileSync(join(rootB, "src", "a.txt"), "utf-8")).toBe("PROJECT-B-NEW")
      expect(existsSync(resolve(process.cwd(), "src", "a.txt"))).toBe(false)
    } finally {
      rmSync(rootB, { recursive: true, force: true })
    }
  })

  test("edit_file: baseline 绑定 B/src/a.txt，编辑落到 projectRoot", async () => {
    const rootB = fixtureProject()
    try {
      await establishBaseline(rootB)
      const edit = buildTool(EDIT_FILE)
      const result = await edit.execute(
        { path: "src/a.txt", old_string: "PROJECT-B-CONTENT", new_string: "PROJECT-B-EDITED" },
        { projectRoot: rootB, abortSignal: new AbortController().signal },
      )
      expect(result.success).toBe(true)
      expect(readFileSync(join(rootB, "src", "a.txt"), "utf-8")).toBe("PROJECT-B-EDITED")
    } finally {
      rmSync(rootB, { recursive: true, force: true })
    }
  })
})
