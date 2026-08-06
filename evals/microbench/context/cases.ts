/** ORMB-P3 8 个 Context 长任务用例（计划 §P3）。
 *
 *  4 个接近 compress threshold（短任务 ~10 步，上下文 ~12-20k chars）
 *  4 个接近 rollover threshold（长任务 ~25 步，上下文 ~22k+ chars，触发 1+ 次 rollover）
 *
 *  内容覆盖计划 §一 CX 八类：决策演化 / 强约束 / 未完成义务 / 代码状态 /
 *  Tool Chain / 长日志噪音 / 中英混合 / 多 Agent 交接。
 *
 *  prompt 内置"每步 JSON 进度 + 最终 JSON 探针报告"，压缩发生后由最终报告
 *  测信息保留（旧决策复活 / 义务丢失 / 违禁 / 关键事实）。
 */

export interface ContextManifest {
  /** 探针 currentDecision 必须是其中之一（出现其他已废弃决策 = 旧决策复活） */
  currentDecisions: string[]
  /** 探针 forbiddenActions 不得包含（出现 = 违禁） */
  negativeConstraints: string[]
  /** 探针 openObligations 必须全部包含（缺失 = 义务丢失） */
  openObligations: string[]
  /** 探针 completedActions 必须全部包含（缺失 = 关键事实丢失）。
   *  别名组：每组内任一命中即该事实保留（中英同义词、大小写变体等）——
   *  模型用 quickSort 表达"快速排序"不是事实丢失。 */
  completedActions: string[][]
  /** 探针 relevantFiles 必须至少包含其中之一（文件定位丢失） */
  relevantFiles: string[]
}

export interface ContextCase {
  caseId: string
  group: "compress" | "rollover"
  category: string
  /** 轮数上限（防失控成本）；到上限则事件流仍记录已触发档位 */
  maxRounds: number
  prompt: string
  initialWorkspace: Record<string, string>
  manifest: ContextManifest
}

// ── compress 组：短任务 ~10 步 ──

const C1 = {
  caseId: "CTX-C1",
  group: "compress" as const,
  category: "决策演化",
  maxRounds: 40,
  prompt: `在项目 src/ 下执行以下步骤。每完成一步，输出一行 JSON 进度报告 {"step": <N>, "done": "<简述>"}。

1. 创建 src/sort.ts，实现 bubbleSort（冒泡排序，方案 A）
2. 创建 src/main.ts 调用 bubbleSort 并对 [3,1,2] 排序打印
3. 废弃方案 A：把 src/sort.ts 改为 quickSort（快速排序，方案 B）实现，删除 bubbleSort
4. 同步更新 src/main.ts 调用 quickSort；读取 main.ts 复核调用正确
5. 补一个注释说明选择方案 B 的原因
6. **强制收尾（任务成功判定依赖此步）**：最后一步必须是输出最终 JSON 报告——严格 JSON，单行输出，不加任何其他文字、解释或标记。未输出报告 = 任务失败。报告格式：
{"currentDecision": "<当前使用的排序方案>", "forbiddenActions": [], "openObligations": [], "completedActions": ["<已完成的>"], "relevantFiles": ["<相关文件>"]}`,
  initialWorkspace: {
    "tsconfig.json": `{ "compilerOptions": { "strict": true, "noEmit": true, "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler", "allowImportingTsExtensions": true }, "include": ["src"] }`,
  },
  manifest: {
    currentDecisions: ["quickSort", "快速排序", "方案 B", "方案B"],
    negativeConstraints: [],
    openObligations: [],
    completedActions: [["bubbleSort", "冒泡排序"], ["quickSort", "快速排序"]],
    relevantFiles: ["sort.ts", "main.ts"],
  },
}

const C2 = {
  caseId: "CTX-C2",
  group: "compress" as const,
  category: "强约束",
  maxRounds: 40,
  prompt: `在项目 docs/ 下执行以下步骤。每完成一步，输出一行 JSON 进度报告 {"step": <N>, "done": "<简述>"}。

硬性约束：不得修改或删除 src/lib.ts（它是公共 API），只能读取。

1. 读取 src/lib.ts 了解公开函数清单
2. 创建 docs/guide.md，按 lib.ts 的公开函数写使用说明
3. 创建 docs/CHANGELOG.md，写 v0.2 变更记录
4. 在 docs/guide.md 补充一个示例代码块
5. 在 docs/CHANGELOG.md 标注日期

6. **强制收尾（任务成功判定依赖此步）**：最后一步必须是输出最终 JSON 报告——严格 JSON，单行输出，不加任何其他文字、解释或标记。未输出报告 = 任务失败。报告格式：
{"currentDecision": "<说明当前状态>", "forbiddenActions": ["<你明确拒绝/没有做的>"], "openObligations": [], "completedActions": ["<已完成的>"], "relevantFiles": ["<相关文件>"]}`,
  initialWorkspace: {
    "src/lib.ts": `// 公共 API — 勿改
export function formatName(name: string): string { return name.trim() }
export function greeting(name: string): string { return "Hello, " + formatName(name) }
`,
  },
  manifest: {
    currentDecisions: [],
    negativeConstraints: ["lib.ts"],
    openObligations: [],
    completedActions: [["guide.md"], ["CHANGELOG.md"]],
    relevantFiles: ["guide.md", "CHANGELOG.md"],
  },
}

const C3 = {
  caseId: "CTX-C3",
  group: "compress" as const,
  category: "未完成义务",
  maxRounds: 40,
  prompt: `三个任务，前两个立即完成，第三个留到报告之后再继续。每完成一步，输出一行 JSON 进度报告 {"step": <N>, "done": "<简述>"}。

1. 任务一：创建 src/config.ts，导出 DEFAULT_PORT = 8080
2. 任务一完成：给 src/config.ts 加类型注解
3. 任务二：创建 src/logger.ts，实现 log(msg: string) 打印带时间戳
4. 任务二完成：给 src/logger.ts 加 level 参数（默认 "info"）
5. 现在输出中间 JSON 报告（严格 JSON，不要其他文字）：
{"currentDecision": "<当前进度>", "forbiddenActions": [], "openObligations": ["<尚未完成的任务>"], "completedActions": ["<已完成的>"], "relevantFiles": ["<相关文件>"]}
6. 报告之后继续任务三：创建 src/metrics.ts 记录一个 counter 计数器
7. 任务三完成：给 src/metrics.ts 加 inc() 与 get() 两个方法

8. **强制收尾（任务成功判定依赖此步）**：最后一步必须是输出最终 JSON 报告——严格 JSON，单行输出，不加任何其他文字、解释或标记。未输出报告 = 任务失败。报告格式：
{"currentDecision": "<当前进度>", "forbiddenActions": [], "openObligations": ["<尚未完成的任务>"], "completedActions": ["<已完成的>"], "relevantFiles": ["<相关文件>"]}`,
  initialWorkspace: {},
  manifest: {
    currentDecisions: [],
    negativeConstraints: [],
    openObligations: [], // 任务三在第 6 步完成 → 最终报告时无未完成义务
    completedActions: [["config.ts"], ["logger.ts"], ["metrics.ts"]],
    relevantFiles: ["config.ts", "logger.ts", "metrics.ts"],
  },
}

const C4 = {
  caseId: "CTX-C4",
  group: "compress" as const,
  category: "长日志噪音",
  maxRounds: 40,
  prompt: `logs/app.log 里有大量运行日志，其中混着一个真实错误。每完成一步，输出一行 JSON 进度报告 {"step": <N>, "done": "<简述>"}。

1. 读取 logs/app.log
2. 找出真正的错误行（其余都是噪音/警告）
3. 创建 src/fix.txt 记录：错误现象 + 对应修复建议（一句话）
4. 创建 docs/incident.md 转写完整错误行内容
5. 检查 src/fix.txt 与 docs/incident.md 内容一致（错误行原文一致）

6. **强制收尾（任务成功判定依赖此步）**：最后一步必须是输出最终 JSON 报告——严格 JSON，单行输出，不加任何其他文字、解释或标记。未输出报告 = 任务失败。报告格式：
{"currentDecision": "<错误根因>", "forbiddenActions": [], "openObligations": [], "completedActions": ["<已完成的>"], "relevantFiles": ["<相关文件>"]}`,
  initialWorkspace: {
    "logs/app.log": `[12:00:01] INFO  request GET /health 200 12ms
[12:00:02] INFO  request GET /api/users 200 34ms
[12:00:02] DEBUG cache hit users:list
[12:00:03] WARN  slow query 1200ms on orders:list
[12:00:03] INFO  request GET /api/orders 200 1201ms
[12:00:04] INFO  request GET /static/app.js 304 2ms
[12:00:05] DEBUG cache miss orders:list → refetch
[12:00:05] ERROR TypeError: Cannot read properties of undefined (reading 'total') at OrderSummary.render (/app/orders.js:42)
[12:00:05] INFO  request POST /api/orders 500 8ms
[12:00:06] WARN  retrying failed request orders:create attempt 1
[12:00:06] INFO  request POST /api/orders 500 9ms
[12:00:07] WARN  retrying failed request orders:create attempt 2
[12:00:07] INFO  request GET /health 200 11ms
[12:00:08] INFO  request GET /api/orders 200 300ms
[12:00:09] DEBUG cache hit orders:list
[12:00:10] WARN  memory usage 78% (growing)
[12:00:11] INFO  request GET /static/app.css 200 1ms
[12:00:12] INFO  request GET /api/orders 200 250ms
[12:00:13] DEBUG serializing order payload
[12:00:14] WARN  slow query 900ms on users:search
[12:00:15] ERROR TypeError: Cannot read properties of undefined (reading 'total') at OrderSummary.render (/app/orders.js:42)
[12:00:15] INFO  request GET /api/orders 200 210ms
[12:00:16] INFO  request POST /api/orders 500 7ms
[12:00:17] WARN  disk usage 82%
[12:00:18] INFO  request GET /health 200 10ms
[12:00:19] INFO  request GET /api/users 200 29ms
[12:00:20] DEBUG cache hit users:list`,
  },
  manifest: {
    currentDecisions: [],
    negativeConstraints: [],
    openObligations: [],
    completedActions: [["orders.js:42"], ["OrderSummary.render"], ["Cannot read properties of undefined"]],
    relevantFiles: ["app.log", "fix.txt", "incident.md"],
  },
}

// ── rollover 组：长任务 ~25 步 ──

const C5 = {
  caseId: "CTX-C5",
  group: "rollover" as const,
  category: "代码状态",
  maxRounds: 60,
  prompt: `把项目从 v1 迁移到 v2（文件结构变化）。每完成一步，输出一行 JSON 进度报告 {"step": <N>, "done": "<简述>"}。

1. 读取 src/v1/ 下所有文件，了解现状
2. 创建 src/v2/ 目录结构（lib/ + app/）
3. 把 src/v1/legacy.ts 的核心函数迁移到 src/v2/lib/core.ts（保留原逻辑）
4. 把 src/v1/utils.ts 合并进 src/v2/lib/core.ts
5. 创建 src/v2/app/index.ts 作为新入口
6. 删除 src/v1/ 下已被迁移的文件
7. 更新 package.json 的 main 指向 src/v2/app/index.ts
8. 在 src/v2/lib/core.ts 顶部加迁移说明注释（标注来源文件）

9. **强制收尾（任务成功判定依赖此步）**：最后一步必须是输出最终 JSON 报告——严格 JSON，单行输出，不加任何其他文字、解释或标记。未输出报告 = 任务失败。报告格式：
{"currentDecision": "<当前版本结构>", "forbiddenActions": [], "openObligations": [], "completedActions": ["<已完成的>"], "relevantFiles": ["<当前相关文件>"]}`,
  initialWorkspace: {
    "tsconfig.json": `{ "compilerOptions": { "strict": true, "noEmit": true, "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler", "allowImportingTsExtensions": true }, "include": ["src"] }`,
    "package.json": `{ "name": "demo", "version": "0.1.0", "main": "src/v1/legacy.ts" }`,
    "src/v1/legacy.ts": `export function computeTotal(items: number[]): number {
  return items.reduce((a, b) => a + b, 0)
}
export function toUpper(s: string): string { return s.toUpperCase() }
`,
    "src/v1/utils.ts": `export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi)
}
export const VERSION = "v1"
`,
  },
  manifest: {
    currentDecisions: ["v2"],
    negativeConstraints: [],
    openObligations: [],
    completedActions: [["core.ts", "v2/lib/core.ts"]],
    relevantFiles: ["v2/lib/core.ts", "v2/app/index.ts"],
  },
}

const C6 = {
  caseId: "CTX-C6",
  group: "rollover" as const,
  category: "Tool Chain",
  maxRounds: 60,
  prompt: `串联重构一条依赖链：A → B → C，逐文件修改并保持依赖正确。每完成一步，输出一行 JSON 进度报告 {"step": <N>, "done": "<简述>"}。

1. 读取 src/a.ts 了解 formatUser 函数签名
2. 修改 src/a.ts：formatUser 增加 optional 参数（默认空对象）
3. 读取 src/b.ts 确认它调用 formatUser 的方式
4. 修改 src/b.ts：适配 formatUser 新签名，保留导出
5. 读取 src/c.ts 确认它调用 src/b.ts 的方式
6. 修改 src/c.ts：适配 b.ts 的变化
7. 依次读取 a.ts/b.ts/c.ts 复核依赖引用一致
8. 在 src/b.ts 顶部加注释说明依赖关系

9. **强制收尾（任务成功判定依赖此步）**：最后一步必须是输出最终 JSON 报告——严格 JSON，单行输出，不加任何其他文字、解释或标记。未输出报告 = 任务失败。报告格式：
{"currentDecision": "<当前状态>", "forbiddenActions": [], "openObligations": [], "completedActions": ["<已完成的>"], "relevantFiles": ["<相关文件>"]}`,
  initialWorkspace: {
    "tsconfig.json": `{ "compilerOptions": { "strict": true, "noEmit": true, "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler", "allowImportingTsExtensions": true }, "include": ["src"] }`,
    "src/a.ts": `export interface UserOpts { role?: string }
export function formatUser(name: string, opts: UserOpts): string {
  return name + (opts.role ? " (" + opts.role + ")" : "")
}
`,
    "src/b.ts": `import { formatUser } from "./a"
export function renderUser(name: string): string {
  return formatUser(name, {})
}
`,
    "src/c.ts": `import { renderUser } from "./b"
export const line = renderUser("alice")
`,
  },
  manifest: {
    currentDecisions: [],
    negativeConstraints: [],
    openObligations: [],
    completedActions: [["a.ts"], ["b.ts"], ["c.ts"], ["formatUser"]],
    relevantFiles: ["a.ts", "b.ts", "c.ts"],
  },
}

const C7 = {
  caseId: "CTX-C7",
  group: "rollover" as const,
  category: "中英混合",
  maxRounds: 60,
  prompt: `处理一个中英混合的配置化项目。每完成一步，输出一行 JSON 进度报告 {"step": <N>, "done": "<简述>"}。

1. 读取 config/settings.json（配置键为英文，值为中文注释文档）
2. 读取 src/processor.ts（英文代码注释）
3. 按 settings.json 的 theme 配置修改 src/processor.ts 中的 THEME 常量
4. 按 settings.json 的 locale 配置创建 src/locale.ts（中文文案映射）
5. 在 docs/说明.md 记录本次变更（中文）
6. 读取 src/processor.ts 复核 THEME 改动
7. 检查 settings.json 与 processor.ts 的 theme 值一致

8. **强制收尾（任务成功判定依赖此步）**：最后一步必须是输出最终 JSON 报告——严格 JSON，单行输出，不加任何其他文字、解释或标记。未输出报告 = 任务失败。报告格式：
{"currentDecision": "<当前配置>", "forbiddenActions": [], "openObligations": [], "completedActions": ["<已完成的>"], "relevantFiles": ["<相关文件>"]}`,
  initialWorkspace: {
    "tsconfig.json": `{ "compilerOptions": { "strict": true, "noEmit": true, "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler", "allowImportingTsExtensions": true }, "include": ["src"] }`,
    "config/settings.json": `{
  "theme": "dark",
  "locale": "zh-CN",
  "features": ["auth", "export"],
  "说明": "此文件为运行配置，修改后请同步 processor.ts"
}`,
    "src/processor.ts": `// English comment: theme constant referenced by renderer
export const THEME = "light"
export function process(input: string): string { return input.trim() }
`,
  },
  manifest: {
    currentDecisions: ["dark"],
    negativeConstraints: [],
    openObligations: [],
    completedActions: [["dark"], ["locale.ts"]],
    relevantFiles: ["settings.json", "processor.ts", "locale.ts"],
  },
}

const C8 = {
  caseId: "CTX-C8",
  group: "rollover" as const,
  category: "多 Agent 交接",
  maxRounds: 60,
  prompt: `按三阶段推进：规划 → 实现 → 审查修复，阶段状态跨阶段保留。每完成一步，输出一行 JSON 进度报告 {"step": <N>, "done": "<简述>"}。

【规划阶段】
1. 创建 docs/PLAN.md 写入：目标 = 一个 greet 模块（输入姓名输出问候），方案 = 单文件 + 默认参数，风险 = 空输入
2. 在 PLAN.md 列出 3 个实现步骤

【实现阶段】
3. 按 PLAN.md 方案创建 src/greet.ts（greet(name: string = "world")）
4. 创建 src/greet.test.ts 验证 greet("alice") 与 greet()
5. 读取 greet.ts 与 greet.test.ts 复核一致性

【审查阶段】
6. 读取 src/greet.ts 审查：找出 1 个改进点
7. 按审查结论修复 src/greet.ts
8. 再次读取复核修复正确
9. 更新 docs/PLAN.md 标记全部完成
10. **强制收尾（任务成功判定依赖此步）**：最后一步必须是输出最终 JSON 报告——严格 JSON，单行输出，不加任何其他文字、解释或标记。未输出报告 = 任务失败。报告格式：
{"currentDecision": "<当前阶段与方案>", "forbiddenActions": [], "openObligations": [], "completedActions": ["<已完成的>"], "relevantFiles": ["<相关文件>"]}`,
  initialWorkspace: {
    "tsconfig.json": `{ "compilerOptions": { "strict": true, "noEmit": true, "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler", "allowImportingTsExtensions": true }, "include": ["src"] }`,
  },
  manifest: {
    currentDecisions: ["greet", "greet 模块", "单文件"],
    negativeConstraints: [],
    openObligations: [],
    completedActions: [["greet.ts"], ["greet.test.ts"], ["PLAN.md"]],
    relevantFiles: ["greet.ts", "PLAN.md", "greet.test.ts"],
  },
}

export const CONTEXT_CASES: ContextCase[] = [C1, C2, C3, C4, C5, C6, C7, C8]
