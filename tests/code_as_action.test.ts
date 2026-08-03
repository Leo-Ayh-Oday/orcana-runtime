/**
 * Code-as-Action 可行性验证 — 18轮测试
 *
 * 测试 DeepSeek V4 是否能稳定输出可执行的 JavaScript 代码块来替代 JSON tool calls。
 * 通过标准: syntactic_valid ≥ 85%, semantic_valid ≥ 80%, overall_pass ≥ 80%
 */

import { DeepSeekProvider } from "../src/provider/deepseek"
import { test, expect, beforeAll, afterAll } from "bun:test"
import { mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs"
import { join } from "node:path"

const API_KEY = process.env.DEEPSEEK_API_KEY ?? ""
if (!API_KEY) throw new Error("DEEPSEEK_API_KEY not set")

const provider = new DeepSeekProvider(API_KEY)

// ── Temp dir for write tests (sandboxed, cleaned after test) ──

const TMP_DIR = join(import.meta.dir, "..", "tests", "tmp")

function mkTmpDir() {
  mkdirSync(TMP_DIR, { recursive: true })
  // Seed the file for edit_file test
  writeFileSync(join(TMP_DIR, "code_action_test.txt"), "hello from code interpreter", "utf-8")
}

function rmTmpDir() {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true })
}

// ── Safe write tool stubs (only write within TMP_DIR, prevent path traversal) ──

function write_file(path: string, content: string): void {
  const normalized = path.replace(/\\/g, "/")
  if (!normalized.startsWith("tests/tmp/") && !normalized.startsWith("tests\\tmp\\")) {
    throw new Error(`write_file blocked: path "${path}" is outside tests/tmp/ sandbox`)
  }
  const fullPath = join(import.meta.dir, "..", path)
  mkdirSync(join(fullPath, ".."), { recursive: true })
  writeFileSync(fullPath, content, "utf-8")
}

function edit_file(path: string, old_string: string, new_string: string): void {
  const normalized = path.replace(/\\/g, "/")
  if (!normalized.startsWith("tests/tmp/") && !normalized.startsWith("tests\\tmp\\")) {
    throw new Error(`edit_file blocked: path "${path}" is outside tests/tmp/ sandbox`)
  }
  const fullPath = join(import.meta.dir, "..", path)
  if (!existsSync(fullPath)) throw new Error(`edit_file: file not found: ${path}`)
  let content = readFileSync(fullPath, "utf-8")
  if (!content.includes(old_string)) throw new Error(`edit_file: old_string not found in ${path}`)
  content = content.replace(old_string, new_string)
  writeFileSync(fullPath, content, "utf-8")
}

// ── Mock tools rendered as JS function signatures (smolagents style) ──

const TOOL_SIGNATURES = [
  `function web_search(query: string, max_results?: number): string
  "Search the web using DuckDuckGo. Returns formatted results with titles, URLs, and snippets. Use this to find current information."`,

  `function read_file(path: string, offset?: number, limit?: number): string
  "Read a file from the project. Returns file content with line numbers. Always read before editing."`,

  `function write_file(path: string, content: string): void
  "Create or overwrite a file. Path is relative to project root. Content will be written as-is."`,

  `function edit_file(path: string, old_string: string, new_string: string): void
  "Replace exact text in a file. old_string must match exactly once in the file."`,

  `function shell(command: string, timeout?: number): string
  "Execute a shell command. On Windows use cmd commands. Returns stdout. Long commands timeout after 120s."`,

  `function glob(pattern: string): string[]
  "Find files matching a glob pattern. Returns array of file paths."`,

  `function final_answer(text: string): void
  "Signal task completion. Call this with your final response when done."`,
]

const TOOL_SIGNATURES_TEXT = TOOL_SIGNATURES.join("\n\n")

interface TestCase {
  name: string
  prompt: string
  expectedTools: string[]     // tools we expect the model to use
  expectedPatterns: string[]   // patterns the output should contain
  allowAnyTool: boolean
  allowNoToolAnswer: boolean
  _lastError?: string         // set by runRound on failure; fed back for retry
}

interface RoundResult {
  testName: string
  rawOutput: string
  hasCodeBlock: boolean
  codeBlock: string
  syntacticValid: boolean
  semanticValid: boolean
  resultText: string
  errorText: string
  retries: number            // 0 = first attempt, 1+ = retried
}

const MAX_RETRIES = 2

const ROUNDS: TestCase[] = [
  {
    name: "单搜索任务",
    prompt: "Search the web for 'DeepSeek V4 architecture 2026' and tell me the key findings.",
    expectedTools: ["web_search"],
    expectedPatterns: ["web_search"],
    allowAnyTool: false,
    allowNoToolAnswer: false,
  },
  {
    name: "单读文件任务",
    prompt: "Read the file package.json from the project root and tell me the project name and version.",
    expectedTools: ["read_file"],
    expectedPatterns: ["read_file"],
    allowAnyTool: false,
    allowNoToolAnswer: false,
  },
  {
    name: "多步搜索+分析",
    prompt: "Search for the population of Tokyo and Shanghai, then compare which is larger.",
    expectedTools: ["web_search"],
    expectedPatterns: ["web_search"],
    allowAnyTool: true,
    allowNoToolAnswer: false,
  },
  {
    name: "条件分支 — 文件存在性检查",
    prompt: "Read package.json. If it contains 'orcana' in the name field, print 'found deepseek project'. Otherwise print 'not our project'.",
    expectedTools: ["read_file"],
    expectedPatterns: ["read_file", "print"],
    allowAnyTool: true,
    allowNoToolAnswer: false,
  },
  {
    name: "循环处理",
    prompt: "Search for 3 different programming languages: Rust, Go, and TypeScript. For each, print the language name and one key finding.",
    expectedTools: ["web_search"],
    expectedPatterns: ["web_search"],
    allowAnyTool: true,
    allowNoToolAnswer: false,
  },
  {
    name: "简单问答 — 不需工具",
    prompt: "What is 2 + 2? Just tell me the answer with final_answer().",
    expectedTools: [],
    expectedPatterns: ["final_answer"],
    allowAnyTool: false,
    allowNoToolAnswer: false,
  },
  {
    name: "文件搜索+读取",
    prompt: "Use glob to find all .ts files in the src directory, then print the count.",
    expectedTools: ["glob"],
    expectedPatterns: ["glob", "print"],
    allowAnyTool: false,
    allowNoToolAnswer: false,
  },
  {
    name: "错误恢复 — 拼写错误",
    prompt: "Use websearch('AI coding agents 2026') to search, then print results. Note: the function is spelled 'web_search' not 'websearch'.",
    expectedTools: ["web_search"],
    expectedPatterns: ["web_search"],
    allowAnyTool: false,
    allowNoToolAnswer: false,
  },
  {
    name: "变量定义+复用",
    prompt: "Search for 'Claude Fable 5'. Store the result in a variable. Then print the variable contents.",
    expectedTools: ["web_search"],
    expectedPatterns: ["const", "web_search", "print"],
    allowAnyTool: false,
    allowNoToolAnswer: false,
  },
  {
    name: "shell 命令执行",
    prompt: "Run 'dir' (Windows) or 'ls' (Unix) to list files in the current directory, then print the output.",
    expectedTools: ["shell"],
    expectedPatterns: ["shell", "print"],
    allowAnyTool: false,
    allowNoToolAnswer: false,
  },
  {
    name: "复杂链式 — 搜索→提取→决策",
    prompt: "Search for 'best AI coding agent 2026'. If the results mention 'Claude', print 'Claude is mentioned'. If not, print 'Claude not found'. Finally call final_answer.",
    expectedTools: ["web_search"],
    expectedPatterns: ["if", "web_search", "print", "final_answer", "Claude"],
    allowAnyTool: true,
    allowNoToolAnswer: false,
  },
  {
    name: "多工具组合 — 读文件→条件→shell",
    prompt: "Read package.json. If the version starts with '0.', run 'echo beta-version'. If it starts with '1.', run 'echo stable-version'. Print the result.",
    expectedTools: ["read_file", "shell"],
    expectedPatterns: ["read_file", "if", "shell"],
    allowAnyTool: true,
    allowNoToolAnswer: false,
  },
  {
    name: "write_file — 创建新文件",
    prompt: "Using write_file, create a file at tests/tmp/code_action_test.txt with the content 'hello from code interpreter'. Then call final_answer with 'file created'.",
    expectedTools: ["write_file"],
    expectedPatterns: ["write_file", "final_answer"],
    allowAnyTool: false,
    allowNoToolAnswer: false,
  },
  {
    name: "edit_file — 精准替换",
    prompt: "The file tests/tmp/code_action_test.txt contains 'hello from code interpreter'. Use edit_file to replace 'hello' with 'hi' in that file. Then call final_answer with 'edited'. Do NOT read the file first — just do the edit.",
    expectedTools: ["edit_file"],
    expectedPatterns: ["edit_file", "hello", "hi", "final_answer"],
    allowAnyTool: false,
    allowNoToolAnswer: false,
  },
  {
    name: "read→write→read 组合验证",
    prompt: "First, create a file at tests/tmp/verify_test.txt with the content 'version=1'. Then read it back. Print the content. Then call final_answer.",
    expectedTools: ["write_file", "read_file"],
    expectedPatterns: ["write_file", "read_file", "final_answer"],
    allowAnyTool: false,
    allowNoToolAnswer: false,
  },
  {
    name: "write_file — 特殊字符内容 (引号/换行/反斜杠)",
    prompt: "Using write_file, create a file at tests/tmp/special_chars.txt with this exact content (includes quotes, backslashes, and newlines):\n\n{\n  \"name\": \"orcana\",\n  \"path\": \"C:\\\\Users\\\\test\",\n  \"description\": \"it's a coding agent\"\n}\n\nUse template strings (backticks) for the content. Call final_answer when done. Keep it short.",
    expectedTools: ["write_file"],
    expectedPatterns: ["write_file", "final_answer"],
    allowAnyTool: false,
    allowNoToolAnswer: false,
  },
  {
    name: "write_file — 模型自创模板字符串",
    prompt: "Create a file at tests/tmp/template_test.ts using write_file. The file should contain a simple TypeScript interface:\n\n```typescript\nexport interface User {\n  name: string;\n  age: number;\n}\n```\n\nUse whatever JavaScript string syntax you prefer (single quotes, double quotes, template literals). Print 'done' when finished and call final_answer.",
    expectedTools: ["write_file"],
    expectedPatterns: ["write_file", "export interface User", "final_answer"],
    allowAnyTool: true,
    allowNoToolAnswer: false,
  },
  {
    name: "多步写入链 — 创建→读取→验证",
    prompt: "Step 1: Create tests/tmp/chain.txt with content 'original'. Step 2: Read it back to verify the write succeeded. Step 3: Print the content you read and call final_answer with it.",
    expectedTools: ["write_file", "read_file"],
    expectedPatterns: ["write_file", "read_file", "original", "final_answer"],
    allowAnyTool: false,
    allowNoToolAnswer: false,
  },
]

// ── 验证函数 ──

interface RoundResult {
  testName: string
  rawOutput: string
  hasCodeBlock: boolean
  codeBlock: string
  syntacticValid: boolean   // can parse with new Function() ?
  semanticValid: boolean    // uses expected tools ?
  resultText: string        // simulated execution result
  errorText: string         // any errors
}

function extractCodeBlock(text: string): { code: string; found: boolean } {
  // Try <code>...</code> tags (smolagents style)
  let m = text.match(/<code>([\s\S]*?)<\/code>/)
  if (m) return { code: m[1]!.trim(), found: true }

  // Try ```javascript...``` or ```js...```
  m = text.match(/```(?:javascript|js|typescript|ts)\s*([\s\S]*?)```/)
  if (m) return { code: m[1]!.trim(), found: true }

  // Try any ``` code block
  m = text.match(/```\s*([\s\S]*?)```/)
  if (m) return { code: m[1]!.trim(), found: true }

  return { code: "", found: false }
}

function checkSyntactic(code: string): { valid: boolean; error?: string } {
  if (!code.trim()) return { valid: false, error: "empty code block" }
  try {
    new Function(code)
    return { valid: true }
  } catch (e) {
    return { valid: false, error: e instanceof SyntaxError ? e.message : String(e) }
  }
}

function checkSemantic(code: string, testCase: TestCase): { valid: boolean; issues: string[] } {
  const issues: string[] = []

  for (const tool of testCase.expectedTools) {
    if (!code.includes(tool)) {
      issues.push(`missing expected tool: ${tool}`)
    }
  }

  for (const pattern of testCase.expectedPatterns) {
    if (!new RegExp(pattern).test(code)) {
      issues.push(`missing expected pattern: ${pattern}`)
    }
  }

  // Check for known bad patterns
  if (code.includes("websearch(") && !code.includes("web_search(")) {
    issues.push("used 'websearch' instead of 'web_search'")
  }
  if (code.includes("readFile(") && !code.includes("read_file(")) {
    issues.push("used 'readFile' instead of 'read_file'")
  }
  if (code.includes("finalAnswer(") && !code.includes("final_answer(")) {
    issues.push("used 'finalAnswer' instead of 'final_answer'")
  }

  return { valid: issues.length === 0, issues }
}

async function runRound(testCase: TestCase, index: number, retryCount: number): Promise<RoundResult> {
  const system = [
    "You are an AI coding agent. You write JavaScript code inside <code>...</code> tags to perform actions.",
    "",
    "## Available functions (call them as JavaScript functions):",
    TOOL_SIGNATURES_TEXT,
    "",
    "## Rules:",
    "1. Write your reasoning as text first.",
    "2. Then output your JavaScript code inside <code>...</code> tags.",
    "3. Use ONLY the functions listed above. Do not invent new functions.",
    "4. print(...) is available for logging. Use it to show intermediate results.",
    "5. final_answer(text) signals completion. Always call it when done.",
    "6. Do NOT use require(), import, process, fetch, or any Node.js/Bun API.",
    "7. Variable names are case-sensitive.",
    "8. Keep code concise — use backtick templates for strings with special chars.",
  ].join("\n")

  const baseMessages = [
    { role: "user" as const, content: testCase.prompt },
  ]

  // If retry, append the error feedback
  const messages = retryCount > 0
    ? [
        ...baseMessages,
        { role: "user" as const, content: `Your previous code had an issue. Fix it and try again:\n\n<error>\n${testCase._lastError}\n</error>\n\nWrite a corrected version.` },
      ]
    : baseMessages

  const chunks: string[] = []
  try {
    for await (const event of provider.streamChat({
      model: "deepseek-v4-pro",
      system,
      messages,
      maxTokens: 4096,
    })) {
      if (event.type === "text" && typeof event.data === "string") {
        chunks.push(event.data)
      }
    }
  } catch (e) {
    testCase._lastError = e instanceof Error ? e.message : String(e)
    return {
      testName: testCase.name,
      rawOutput: "",
      hasCodeBlock: false,
      codeBlock: "",
      syntacticValid: false,
      semanticValid: false,
      resultText: "",
      errorText: e instanceof Error ? e.message : String(e),
      retries: retryCount,
    }
  }

  const rawOutput = chunks.join("")
  const { code, found } = extractCodeBlock(rawOutput)
  const syntactic = found ? checkSyntactic(code) : { valid: false, error: "no code block found" }
  const semantic = found ? checkSemantic(code, testCase) : { valid: false, issues: ["no code block"] }

  // ── Runtime execution validation ──
  let runtimeResult = ""
  let runtimeError = ""
  if (found && syntactic.valid) {
    const prints: string[] = []
    const print = (...args: unknown[]) => prints.push(args.map(String).join(" "))
    let finalAnswer = ""
    const final_answer = (text: string) => { finalAnswer = text; throw new FinalAnswerSignal() }

    // Stub tools — read_file and glob hit real disk, write_file/edit_file use sandbox
    const read_file = (p: string) => {
      const full = join(import.meta.dir, "..", p)
      if (!existsSync(full)) throw new Error(`read_file: not found: ${p}`)
      return readFileSync(full, "utf-8")
    }
    const glob = (pattern: string): string[] => {
      const dir = join(import.meta.dir, "..")
      const entries = readdirSync(dir, { withFileTypes: true, recursive: true })
        .filter(e => e.isFile())
        .map(e => join(e.parentPath, e.name).replace(/\\/g, "/").replace(dir.replace(/\\/g, "/"), ""))
      return entries.slice(0, 20)
    }
    const shell = (cmd: string) => `[shell stub: ${cmd.slice(0, 60)}]`

    try {
      const fn = new Function("web_search", "read_file", "write_file", "edit_file", "glob", "shell", "print", "final_answer", code)
      const web_search = (q: string) => `[web_search result for: "${q}"]`
      fn(web_search, read_file, write_file, edit_file, glob, shell, print, final_answer)
      runtimeResult = prints.join("\n") || "(no output)"
    } catch (e) {
      if (e instanceof FinalAnswerSignal) {
        runtimeResult = `final_answer called. Prints: ${prints.join("; ") || "(none)"}`
      } else {
        runtimeError = e instanceof Error ? e.message : String(e)
        runtimeResult = `runtime error: ${runtimeError}`
      }
    }
  }

  return {
    testName: testCase.name,
    rawOutput: rawOutput.slice(0, 2000),
    hasCodeBlock: found,
    codeBlock: code.slice(0, 1000),
    syntacticValid: syntactic.valid,
    semanticValid: testCase.expectedTools.length === 0 ? true : semantic.valid,
    resultText: runtimeResult.slice(0, 500) || (syntactic.valid ? "parsed ok" : (syntactic.error ?? "no code")),
    errorText: runtimeError || (found ? semantic.issues.join("; ") : "no code block extracted"),
    retries: retryCount,
  }
}

class FinalAnswerSignal extends Error {
  constructor() { super("final_answer") }
}

// ── 主测试 ──

test("code-as-action: 18轮可行性验证 (V4 Pro)", async () => {
  mkTmpDir()
  try {
  console.log("\n" + "=".repeat(60))
  console.log("Code-as-Action 可行性验证 — 18轮")
  console.log("模型: deepseek-v4-pro")
  console.log("sandbox: tests/tmp/ (写操作隔离)")
  console.log("通过标准: syntactic ≥ 85%, semantic ≥ 80%, write_tests ≥ 75%")
  console.log("=".repeat(60) + "\n")

  const results: RoundResult[] = []
  for (let i = 0; i < ROUNDS.length; i++) {
    const tc = ROUNDS[i]!
    let result: RoundResult | null = null

    // ── Retry loop: feed errors back so the model can fix itself ──
    for (let retry = 0; retry <= MAX_RETRIES; retry++) {
      const label = retry > 0 ? `retry ${retry}/${MAX_RETRIES}` : `[${i + 1}/${ROUNDS.length}]`
      console.log(`  ${label} ${tc.name}...`)
      result = await runRound(tc, i, retry)

      const s = result.syntacticValid ? "✅" : "❌"
      const m = result.semanticValid ? "✅" : "⚠️"
      console.log(`    syntax: ${s}  semantic: ${m}  result: ${result.resultText.slice(0, 80)}`)

      if (result.syntacticValid && result.semanticValid) break  // passed — stop retrying

      // Build error context for the next retry
      const errors: string[] = []
      if (!result.syntacticValid) errors.push(`SyntaxError: ${result.errorText}`)
      if (!result.semanticValid) errors.push(`Semantic issues: ${result.errorText}`)
      if (errors.length === 0 && result.resultText.includes("runtime error")) errors.push(result.resultText)
      tc._lastError = errors.join("\n") || result.errorText || result.resultText

      if (retry < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 800))
      }
    }
    if (!result!.syntacticValid || !result!.semanticValid) {
      console.log(`    ❌ FAILED after ${MAX_RETRIES} retries: ${result!.errorText.slice(0, 150)}`)
    }
    results.push(result!)

    // Rate limiting
    if (i < ROUNDS.length - 1) await new Promise(r => setTimeout(r, 1500))
  }

  // ── 汇总 ──
  const total = results.length
  const syntacticOk = results.filter(r => r.syntacticValid).length
  const semanticOk = results.filter(r => r.semanticValid).length
  const bothOk = results.filter(r => r.syntacticValid && r.semanticValid).length
  const noCodeBlock = results.filter(r => !r.hasCodeBlock).length

  console.log("\n" + "=".repeat(60))
  console.log("汇总报告")
  console.log("=".repeat(60))
  console.log(`总轮次:     ${total}`)
  console.log(`语法正确:   ${syntacticOk}/${total} (${Math.round(syntacticOk / total * 100)}%)`)
  console.log(`语义正确:   ${semanticOk}/${total} (${Math.round(semanticOk / total * 100)}%)`)
  console.log(`全部通过:   ${bothOk}/${total} (${Math.round(bothOk / total * 100)}%)`)
  console.log(`无代码块:   ${noCodeBlock}/${total}`)

  // 详细失败列表
  const failures = results.filter(r => !r.syntacticValid || !r.semanticValid)
  if (failures.length > 0) {
    console.log("\n失败详情:")
    for (const f of failures) {
      console.log(`\n  [${f.syntacticValid ? "⚠" : "❌"}] ${f.testName}`)
      console.log(`  代码: ${f.codeBlock.slice(0, 200)}`)
      console.log(`  错误: ${f.errorText}`)
    }
  }

  // ── 写操作专项统计 ──
  const writeRounds = results.filter(r =>
    r.testName.includes("write_file") || r.testName.includes("edit_file") ||
    r.testName.includes("写入") || r.testName.includes("组合验证") || r.testName.includes("多步写入"),
  )
  const writeOk = writeRounds.filter(r => r.syntacticValid && r.semanticValid).length
  console.log(`写操作 (${writeRounds.length}轮): ${writeOk}/${writeRounds.length} (${writeRounds.length ? Math.round(writeOk / writeRounds.length * 100) : 0}%)`)

  // 写操作失败详情
  const writeFailures = writeRounds.filter(r => !r.syntacticValid || !r.semanticValid)
  if (writeFailures.length > 0) {
    console.log("\n写操作失败详情:")
    for (const f of writeFailures) {
      console.log(`\n  [${f.syntacticValid ? "⚠" : "❌"}] ${f.testName}`)
      console.log(`  结果: ${f.resultText}`)
      console.log(`  代码: ${f.codeBlock.slice(0, 200)}`)
      console.log(`  错误: ${f.errorText}`)
    }
  }

  console.log("\n")

  // 断言
  expect(syntacticOk / total).toBeGreaterThanOrEqual(0.85)
  expect(semanticOk / total).toBeGreaterThanOrEqual(0.80)
  expect(bothOk / total).toBeGreaterThanOrEqual(0.80)
  // 写操作专项 — 至少 75%
  if (writeRounds.length > 0) {
    expect(writeOk / writeRounds.length).toBeGreaterThanOrEqual(0.75)
  }
  } finally {
    rmTmpDir()
  }
}, { timeout: 600_000 })  // 10 minutes for all 18 rounds
