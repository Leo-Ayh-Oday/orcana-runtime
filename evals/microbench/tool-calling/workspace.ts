/** ORMB-TU 确定性虚拟工作区 + 状态机工具集。
 *
 *  计划 §三：工具成对加干扰项（read_file/read_files、write_file/apply_patch、
 *  run_process/run_shell_script、service_start/service_status、search_files/
 *  search_symbols、git_diff/git_status、web_search/web_fetch）。每个工具修改
 *  可观察状态机，最终结果由状态验证，不依赖模型自报。
 *
 *  参数校验在执行层做（缺必填 → 返回错误文本让模型修复），对应
 *  Argument Validity 指标。
 */

export interface WorkspaceCall {
  name: string
  args: Record<string, unknown>
  result: string
  ok: boolean
}

export interface WorkspaceState {
  files: Record<string, string>
  services: Record<string, "stopped" | "running" | "error">
  /** git 历史：写操作按 (path, old, new) 追加，git_diff/git_status 读取。 */
  gitLog: Array<{ path: string; action: string; detail: string }>
  processLog: string[]
  calls: WorkspaceCall[]
}

export interface TUToolDef {
  description: string
  schema: {
    properties: Record<string, unknown>
    required: string[]
  }
  run: (args: Record<string, unknown>, ws: WorkspaceState) => string
}

function bigLog(): string {
  const lines: string[] = []
  for (let i = 1; i <= 500; i++) lines.push(`line-${String(i).padStart(3, "0")}`)
  return lines.join("\n")
}

const INITIAL_FILES: Record<string, string> = {
  "config.json": '{\n  "port": 8123,\n  "debug": false,\n  "version": 1\n}',
  "src/main.ts": "export const answer = 42\n",
  "src/utils.ts": "export function add(a: number, b: number): number { return a + b }\n",
  "tests/main.test.ts": "import { add } from '../src/utils'\n\nit('adds', () => expect(add(1, 2)).toBe(3))\n",
  "README.md": "# demo workspace\n\n确定性虚拟工作区，供 ORMB-TU 使用。\n",
  "data/big.log": bigLog(),
}

const BIG_LOG_TRUNCATED_HEADER = "[read_file] data/big.log 过大，仅返回前 100 行（共 500 行）。如需指定行段请带 range 参数重试（如 range=\"400-500\"）。\n"

function makeWorkspaceState(): WorkspaceState {
  return {
    files: { ...INITIAL_FILES },
    services: { web: "stopped", worker: "stopped" },
    gitLog: [],
    processLog: [],
    calls: [],
  }
}

/** 参数校验：缺必填返回 "参数错误: ..."，工具不执行（Argument Validity 的测法）。 */
function checkArgs(
  args: Record<string, unknown>,
  schema: TUToolDef["schema"],
): string | null {
  for (const key of schema.required) {
    const v = args[key]
    if (v === undefined || v === null || v === "") return `参数错误: 缺少必填字段 "${key}"`
  }
  return null
}

function mkLog(ws: WorkspaceState, name: string, args: Record<string, unknown>, result: string, ok = true): void {
  ws.calls.push({ name, args: { ...args }, result, ok })
}

export interface Toolbox {
  tools: Record<string, TUToolDef>
  ws: WorkspaceState
  /** 下一个瞬时失败的 compute 调用（C03 用，仅一次）。 */
  failNextCompute: boolean
}

export function makeToolbox(): Toolbox {
  const ws = makeWorkspaceState()
  const tools: Record<string, TUToolDef> = {}

  tools.read_file = {
    description: "读取单个文件的内容。参数: path(仓库内相对路径，必填), range(可选，行段如 \"400-500\"，仅超大文件需要)。文件不存在会返回未找到；超大文件默认只返回前 100 行，指定 range 可读任意行段。",
    schema: { properties: { path: { type: "string" }, range: { type: "string" } }, required: ["path"] },
    run: (args, ws) => {
      const path = String(args.path)
      if (!(path in ws.files)) return `[read_file] 未找到 ${path}，可选: ${Object.keys(ws.files).join(", ")}`
      if (path === "data/big.log") {
        const lines = ws.files[path]!.split("\n")
        const m = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(String(args.range ?? ""))
        if (m) {
          const from = Math.max(1, Number(m[1]))
          const to = Math.min(lines.length, Number(m[2]))
          if (from <= to) return `[read_file] ${path} 行 ${from}-${to}:\n${lines.slice(from - 1, to).join("\n")}`
        }
        return BIG_LOG_TRUNCATED_HEADER + lines.slice(0, 100).join("\n")
      }
      return `[read_file] ${path}:\n${ws.files[path]}`
    },
  }

  tools.read_files = {
    description: "一次读取多个文件。参数: paths(文件路径数组，必填)。适合需要多文件内容时使用。",
    schema: { properties: { paths: { type: "array", items: { type: "string" } } }, required: ["paths"] },
    run: (args, ws) => {
      const paths = (args.paths as unknown[]) ?? []
      const out = paths.map((p) => {
        const path = String(p)
        if (!(path in ws.files)) return `[read_files] 未找到 ${path}`
        if (path === "data/big.log") {
          const lines = ws.files[path]!.split("\n")
          return BIG_LOG_TRUNCATED_HEADER + lines.slice(0, 100).join("\n")
        }
        return `[read_files] ${path}:\n${ws.files[path]}`
      })
      return out.join("\n")
    },
  }

  tools.write_file = {
    description: "整体写入/覆盖一个文件的内容（创建新文件或完全替换现有文件）。参数: path(必填), content(完整新内容，必填)。适合创建文件或整体重写；只改一行请用 apply_patch。",
    schema: { properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    run: (args, ws) => {
      const path = String(args.path)
      const content = String(args.content)
      const old = ws.files[path] ?? "(新建)"
      ws.files[path] = content
      ws.gitLog.push({ path, action: "write", detail: old === "(新建)" ? "created" : `${old.length} → ${content.length} chars` })
      return `[write_file] 已写入 ${path} (${content.length} chars)`
    },
  }

  tools.apply_patch = {
    description: "对单个文件做精准修改（单行替换）。参数: path(必填), patch(必填，格式 \"原文 -> 新文\"，原文必须在文件中恰好出现一次)。适合小改动；整体重写请用 write_file。",
    schema: { properties: { path: { type: "string" }, patch: { type: "string" } }, required: ["path", "patch"] },
    run: (args, ws) => {
      const path = String(args.path)
      const patch = String(args.patch)
      if (!(path in ws.files)) return `[apply_patch] 未找到 ${path}`
      const idx = patch.indexOf(" -> ")
      if (idx === -1) return `[apply_patch] patch 格式错误（应为 "原文 -> 新文"）: ${patch}`
      const from = patch.slice(0, idx)
      const to = patch.slice(idx + 4)
      const content = ws.files[path]!
      if (!content.includes(from)) return `[apply_patch] 未在 ${path} 中找到 "原文": ${from}`
      ws.files[path] = content.replace(from, to)
      ws.gitLog.push({ path, action: "patch", detail: `${from.slice(0, 30)} -> ${to.slice(0, 30)}` })
      return `[apply_patch] 已修改 ${path}`
    },
  }

  tools.run_process = {
    description: "运行项目命令。参数: command(必填)。可用命令: test(运行测试套件), build(构建项目)。其他命令返回未知命令错误。",
    schema: { properties: { command: { type: "string" } }, required: ["command"] },
    run: (args, ws) => {
      const cmd = String(args.command)
      ws.processLog.push(cmd)
      if (cmd === "test") {
        const pass = ws.files["src/utils.ts"]!.includes("add(")
        return `[run_process] test → ${pass ? "PASS (2 tests)" : "FAIL"}`
      }
      if (cmd === "build") return "[run_process] build → OK"
      return `[run_process] 未知命令: ${cmd}（可用: test, build）`
    },
  }

  tools.run_shell_script = {
    description: "执行一段 shell 脚本（通用，结果只记录不落盘）。参数: script(必填)。",
    schema: { properties: { script: { type: "string" } }, required: ["script"] },
    run: (args, ws) => {
      const script = String(args.script)
      ws.processLog.push(`shell:${script}`)
      return `[run_shell_script] 已执行: ${script.slice(0, 60)}`
    },
  }

  tools.service_start = {
    description: "启动一个服务。参数: name(必填)。可用: web, worker。已运行则无操作。",
    schema: { properties: { name: { type: "string" } }, required: ["name"] },
    run: (args, ws) => {
      const name = String(args.name)
      if (!(name in ws.services)) return `[service_start] 未知服务: ${name}（可用: web, worker）`
      ws.services[name] = "running"
      return `[service_start] ${name} 已启动`
    },
  }

  tools.service_status = {
    description: "查询服务状态。参数: name(必填)。返回 running/stopped/error。",
    schema: { properties: { name: { type: "string" } }, required: ["name"] },
    run: (args, ws) => {
      const name = String(args.name)
      if (!(name in ws.services)) return `[service_status] 未知服务: ${name}`
      return `[service_status] ${name}: ${ws.services[name]}`
    },
  }

  tools.search_files = {
    description: "按文件名关键词搜索仓库文件。参数: query(关键词，必填)。返回匹配的文件路径列表。",
    schema: { properties: { query: { type: "string" } }, required: ["query"] },
    run: (args, ws) => {
      const q = String(args.query)
      const hits = Object.keys(ws.files).filter((p) => p.includes(q))
      return hits.length > 0
        ? `[search_files] 命中: ${hits.join(", ")}`
        : `[search_files] 无匹配（仓库文件: ${Object.keys(ws.files).join(", ")}）`
    },
  }

  tools.search_symbols = {
    description: "按名称搜索代码符号（函数/类/变量，需要代码已索引）。参数: query(必填)。",
    schema: { properties: { query: { type: "string" } }, required: ["query"] },
    run: (args) => {
      const q = String(args.query)
      return `[search_symbols] 符号索引: add(main), answer(main), run()（query=${q}）`
    },
  }

  tools.git_diff = {
    description: "查看工作区自基准以来的全部改动（相对路径 + 改动摘要）。参数: path(可选，只看单文件)。",
    schema: { properties: { path: { type: "string" } }, required: [] },
    run: (args, ws) => {
      const path = String(args.path ?? "")
      const entries = ws.gitLog.filter((e) => !path || e.path === path)
      if (entries.length === 0) return "[git_diff] 无改动"
      return `[git_diff] ${entries.length} 处改动:\n${entries.map((e) => `  ${e.path} (${e.action}: ${e.detail})`).join("\n")}`
    },
  }

  tools.git_status = {
    description: "查看工作区状态：文件清单 + 是否有未提交改动。",
    schema: { properties: {}, required: [] },
    run: (_args, ws) => {
      const changed = ws.gitLog.length
      return `[git_status] ${changed > 0 ? "有" : "无"}未提交改动（${changed} 条）; 文件: ${Object.keys(ws.files).join(", ")}`
    },
  }

  tools.web_search = {
    description: "搜索网页。参数: query(关键词，必填)。返回搜索结果摘要。",
    schema: { properties: { query: { type: "string" } }, required: ["query"] },
    run: (args) => `[web_search] 结果: 1) example.com 首页 2) 其他站点（query=${String(args.query)}）`,
  }

  tools.web_fetch = {
    description: "抓取指定 URL 的页面内容。参数: url(完整 URL，必填)。",
    schema: { properties: { url: { type: "string" } }, required: ["url"] },
    run: (args) => {
      const url = String(args.url)
      if (url === "https://example.com") return "[web_fetch] <title>Example Domain</title> 这是示例站点。"
      return `[web_fetch] 无法访问 ${url}（白名单仅 https://example.com）`
    },
  }

  tools.compute = {
    description: "对两个整数做加/减/乘运算。参数: a(整数，必填), b(整数，必填), op(可选，默认 加，取值 加/减/乘/+/-/*)。",
    schema: {
      properties: { a: { type: "integer" }, b: { type: "integer" }, op: { type: "string", enum: ["加", "减", "乘", "+", "-", "*"] } },
      required: ["a", "b"],
    },
    run: (args, _ws) => {
      const a = Number(args.a)
      const b = Number(args.b)
      const op = String(args.op ?? "加")
      const map: Record<string, number> = { 加: a + b, 减: a - b, 乘: a * b, "+": a + b, "-": a - b, "*": a * b }
      const v = map[op]
      if (v === undefined) return `[compute] 未知运算符: ${op}`
      return `[compute] ${a} ${op} ${b} = ${v}`
    },
  }

  // 工具执行统一入口：参数校验 → 运行 → 记录调用
  const toolbox: Toolbox = { tools, ws, failNextCompute: false }
  const rawCompute = tools.compute.run
  tools.compute.run = (args, ws) => {
    if (toolbox.failNextCompute) {
      toolbox.failNextCompute = false
      mkLog(ws, "compute", args, "[compute] 瞬时故障: 服务不可用，请重试", false)
      return "[compute] 瞬时故障: 服务不可用，请重试"
    }
    return rawCompute(args, ws)
  }

  for (const [name, def] of Object.entries(tools)) {
    const raw = def.run
    def.run = (args, ws) => {
      const err = checkArgs(args, def.schema)
      if (err) {
        mkLog(ws, name, args, err, false)
        return err
      }
      const result = raw(args, ws)
      const ok = !/错误|未找到|无匹配|故障|未知/.test(result)
      mkLog(ws, name, args, result, ok)
      return result
    }
  }

  return toolbox
}

export function toolSchemas(toolbox: Toolbox): Array<Record<string, unknown>> {
  return Object.entries(toolbox.tools).map(([name, def]) => ({
    name,
    description: def.description,
    input_schema: { type: "object", properties: def.schema.properties, required: def.schema.required },
  }))
}
