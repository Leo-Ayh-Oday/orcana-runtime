/** IC01: WorkspaceIoAuthority —— 统一工作区 I/O 权威（漂移/秘密/越界/symlink）。
 *
 *  完成 Gate：
 *    - OUTSIDE_WORKSPACE_READ = 0
 *    - SECRET_READ = 0
 *    - WORKSPACE_PATH_BASE_DRIFT = 0
 *    - SYMLINK_READ_ESCAPE = 0
 *
 *  覆盖：
 *    - projectRoot != process.cwd()
 *    - authority hostRoot 与 context.projectRoot 漂移 → 拒绝
 *    - ../../secret 相对逃逸 → 拒绝
 *    - absolute workspace 外路径 → 拒绝
 *    - workspace 内 symlink 指向外部 → 拒绝
 *    - .env / private key / credentials → 拒绝；.env.example → 允许
 *    - 显式 secret grant 只来自 Runtime；Tool 参数无法授予
 *    - 既有 projectRoot/symlink 行为（无 authority）不受影响
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { buildTool, buildTools } from "../../src/tools/registry"
import { READ_FILE, WRITE_FILE } from "../../src/tools/file"
import {
  createRuntimeExecutionContext,
  runWithRuntimeExecutionContext,
  setWorkspaceIoAuthority,
} from "../../src/runtime/execution-context"
import {
  createWorkspaceIoAuthority,
  workspaceIoAuthorityFromTrusted,
  checkWorkspaceBaseDrift,
  checkSecretRead,
  validateOpenFileCanonical,
} from "../../src/runtime/io/workspace-io-authority"
import { createAgentRunScope } from "../../src/agent/run/scope"
import type { WorkspaceIoAuthority } from "../../src/runtime/io/workspace-io-authority"
import type { ToolExecutionContext } from "../../src/tools/registry"

let ROOT = ""
let OUTSIDE = ""
let DECOY = ""
let PROJECT_LINK = ""

beforeAll(() => {
  ROOT = mkdtempSync(join(tmpdir(), "orcana-ic01-ws-"))
  OUTSIDE = mkdtempSync(join(tmpdir(), "orcana-ic01-out-"))
  DECOY = mkdtempSync(join(tmpdir(), "orcana-ic01-decoy-"))
  mkdirSync(join(ROOT, "src"), { recursive: true })
  mkdirSync(join(ROOT, ".ssh"), { recursive: true })
  mkdirSync(join(ROOT, ".aws"), { recursive: true })
  mkdirSync(join(DECOY, "src"), { recursive: true })
  mkdirSync(join(OUTSIDE, "secret-dir"), { recursive: true })
  writeFileSync(join(ROOT, "src", "a.txt"), "WORKSPACE-CONTENT")
  writeFileSync(join(DECOY, "src", "a.txt"), "DECOY-CONTENT")
  writeFileSync(join(ROOT, ".env"), "TOKEN=secret")
  writeFileSync(join(ROOT, ".env.example"), "TOKEN=example")
  writeFileSync(join(ROOT, "src", ".env"), "NESTED=secret")
  writeFileSync(join(ROOT, ".ssh", "id_rsa"), "PRIVATE-KEY")
  writeFileSync(join(ROOT, ".aws", "credentials"), "aws_secret=xyz")
  writeFileSync(join(ROOT, "credentials.json"), '{"password":"x"}')
  writeFileSync(join(ROOT, ".npmrc"), "//npm:token=abc")
  writeFileSync(join(OUTSIDE, "outside.txt"), "OUTSIDE-SECRET")
  writeFileSync(join(OUTSIDE, "secret-dir", "payload.txt"), "OUTSIDE-PAYLOAD")
  // P0-1 攻击面：projectRoot 为 workspace 的 symlink alias（P2-7 语义）。
  PROJECT_LINK = join(tmpdir(), `orcana-ic01-link-${process.pid}`)
  try {
    symlinkSync(ROOT, PROJECT_LINK)
  } catch {
    // exists
  }
})

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
  rmSync(OUTSIDE, { recursive: true, force: true })
  rmSync(DECOY, { recursive: true, force: true })
  rmSync(PROJECT_LINK, { recursive: true, force: true })
})

function makeContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    projectRoot: ROOT,
    abortSignal: new AbortController().signal,
    ...overrides,
  } as ToolExecutionContext
}

/** 在 ALS 上下文中注入 WorkspaceIoAuthority 后执行工具调用。 */
async function withAuthority<T>(
  authority: WorkspaceIoAuthority,
  callback: () => Promise<T>,
): Promise<T> {
  const ctx = createRuntimeExecutionContext()
  return runWithRuntimeExecutionContext(ctx, async () => {
    setWorkspaceIoAuthority(authority)
    return await callback()
  })
}

function authorityFor(root = ROOT, grants: string[] = []): WorkspaceIoAuthority {
  return createWorkspaceIoAuthority(root, { secretGrants: grants })
}

const read = buildTool(READ_FILE)
const write = buildTool(WRITE_FILE)

describe("IC01 WORKSPACE_PATH_BASE_DRIFT — 基线漂移 fail closed", () => {
  test("checkWorkspaceBaseDrift：一致 → null；不一致 → DRIFT", () => {
    const ws = authorityFor(ROOT)
    expect(checkWorkspaceBaseDrift(ws, ROOT)).toBeNull()
    const drift = checkWorkspaceBaseDrift(ws, DECOY)
    expect(drift).not.toBeNull()
    expect(drift!.code).toBe("WORKSPACE_PATH_BASE_DRIFT")
  })

  test("context.projectRoot 与权威读取根不一致 → read 拒绝（WORKSPACE_PATH_BASE_DRIFT）", async () => {
    await withAuthority(authorityFor(ROOT), async () => {
      const result = await read.execute({ path: "src/a.txt" }, makeContext({ projectRoot: DECOY }))
      expect(result.success).toBe(false)
      expect(result.metadata).toMatchObject({
        blocked: true,
        gate: "workspace_io",
        workspaceIo: { code: "WORKSPACE_PATH_BASE_DRIFT" },
      })
    })
  })

  test("漂移时 write 同样 fail closed", async () => {
    await withAuthority(authorityFor(ROOT), async () => {
      const result = await write.execute(
        { path: "src/out.txt", content: "x", confirm: true },
        makeContext({ projectRoot: DECOY }),
      )
      expect(result.success).toBe(false)
      expect(result.metadata?.workspaceIo).toMatchObject({ code: "WORKSPACE_PATH_BASE_DRIFT" })
    })
  })

  test("authority 派生于 TrustedExecutionAuthority.workspace.hostRoot", async () => {
    const trusted = {
      identity: { runId: "r", nodeRunId: "r:n1", attempt: 1 },
      workspace: {
        workspaceId: "w",
        physicalWorkspaceKey: "k",
        projectId: "p",
        hostRoot: ROOT,
        kind: "main" as const,
        access: "readwrite" as const,
        ownerFiles: [],
      },
    }
    const derived = workspaceIoAuthorityFromTrusted(trusted)
    expect(derived.readRoot).toBe(resolve(ROOT))
  })

  test("AgentRunScope 派生 workspaceIo（production 读取根 = hostRoot）", () => {
    const scope = createAgentRunScope({
      tools: buildTools(READ_FILE),
      id: "scope-ic01",
      authority: {
        identity: { runId: "r", nodeRunId: "r:n1", attempt: 1 },
        workspace: {
          workspaceId: "w",
          physicalWorkspaceKey: "k",
          projectId: "p",
          hostRoot: ROOT,
          kind: "main" as const,
          access: "readwrite" as const,
          ownerFiles: [],
        },
      },
    })
    expect(scope.workspaceIo).toBeDefined()
    expect(scope.workspaceIo!.readRoot).toBe(resolve(ROOT))
  })
})

describe("IC01 OUTSIDE_WORKSPACE_READ — 权威读取根边界", () => {
  test("绝对路径在权威根之外（即使 readableRoots 放行）→ OUTSIDE_WORKSPACE_READ", async () => {
    const ws = createWorkspaceIoAuthority(ROOT)
    await withAuthority(ws, async () => {
      const result = await read.execute(
        { path: join(OUTSIDE, "outside.txt") },
        makeContext({ projectRoot: ROOT, readableRoots: [ROOT, OUTSIDE] }),
      )
      expect(result.success).toBe(false)
      expect(result.metadata).toMatchObject({
        blocked: true,
        gate: "workspace_io",
        workspaceIo: { code: "OUTSIDE_WORKSPACE_READ" },
      })
    })
  })

  test("相对 .. 逃逸到权威根之外 → 拒绝", async () => {
    await withAuthority(authorityFor(ROOT), async () => {
      const result = await read.execute({ path: "../../etc/passwd" }, makeContext())
      expect(result.success).toBe(false)
    })
  })

  test("绝对路径在权威根之外（无 readableRoots 放行）→ 拒绝", async () => {
    await withAuthority(authorityFor(ROOT), async () => {
      const result = await read.execute({ path: join(OUTSIDE, "outside.txt") }, makeContext())
      expect(result.success).toBe(false)
    })
  })

  test("权威根之内的正常读取通过", async () => {
    await withAuthority(authorityFor(ROOT), async () => {
      const result = await read.execute({ path: "src/a.txt" }, makeContext())
      expect(result.success).toBe(true)
      expect(result.content).toContain("WORKSPACE-CONTENT")
    })
  })
})

describe("IC01 SYMLINK_READ_ESCAPE — workspace 内 symlink 指向外部", () => {
  test("workspace 内 symlink → 权威根外目标 → 拒绝（SYMLINK_READ_ESCAPE）", async () => {
    const link = join(ROOT, "src", "escape-link.txt")
    try {
      symlinkSync(join(OUTSIDE, "outside.txt"), link)
    } catch {
      // exists
    }
    await withAuthority(authorityFor(ROOT), async () => {
      const result = await read.execute({ path: "src/escape-link.txt" }, makeContext())
      expect(result.success).toBe(false)
    })
  })

  test("readableRoots 放行但权威根不放行 → 权威层拒绝（SYMLINK_READ_ESCAPE）", async () => {
    const link = join(ROOT, "src", "escape-link.txt")
    try {
      symlinkSync(join(OUTSIDE, "outside.txt"), link)
    } catch {
      // exists
    }
    const ws = createWorkspaceIoAuthority(ROOT)
    await withAuthority(ws, async () => {
      const result = await read.execute(
        { path: "src/escape-link.txt" },
        makeContext({ projectRoot: ROOT, readableRoots: [ROOT, OUTSIDE] }),
      )
      expect(result.success).toBe(false)
      expect((result.metadata?.workspaceIo as { code?: string } | undefined)?.code).toBe("SYMLINK_READ_ESCAPE")
    })
  })

  test("无 authority 时既有 symlink 拒绝行为保持（resolveToolPath）", async () => {
    const link = join(ROOT, "src", "escape-link.txt")
    try {
      symlinkSync(join(OUTSIDE, "outside.txt"), link)
    } catch {
      // exists
    }
    const result = await read.execute({ path: "src/escape-link.txt" }, makeContext())
    expect(result.success).toBe(false)
  })
})

describe("IC01 SECRET_READ — 统一 secret deny policy", () => {
  test(".env 拒绝", async () => {
    await withAuthority(authorityFor(ROOT), async () => {
      const result = await read.execute({ path: ".env" }, makeContext())
      expect(result.success).toBe(false)
      expect(result.metadata).toMatchObject({
        blocked: true,
        gate: "workspace_io",
        workspaceIo: { code: "SECRET_READ" },
      })
    })
  })

  test("P0-1: workspace 内 benign symlink alias → workspace 内 .env → SECRET_READ（canonical target 二次检查）", async () => {
    const alias = join(ROOT, "src", "env-alias.txt")
    try {
      symlinkSync("../.env", alias)
    } catch {
      // exists
    }
    await withAuthority(authorityFor(ROOT), async () => {
      const result = await read.execute({ path: "src/env-alias.txt" }, makeContext())
      expect(result.success).toBe(false)
      expect((result.metadata?.workspaceIo as { code?: string } | undefined)?.code).toBe("SECRET_READ")
    })
  })

  test("P2-7: projectRoot = workspace symlink alias → 正常读取 ALLOW（canonical containment）", async () => {
    await withAuthority(authorityFor(ROOT), async () => {
      const result = await read.execute(
        { path: "src/a.txt" },
        makeContext({ projectRoot: PROJECT_LINK }),
      )
      expect(result.success).toBe(true)
      expect(result.content).toContain("WORKSPACE-CONTENT")
    })
  })

  test("P2-7: projectRoot = workspace symlink alias 时，alias 下 symlink 逃逸仍拒绝", async () => {
    const alias = join(ROOT, "src", "alias-escape.txt")
    try {
      symlinkSync(join(OUTSIDE, "outside.txt"), alias)
    } catch {
      // exists
    }
    await withAuthority(authorityFor(ROOT), async () => {
      // readableRoots 放行 OUTSIDE → resolveToolPath 层放行；权威层（canonical
      // containment）必须仍拒绝。
      const result = await read.execute(
        { path: "src/alias-escape.txt" },
        makeContext({ projectRoot: PROJECT_LINK, readableRoots: [OUTSIDE] }),
      )
      expect(result.success).toBe(false)
      expect((result.metadata?.workspaceIo as { code?: string } | undefined)?.code).toBe("SYMLINK_READ_ESCAPE")
    })
  })

  test("复审 P0-1/P1-6: post-open fd canonical 重跑 secret policy（open 后真实目标为 .env → SECRET_READ）", async () => {
    // 直接打开 .env（合法 fd），用 benign 路径作为用户请求路径调用
    // validateOpenFileCanonical —— open 后的真实对象是秘密文件必须被拒绝。
    const fd = openSync(join(ROOT, ".env"), "r")
    try {
      const ws = authorityFor(ROOT)
      const violation = await validateOpenFileCanonical(ws, join(ROOT, "src", "benign.txt"), fd)
      expect(violation).not.toBeNull()
      expect(violation?.code).toBe("SECRET_READ")
    } finally {
      closeSync(fd)
    }
  })

  test("复审 P1-6: post-open fd canonical 在权威根内且非秘密 → null（放行）", async () => {
    const fd = openSync(join(ROOT, "src", "a.txt"), "r")
    try {
      const ws = authorityFor(ROOT)
      const violation = await validateOpenFileCanonical(ws, join(ROOT, "src", "a.txt"), fd)
      expect(violation).toBeNull()
    } finally {
      closeSync(fd)
    }
  })

  test("嵌套 .env（src/.env）同样拒绝", async () => {
    await withAuthority(authorityFor(ROOT), async () => {
      const result = await read.execute({ path: "src/.env" }, makeContext())
      expect(result.success).toBe(false)
      expect((result.metadata?.workspaceIo as { code?: string } | undefined)?.code).toBe("SECRET_READ")
    })
  })

  test("private key（.ssh/id_rsa）拒绝", async () => {
    await withAuthority(authorityFor(ROOT), async () => {
      const result = await read.execute({ path: ".ssh/id_rsa" }, makeContext())
      expect(result.success).toBe(false)
      expect((result.metadata?.workspaceIo as { code?: string } | undefined)?.code).toBe("SECRET_READ")
    })
  })

  test("credentials（credentials.json / .aws / .npmrc）拒绝", async () => {
    await withAuthority(authorityFor(ROOT), async () => {
      for (const file of ["credentials.json", ".aws/credentials", ".npmrc"]) {
        const result = await read.execute({ path: file }, makeContext())
        expect(result.success).toBe(false)
        expect((result.metadata?.workspaceIo as { code?: string } | undefined)?.code).toBe("SECRET_READ")
      }
    })
  })

  test(".env.example 允许", async () => {
    await withAuthority(authorityFor(ROOT), async () => {
      const result = await read.execute({ path: ".env.example" }, makeContext())
      expect(result.success).toBe(true)
      expect(result.content).toContain("TOKEN=example")
    })
  })

  test("Runtime secret grant 放行被拒文件", async () => {
    const ws = authorityFor(ROOT, [resolve(ROOT, ".env")])
    await withAuthority(ws, async () => {
      const result = await read.execute({ path: ".env" }, makeContext())
      expect(result.success).toBe(true)
      expect(result.content).toContain("TOKEN=secret")
    })
  })

  test("Tool 参数无法授予 secret（grant 参数被忽略，仍然拒绝）", async () => {
    await withAuthority(authorityFor(ROOT), async () => {
      const result = await read.execute(
        { path: ".env", secretGrant: "anything", grant: "anything" },
        makeContext(),
      )
      expect(result.success).toBe(false)
      expect((result.metadata?.workspaceIo as { code?: string } | undefined)?.code).toBe("SECRET_READ")
    })
  })

  test("checkSecretRead：grant 集合精确匹配才放行", () => {
    const ws = authorityFor(ROOT, [resolve(ROOT, ".env")])
    expect(checkSecretRead(ws, resolve(ROOT, ".env"))).toBeNull()
    expect(checkSecretRead(ws, resolve(ROOT, "src", ".env"))?.code).toBe("SECRET_READ")
  })
})

describe("IC01 既有行为保持（无 authority / projectRoot != cwd）", () => {
  test("无 authority 时工具行为不变（projectRoot 绑定）", async () => {
    const result = await read.execute({ path: "src/a.txt" }, makeContext())
    expect(result.success).toBe(true)
    expect(result.content).toContain("WORKSPACE-CONTENT")
  })

  test("有 authority 且 projectRoot == 权威根，cwd 指向他处 → 仍只读权威根", async () => {
    const saved = process.cwd()
    try {
      process.chdir(DECOY)
      await withAuthority(authorityFor(ROOT), async () => {
        const result = await read.execute({ path: "src/a.txt" }, makeContext())
        expect(result.success).toBe(true)
        expect(result.content).toContain("WORKSPACE-CONTENT")
        expect(result.content).not.toContain("DECOY-CONTENT")
      })
    } finally {
      process.chdir(saved)
    }
  })

  test("workspace 文件真实存在（fixture 完整性自检）", () => {
    expect(existsSync(join(ROOT, "src", "a.txt"))).toBe(true)
    expect(existsSync(join(OUTSIDE, "outside.txt"))).toBe(true)
  })
})
