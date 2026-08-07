import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { addEvidence, createEvidenceLedger, latestEvidence } from "../src/agent/evidence-ledger"
import {
  backendQualityFindings,
  createTaskTracker,
  formatTaskTrackerPrompt,
  frontendDesignFindings,
  markPlanAccepted,
  missingTaskRequirements,
  taskTrackerComplete,
  updateTaskTrackerAfterTools,
} from "../src/agent/task-tracker"
import { recordRuntimeFileWrite, resetRuntimeFileStateLedger } from "../src/file-state"

function withTempProject(run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "dscode-quality-"))
  try {
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("TaskTracker", () => {
  test("creates a full-stack blog checklist", () => {
    const tracker = createTaskTracker("做一个全栈个人博客，包含前端后端和测试", "long_task")

    expect(tracker).toBeDefined()
    expect(tracker!.phase).toBe("planning")
    expect(tracker!.steps.map(step => step.id)).toContain("backend")
    expect(tracker!.steps.map(step => step.id)).toContain("frontend")
    expect(tracker!.requiredFiles).toContain("client/src/App.tsx")
    expect(tracker!.requiredFiles).toContain("client/src/App.css")
    expect(tracker!.requiredFiles).toContain("server/index.test.ts")
    expect(tracker!.requiredVerificationKinds).toEqual(["typecheck", "test", "build"])
    expect(formatTaskTrackerPrompt(tracker!)).toContain("任务追踪模式")
  })

  test("does not complete until required evidence appears", () => {
    const tracker = createTaskTracker("Build a complete full-stack personal blog with React and API", "long_task")!
    markPlanAccepted(tracker)
    updateTaskTrackerAfterTools({
      tracker,
      changedFiles: ["server/index.ts"],
      toolNames: ["write_file"],
      typecheckPassed: true,
    })

    expect(taskTrackerComplete(tracker)).toBe(false)
    expect(tracker.steps.find(step => step.id === "backend")?.status).toBe("done")
    expect(tracker.steps.find(step => step.id === "frontend")?.status).not.toBe("done")
    expect(missingTaskRequirements(tracker).some(item => item.includes("前端"))).toBe(true)
  })

  test("requires all task-specific verification kinds before completing long tasks", () => {
    const tracker = createTaskTracker("做一个全栈个人博客，包含前端后端和测试", "long_task")!
    markPlanAccepted(tracker)

    updateTaskTrackerAfterTools({
      tracker,
      changedFiles: [
        "package.json",
        "tsconfig.json",
        "server/index.ts",
        "server/index.test.ts",
        "server/posts.json",
        "client/src/App.tsx",
        "client/src/App.css",
      ],
      toolNames: ["write_file"],
      typecheckPassed: true,
    })

    expect(taskTrackerComplete(tracker)).toBe(false)
    expect(tracker.steps.find(step => step.id === "verification")?.status).not.toBe("done")

    updateTaskTrackerAfterTools({
      tracker,
      changedFiles: [],
      toolNames: ["shell"],
      verificationResults: [
        { kind: "test", command: "bun test", passed: true, issues: 0, durationMs: 1, summary: "ok" },
        { kind: "build", command: "bunx vite build", passed: true, issues: 0, durationMs: 1, summary: "ok" },
      ],
    })

    expect(tracker.steps.find(step => step.id === "verification")?.status).toBe("done")
    expect(taskTrackerComplete(tracker)).toBe(true)
  })

  test("evidence ledger preserves verification generation captured before later writes", () => {
    resetRuntimeFileStateLedger()
    const tracker = createTaskTracker("Build a complete full-stack personal blog with React and API", "long_task")!
    const ledger = createEvidenceLedger()
    recordRuntimeFileWrite({ path: join(tmpdir(), "after-verification.ts"), content: "export const changed = true\n" })

    updateTaskTrackerAfterTools({
      tracker,
      changedFiles: [],
      toolNames: ["shell"],
      verificationResults: [
        { kind: "typecheck", command: "bun run typecheck", passed: true, issues: 0, durationMs: 1, summary: "ok", generation: 0 },
      ],
      evidenceLedger: ledger,
    })

    expect(ledger.entries[0]?.generation).toBe(0)
  })

  test("completed tracker still ingests a later failed re-verification", () => {
    resetRuntimeFileStateLedger()
    const tracker = createTaskTracker("Build a complete full-stack personal blog with React and API", "long_task")!
    tracker.phase = "complete"
    const ledger = createEvidenceLedger()
    addEvidence(ledger, {
      id: "previous-pass",
      kind: "typecheck",
      command: "bun run typecheck",
      output: "ok",
      passed: true,
      timestamp: 1,
      generation: 0,
    })

    updateTaskTrackerAfterTools({
      tracker,
      changedFiles: [],
      toolNames: ["shell"],
      verificationResults: [
        { kind: "typecheck", command: "bun run typecheck", passed: false, issues: 1, durationMs: 1, summary: "failed", generation: 0 },
      ],
      evidenceLedger: ledger,
    })

    expect(latestEvidence(ledger, "typecheck")?.passed).toBe(false)
  })

  test("generic verification boolean does not satisfy concrete quality evidence", () => {
    const tracker = createTaskTracker("Build a complete full-stack personal blog with React and API", "long_task")!
    markPlanAccepted(tracker)

    updateTaskTrackerAfterTools({
      tracker,
      changedFiles: [],
      toolNames: ["shell"],
      verificationPassed: true,
    })

    expect(tracker.steps.find(step => step.id === "verification")?.status).not.toBe("done")
    expect(missingTaskRequirements(tracker).some(item => item.includes("typecheck"))).toBe(true)
    expect(missingTaskRequirements(tracker).some(item => item.includes("test"))).toBe(true)
    expect(missingTaskRequirements(tracker).some(item => item.includes("build"))).toBe(true)
  })

  test("frontend design gate blocks bare functional demos", () => {
    withTempProject((dir) => {
      const tracker = createTaskTracker("Build a React Vite frontend page", "long_task")!
      markPlanAccepted(tracker)
      mkdirSync(join(dir, "client", "src"), { recursive: true })
      writeFileSync(join(dir, "package.json"), "{}")
      writeFileSync(join(dir, "tsconfig.json"), "{}")
      writeFileSync(join(dir, "client", "src", "App.tsx"), "export default function App(){return <ul><li>Hello</li></ul>}")
      writeFileSync(join(dir, "client", "src", "App.css"), ".container{max-width:720px;margin:0 auto}")

      updateTaskTrackerAfterTools({
        tracker,
        changedFiles: ["client/src/App.tsx", "client/src/App.css"],
        toolNames: ["write_file"],
        verificationPassed: true,
      })

      const missing = missingTaskRequirements(tracker, dir)
      // GATE-05 (GS-07): quality 启发式不再是 completion blocker —— missing
      // 不包含设计发现；advisory 层（frontendDesignFindings）仍独立保留。
      expect(missing.some(item => item.includes("前端设计不足"))).toBe(false)
      expect(frontendDesignFindings(tracker, dir).some(item => item.includes("前端设计不足"))).toBe(true)
    })
  })

  test("frontend design gate accepts a designed responsive surface", () => {
    withTempProject((dir) => {
      const tracker = createTaskTracker("Build a React Vite frontend page", "long_task")!
      markPlanAccepted(tracker)
      mkdirSync(join(dir, "client", "src"), { recursive: true })
      writeFileSync(join(dir, "package.json"), "{}")
      writeFileSync(join(dir, "tsconfig.json"), "{}")
      writeFileSync(join(dir, "client", "src", "App.tsx"), [
        "export default function App(){",
        "return <main><nav className='topbar'>Brand</nav><section className='hero'><img src='https://example.com/cover.jpg' /></section><section className='featured'>Story</section><article className='reader'>Text</article></main>",
        "}",
      ].join("\n"))
      writeFileSync(join(dir, "client", "src", "App.css"), [
        ".topbar{display:flex}.hero{display:grid;grid-template-columns:1fr 1fr}.hero img{width:100%;height:420px;object-fit:cover}.featured{display:flex}.reader{max-width:760px}",
        "@media (max-width:800px){.hero{grid-template-columns:1fr}}",
        ".archive{display:grid}.visual{background:url(https://example.com/cover.jpg)}",
        ".story{color:#1e1b18;background:#fffaf2;border:1px solid rgba(0,0,0,.1);padding:24px;margin:12px;}".repeat(40),
      ].join("\n"))

      updateTaskTrackerAfterTools({
        tracker,
        changedFiles: ["client/src/App.tsx", "client/src/App.css"],
        toolNames: ["write_file"],
        verificationPassed: true,
      })

      const missing = missingTaskRequirements(tracker, dir)
      expect(missing.some(item => item.includes("前端设计不足"))).toBe(false)
      expect(frontendDesignFindings(tracker, dir)).toHaveLength(0)
    })
  })

  test("backend quality gate blocks shallow API implementations", () => {
    withTempProject((dir) => {
      const tracker = createTaskTracker("Build a backend API server with tests", "long_task")!
      markPlanAccepted(tracker)
      mkdirSync(join(dir, "server"), { recursive: true })
      writeFileSync(join(dir, "package.json"), "{}")
      writeFileSync(join(dir, "tsconfig.json"), "{}")
      writeFileSync(join(dir, "server", "index.ts"), "export function getPosts(){return []}")
      writeFileSync(join(dir, "server", "index.test.ts"), "test('works',()=>expect(true).toBe(true))")

      updateTaskTrackerAfterTools({
        tracker,
        changedFiles: ["server/index.ts", "server/index.test.ts"],
        toolNames: ["write_file"],
        verificationPassed: true,
      })

      const missing = missingTaskRequirements(tracker, dir)
      // GATE-05 (GS-07): 同上 —— 质量发现移出 blocking path，advisory 保留。
      expect(missing.some(item => item.includes("后端质量不足"))).toBe(false)
      expect(backendQualityFindings(tracker, dir).some(item => item.includes("后端质量不足"))).toBe(true)
    })
  })

  test("backend quality gate accepts API tests with service lifecycle and error paths", () => {
    withTempProject((dir) => {
      const tracker = createTaskTracker("Build a backend API server with tests", "long_task")!
      markPlanAccepted(tracker)
      mkdirSync(join(dir, "server"), { recursive: true })
      writeFileSync(join(dir, "package.json"), "{}")
      writeFileSync(join(dir, "tsconfig.json"), "{}")
      writeFileSync(join(dir, "server", "index.ts"), "export const server={stop(){},port:3099}; export function json(){ return new Response('{}',{status:404,headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}})}")
      writeFileSync(join(dir, "server", "index.test.ts"), "describe('api',()=>{let server:any;beforeAll(()=>{server={stop(){}}});afterAll(()=>server.stop());it('404',async()=>{const r=await fetch('http://localhost:3099/missing');expect([404,200]).toContain(r.status)})})")

      updateTaskTrackerAfterTools({
        tracker,
        changedFiles: ["server/index.ts", "server/index.test.ts"],
        toolNames: ["write_file"],
        verificationPassed: true,
      })

      const missing = missingTaskRequirements(tracker, dir)
      expect(missing.some(item => item.includes("后端质量不足"))).toBe(false)
      expect(backendQualityFindings(tracker, dir)).toHaveLength(0)
    })
  })

  test("Chinese browser prompts are recognized as needing smoke verification", () => {
    const tracker = createTaskTracker("帮我做一个浏览器插件，要冒烟验证", "long_task")
    expect(tracker?.requiredVerificationKinds).toContain("smoke")
  })

  test("model-facing evidence strings are clean UTF-8 Chinese, not mojibake", () => {
    const tracker = createTaskTracker("做一个全栈项目", "long_task")!
    updateTaskTrackerAfterTools({
      tracker,
      changedFiles: [],
      toolNames: ["shell"],
      typecheckPassed: true,
      verificationPassed: true,
      verificationResults: [
        { kind: "test", command: "bun test", passed: true, issues: 0, durationMs: 1, summary: "ok" },
        { kind: "build", command: "bunx vite build", passed: true, issues: 0, durationMs: 1, summary: "ok" },
      ],
    })

    const verificationStep = tracker.steps.find(step => step.id === "verification")
    expect(verificationStep?.evidence).toBe("验证命令通过: typecheck, test, build")

    const fresh = createTaskTracker("做一个全栈项目", "long_task")!
    expect(missingTaskRequirements(fresh).some(item => item.includes("缺少验证证据: typecheck"))).toBe(true)
  })

  test("promotes exactly one pending step per update", () => {
    const tracker = createTaskTracker("Build a full-stack blog", "long_task")!
    tracker.steps = [
      { id: "plan", title: "规划项目结构", status: "done" },
      { id: "backend", title: "创建后端接口", status: "pending" },
      { id: "frontend", title: "创建前端页面", status: "pending" },
    ]
    updateTaskTrackerAfterTools({
      tracker,
      changedFiles: [],
      toolNames: ["shell"],
      skipLegacyStepIds: true,
    })

    const running = tracker.steps.filter(step => step.status === "running")
    expect(running.map(step => step.id)).toEqual(["backend"])
    expect(tracker.steps.find(step => step.id === "frontend")?.status).toBe("pending")
  })

  test("no unreachable duplicate step-promotion block remains", () => {
    const source = readFileSync(new URL("../src/agent/task-tracker.ts", import.meta.url), "utf-8")
    expect(source).not.toContain('if (running?.status === "done")')
  })
})
