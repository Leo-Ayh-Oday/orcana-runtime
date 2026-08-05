# Orcana TUI Depthline 重构方案（v2）

> 状态：方案冻结，待实施（IMPLEMENTATION_READY）
> 基线：`bun run typecheck` 0 errors + `bun test tests/tui` 全绿（426+）
> 约束：Ink + React 可行 · ASCII fallback 全覆盖 · 不复制 Grok Build / Claude Code 源码
> 方向来源：Grok Build TUI 主链路分析（scrollback 主画布 / 结构化块 / 单职责输入 / Action Registry）+ 一轮评审修正（6 项）

---

## 1. 目标

对 Orcana TUI 执行一次明确的减法重构，代号 **Depthline**：

- 默认单画布：无永久 RightRail / StatusBar / ThinkingDock / PlanPanel
- Transcript 是唯一主画布，结构化为可折叠 Block，用「执行深度线」glyph 表达 Agent 生命周期
- 色彩预算收敛到 7 个 token；屏幕上最多 1 个动画 glyph
- 性能由机制保证：无全局时钟、订阅切片化、idle 零 timer
- 现有 store / event-adapter / scrollback 缓存 / paste / 历史 / reduced-motion 不回退

**同时解决两个现状问题：**
1. 不好看：同一运行事实在 Header / StatusBar / RightRail / ThinkingDock 重复展示，多色多动画造成注意力竞争
2. 会卡：96ms 全局 tick 驱动全树重渲染；流式 40ms flush 命中整棵 AppShell 子树

---

## 2. 现状诊断（代码证据）

### 性能
| 问题 | 证据 |
|---|---|
| 全局时钟全树重渲染 | `main.tsx:604-610` 96ms interval → ClockContext → 11 个 useClock 消费者每帧全量重渲染，agent 纯等待无输出时也空转 ~10fps |
| 流式 flush 命中全树 | `main.tsx:231-235` 顶层 useSyncExternalStore → 每次 assistant.delta 整棵 AppShell 子树 re-render |
| 双时钟叠加 | SonarPulse 140ms 本地 tick + 96ms 全局 tick（stalled 渐变） |
| 布局双重事实源 | `main.tsx:567-576` 与 `AppShell.tsx:388-413` 各算一遍 |
| modal 输入内联 | `main.tsx:629-918` 约 300 行 runtime dialog 按键处理写在组件里 |

### 视觉
| 问题 | 证据 |
|---|---|
| 同事实 4 处重复 | round/context/tools 同时出现在 HeaderBar + StatusBar + RightRail + ThinkingDock |
| 颜色承担分类职责 | theme.ts 中 gate 粉 / evidence 紫 / patch 薄荷 / task 青 / plan 蓝 + SonarPulse 9 种 phase 色 |
| 多动画同时发生 | HeaderBar pulse + FlowLine + ripple 相位 + SonarPulse + tail dots |
| 永久右栏 | RightRail 含 ModeContract + Runtime + Ripple + Gates + Evidence + Patch + Tools + Context |
| 键位双事实源 | keymap.ts + FooterHints + composer 内部 + main.tsx modal 分支 |

---

## 3. 设计原则

1. **单画布**：默认无永久右栏，RightRail 能力进 RuntimeInspector overlay
2. **渐进披露**：默认只显示「用户说了什么 / Agent 给出什么 / 正在做什么 / 需要用户做什么」，运行时细节展开可见
3. **稳定几何**：执行开始、工具调用、计划出现不造成界面跳动
4. **单一视觉焦点**：屏幕最多一个动画 glyph（ActivityLine pulse）
5. **结构 > 装饰**：识别度来自 Depthline 执行链（工具嵌套 / 证据链 / Gate 结果），不是深海渐变与多色 glyph

---

## 4. 目标形态

### 空闲态
```text
orcana  ~/orcana-runtime  main                 gpt-5.6 · ask · ctx 18%   ← SessionLine（1 行）
› 帮我检查 Tool Runtime 的重试设计
│ 当前重试策略把可重试错误与权限拒绝混在了一起。
└ ✓ analysis complete · 3 files inspected · 12.4s
── 单条细线 ──
❯ Message Orcana…
Enter send      / commands      ? shortcuts                                ← HintBar（≤3 动作）
```

### 运行态
```text
orcana  ~/orcana-runtime  main              ◉ running  gpt-5.6 · auto · 18% · q2
› 实现新的 retry policy
│ 我先检查当前错误契约和工具执行路径。
◉ inspecting tool runtime                                                  ← ActivityLine（0/1 行，唯一动画）
├ read      src/runtime/tool-result.ts
└ search    RETRYABLE_ERROR_CODES
── 单条细线 ──
❯ Queue the next instruction…
Enter queue      Esc stop      Ctrl+T activity
```

### 工具完成后（默认折叠，展开看细节）
```text
▸ 4 tool calls · 3 files changed · 18 tests passed
└ ✓ gate passed · evidence sufficient
```
展开后：
```text
▾ 4 tool calls · 3 files changed · 18 tests passed
├ read    src/runtime/tool-result.ts
├ edit    src/runtime/retry-policy.ts          +84 -21
└ test    tests/tool-retry.test.ts             18 passed
```

### Depthline glyph 集
```text
› 用户      │ Agent 正文   ◉ 当前活动   ├ 中间执行步骤   └ 最终执行步骤
▸ 折叠块    ▾ 展开块      ✓ 成功       ! 警告           × 失败
```

---

## 5. 信息架构

### 永久区域（transcript 外 chrome ≤ 4 行）
```text
SessionLine        1 行（唯一顶部状态行）
Transcript         弹性高度
ActivityLine       0 或 1 行（仅运行态，唯一动画）
InteractionSlot    0 或若干行，同时只能有一个
Composer           2–8 行（顶部单条细线）
HintBar            1 行（≤3 动作）
```

### 组件归属迁移
| 当前组件 | 新归属 |
|---|---|
| HeaderBar + StatusBar | SessionLine |
| ThinkingDock | ActivityLine |
| RightRail + RuntimePanel + ModeContract | RuntimeInspector overlay（Ctrl+T / /runtime） |
| PlanProgress（非交互） | PlanBlock（transcript） |
| PlanApproval（需决策） | InteractionSlot |
| ClarificationPanel / QuestionPanel | InteractionSlot |
| ConfirmModal / Permission | InteractionSlot 或 Overlay |
| Gate / Evidence / Patch | ExecutionSummaryBlock |
| Tool history | ToolGroupBlock |
| Context meter | SessionLine 或 Inspector |

### SessionLine 字段优先级链（不可丢失顺序）
```
blocked/error > running/idle > queue > mode > model > ctx > provider > branch/path
```
- provider/model 组合为一个字段（如 `anthropic/claude-sonnet`）
- 逐级降级表：
  - ≥120: branch · state · mode · provider/model · ctx · queue
  - 80–119: state · mode · model · ctx · queue
  - 60–79: state · mode · short-model · queue
  - <60: state · mode · queue
- 错误/阻断状态永不被裁剪

---

## 6. 性能契约（机制保证，不靠优化）

1. **删除高层 ClockContext 与 ChatApp 全局 tick**（`clock.ts` 删除）
2. **Scrollback 不拥有任何 tick**：只响应 messages / width / height / scrollOffset / displayMode 变化；流式由 store delta 推动，删除 streaming tail dots（静态化）
3. **仅 ActivityLine 使用按需局部 tick**：idle 时局部 timer 不创建
4. **订阅切片化**：`useTuiSelector(store, selector, isEqual = Object.is)`——内部缓存最近 snapshot，字段未变不产生新引用；支持显式 shallowEqual；卸载自动 unsubscribe。组件选择原子值（`s => s.messages`、`s => s.status`），不组合大对象
5. **reduced-motion 保留**：迁为 `motion.ts` 静态配置模块（无 React 状态）
6. 保留：FormattedLineCache、dispatchMany 批处理、viewport 裁剪、trimForViewport

### 渲染需求分级
| 需求 | 节奏 | 触发 |
|---|---|---|
| none | 无 timer | idle |
| slow | 160ms 局部 tick | ActivityLine 状态脉冲 |
| fast | 40ms（store 驱动） | 流式，仅 Scrollback 切片 |

---

## 7. 结构化 Transcript Block

### Block 模型（P4 实现，不改 Runtime 事件协议）
```ts
interface TranscriptBlockBase {
  id: string          // 稳定 ID：不用数组下标，流式增长/resize 不改变
  turnId?: string
  runId?: string
  toolCallId?: string
  kind: BlockKind     // user | assistant | tool-group | plan | execution-summary | gate | permission | system
  lifecycle: "pending" | "running" | "done" | "error"
}

interface BlockPresentation extends TranscriptBlockBase {
  displayMode: "collapsed" | "truncated" | "expanded"
  selectable: boolean
  summary: RenderLine[]
  details?: RenderLine[]
}
```

### 派生函数（结构化输入，禁止文本解析）
```ts
export function deriveTranscriptBlocks(
  state: TuiState,
  viewState: TranscriptViewState,
): TranscriptBlock[]

interface TranscriptSource {
  messages: readonly TuiMessage[]
  tools: readonly TuiToolState[]
  task?: TaskProgressState
  runtime: RuntimeSummary
  round: number
}
```
禁止 `if (message.text.startsWith("gate:"))` 类自然语言解析。

### ToolGroup 归组条件
同 turnId/runId + 相邻执行区间 + 中间无 user/assistant/permission 边界。

### 视图状态（UI-only，独立 reducer）
```ts
interface TranscriptViewState {
  selectedBlockId: string | null
  displayModes: ReadonlyMap<string, BlockDisplayMode>
}

type TranscriptViewAction =
  | { type: "block.select"; blockId: string }
  | { type: "block.toggle"; blockId: string }
  | { type: "block.expand"; blockId: string }
  | { type: "block.collapse"; blockId: string }
  | { type: "block.prune"; liveIds: ReadonlySet<string> }
```
- 折叠状态不放进派生结果（否则流式 delta 到达后用户展开的块会恢复默认）
- 已删除块的 display state 由 prune 清理

### 默认显示模式
| 生命周期 | 默认模式 |
|---|---|
| running | truncated |
| completed | collapsed |
| failed / blocking | truncated（不整体折叠） |

---

## 8. Action Registry（P3 实现）

### 定义与执行分离
```ts
interface ActionDefinition {
  id: ActionId
  contexts: readonly InputContext[]
  shortcuts: readonly KeyBinding[]
  label: string
  description: string
  visibleWhen(state: ActionPresentationState): boolean
}

type ActionHandlerMap = Record<ActionId, (ctx: ActionExecutionContext) => void | Promise<void>>
```
- Action Registry = 纯元数据（HintBar / 快捷键面板 / keymap 解析全部由此派生）
- Action Dispatcher = 执行（持有 runtime / store / overlay controller / scroll controller）
- 测试只需构建元数据，不需要完整 Runtime

### 与 CommandRegistry 的关系
- Slash command（`/status`、`/models`）与 keyboard action 不强行合并；Command 可映射到 Action，但两者独立

### Footer 默认 ≤ 3 动作
```text
Enter send      / commands      ? shortcuts        ← idle
Enter queue     Esc stop        Ctrl+T activity    ← running
1 approve once  2 approve session  3 deny          ← permission
```

---

## 9. Overlay 与 InteractionSlot

### OverlayState（互斥 union，命名明确区分 settings 与 inspector）
```ts
type OverlayState =
  | { kind: "none" }
  | { kind: "confirm"; request: ConfirmRequest; position: string }
  | { kind: "rewind"; state: RewindModalState }
  | { kind: "settings"; dialog: ModelOrEffortDialog }  // model list / key / custom / url / effort 合并
  | { kind: "runtime-inspector" }
```

### InteractionSlot（与 overlay 分开）
- Clarification
- Question
- PlanApproval
- 同时只能存在一个

---

## 10. RuntimeInspector（RightRail 能力迁移，不丢失）

```text
╭─ runtime ───────────────────────────────╮
│ state       executing                   │
│ round       3                           │
│ context     18,420 / 128,000            │
│ cache       86%                         │
│                                         │
│ gates       4 passed · 1 warning        │
│ evidence    6 accepted · 1 missing      │
│ patches     2 committed                 │
│                                         │
│ recent tools                            │
│ ✓ read     src/runtime/tool.ts          │
│ ✓ edit     src/runtime/retry.ts         │
│ ◉ test     tests/tool-retry.test.ts     │
╰─────────────────────────────────────────╯
```
打开：`Ctrl+T` / `/runtime`。**覆盖层不压缩 transcript 布局**，关闭后归还全部空间。

---

## 11. 色彩预算（P5）

| Token | 用途 |
|---|---|
| text | 正文，尽量用终端默认前景色 |
| muted | 路径、耗时、统计、分隔 |
| faint | 次要/占位 |
| accent `#38BDF8` | Orcana、焦点、运行中（唯一动画色） |
| success `#34D399` | 已完成结果 |
| warning `#FBBF24` | 需要注意/等待决定 |
| danger `#FB7185` | 失败、拒绝、阻断 |

- 边框从 muted/faint 派生，不新增第八色
- 删除默认主界面的：gate pink、evidence purple、patch mint、planning purple、composing pink、reading blue、tooling green
- Gate/Evidence/Patch 靠标签、层级、glyph、展开内容区分

### 动画预算
- 唯一动画：ActivityLine pulse `◌◍◎◉◎◍`（固定 accent，160ms 帧）
- 删除：FlowLine、Header pulse、多相位 ripple 色、多色 shimmer、streaming tail dots、idle 动画
- stalled：静态标签 `stalled 8s`，不做渐变变色
- reduced-motion：pulse 显示静态 `●`

---

## 12. 推荐代码结构

```text
src/tui/
├─ app/
│  ├─ TuiRoot.tsx
│  ├─ useAgentSession.ts
│  ├─ useInputRouter.ts
│  └─ useOverlayController.ts
│
├─ presentation/
│  ├─ block-model.ts        (P4)
│  ├─ derive-blocks.ts      (P4)
│  ├─ block-view-state.ts   (P4)
│  ├─ layout.ts
│  ├─ actions.ts            (P3)
│  ├─ hints.ts              (P3)
│  └─ render-demand.ts
│
├─ components/
│  ├─ SessionLine.tsx
│  ├─ TranscriptViewport.tsx
│  ├─ TranscriptBlock.tsx   (P4)
│  ├─ ActivityLine.tsx
│  ├─ InteractionSlot.tsx
│  ├─ Composer.tsx
│  ├─ HintBar.tsx
│  └─ overlays/
│     ├─ RuntimeInspector.tsx
│     ├─ SettingsDialog.tsx  (model list / key / custom / url / effort)
│     ├─ PermissionPrompt.tsx
│     └─ RewindPicker.tsx
│
├─ state/
│  ├─ tui-store.ts          (保留)
│  ├─ event-reducer.ts      (保留)
│  ├─ event-adapter.ts      (保留)
│  └─ use-tui-selector.ts   (P1)
│
├─ theme/
│   ├─ tokens.ts
│   ├─ glyphs.ts
│   └─ theme.ts             (P5 收敛到 7 token)
│
└─ motion.ts                (P1: reduced-motion 静态配置)
```

---

## 13. 分阶段实施（每阶段独立 commit，门禁全绿）

### P1 — 性能与状态底座
**改动**
- 删除高层 ClockContext 与 ChatApp 全局 tick；Scrollback 完全去 tick（删 tail dots）
- reduced-motion 迁为 `motion.ts` 静态配置
- 新建 `useTuiSelector`（snapshot 缓存 + equality）
- 删除 ChatApp 重复布局计算；OverlayState 合并互斥 union；settings dialog controller 抽离 main.tsx
- AppShell 只接 presentation props

**P1 硬门禁（量化，ORCANA_TUI_PROFILE=1 instrumentation）**
- idle 2 秒：应用自建 repeating timer = 0
- 仅 activity tick：TranscriptViewport render count 不增加
- 追加 100 个 text delta：只重新格式化最后一个 assistant 块
- 修改 queueCount：Scrollback 不重渲染
- 打开 model overlay：Scrollback 不重新格式化
- dispatchMany(N events)：listener 只通知一次

**定向测试**：tui-store / app-shell / scrollback-animation（删 tail 后同步更新）/ 新增 use-tui-selector
**commit**：`feat: tui perf base — no global clock, slice subscriptions (TUI P1)`（不与 P2 合并，可单独回退）

### P2 — 单画布骨架
- SessionLine（字段优先级链，错误态永不被裁剪）；TranscriptViewport；ActivityLine；Composer（单细线）；HintBar
- InteractionSlot：Clarification + Question + PlanApproval；PlanProgress 走临时 LegacyPlanAdapter（不塞进 InteractionSlot）
- RuntimeInspector overlay（Ctrl+T / /runtime）；P2 建最小 ActionRegistry seam（仅 runtime.open + 现有兼容动作），P3 全量迁移
- 停默认渲染：RightRail / ModeContract / StatusBar
- **定向测试**：app-shell / component-render / runtime-inspector（新）/ interaction-slot（新）
- **commit**：`feat: tui depthline skeleton — single canvas layout (TUI P2)`

### P3 — Action Registry
- 纯元数据 registry + 独立 dispatcher；keymap / HintBar / `?` 面板统一派生；Footer ≤3 动作
- 注册 runtime.open、scroll、overlay、composer 等；预留 block select/toggle/expand actions
- CommandRegistry 与 keyboard action 独立，可映射
- **定向测试**：keymap / action-registry（新）/ command-dispatcher
- **commit**：`feat: tui action registry — single key/hint source (TUI P3)`

### P4 — Block Presentation Model
- `deriveTranscriptBlocks(state, viewState)` 结构化输入；稳定 block ID（turnId/runId/toolCallId）
- ToolGroup 按 turn/run 归组；PlanBlock；ExecutionSummaryBlock
- TranscriptViewState 独立 reducer + prune；默认模式 running=truncated / completed=collapsed / failed=truncated
- block 选中/折叠走 P3 动作
- **定向测试**：derive-blocks（新）/ block-view-state（新）/ tool-grouping（新）
- **commit**：`feat: tui block model — collapsible tool groups + execution summary (TUI P4)`

### P5 — 视觉收敛
- 7 token；边框从 muted/faint 派生；单一 accent pulse；删 FlowLine / Header pulse / phase 色 / 多色 shimmer；stalled 静态标签
- splash 简化；清理装饰依赖（figlet / ink-big-text / ink-gradient / boxen 确认无其他用途后卸载）
- Golden 矩阵：50×20 / 80×24 / 100×30 / 140×40 ×（idle / streaming / tool running / tool completed-collapsed / blocked gate / long CJK / permission / clarification / command shelf / runtime inspector）× ASCII / Unicode × reduced-motion / normal-static；无 ANSI 纯文本输出 + token 映射单独测试
- **门禁**：全量 + `pack:check` + `smoke:release`（因删除 npm 依赖）
- **commit**：`feat: tui visual convergence — 7-token palette + single animation (TUI P5)`

### 每阶段统一门禁
```bash
bun run typecheck
bun test tests/tui/
bun run build
git diff --check
```

---

## 14. 验收标准（硬性）

- 默认无永久 RightRail / 第二行状态栏；transcript 外永久 chrome ≤ 4 行
- 默认只有一个顶部状态行（SessionLine）
- Footer 最多 3 个动作；屏幕上最多 1 个动画 glyph
- 同一运行事实不能在两个默认区域重复
- 空闲态无定时重绘（idle 2s → activeTimers = 0）
- 60 列终端可完成所有核心操作；≥120 列靠左右留白，不增面板
- 工具执行默认折叠；权限/问题/澄清/计划批准共享 InteractionSlot
- 输入处理与 Footer hint 来自同一个 Action Registry
- 流式期间打开/关闭 RuntimeInspector：Inspector render +1、HintBar ≤ +1、TranscriptViewport render = 0、FormattedLineCache miss = 0、harness subscription 不变、scroll position 不重置
- 现有 store、event adapter、scrollback 历史、paste、reduced-motion、ASCII/Unicode 双 glyph 不回退

---

## 15. 风险清单

| 风险 | 缓解 |
|---|---|
| RightRail/StatusBar/ThinkingDock 相关测试需同步改写 | P2 统一处理 app-shell / component-render / right-rail-state / runtime-panel / thinking-dock 测试 |
| useTuiSelector 浅比较写错丢更新或无效化 | snapshot 缓存 + 显式 equality + 定向测试（unrelated 更新不通知 / 字段变化必通知 / 卸载 unsubscribe） |
| 删全局时钟后动画失去同步节奏 | 设计上只保留单一 ActivityLine 动画，不需要跨组件同步 |
| P2 视觉骨架出布局问题 | P1/P2 独立 commit，可回退 P2 保留 P1 性能收益 |
| Golden 测试被终端色彩能力影响 | 输出无 ANSI presentation 文本；颜色走独立 token 映射测试 |
| 删除装饰 npm 依赖破坏发布包 | P5 追加 pack:check + smoke:release |
| 与并行 Claude Code 会话冲突 | 每次 commit 只 add 本次变更文件，不 git add -A / 不 push / 不触碰他人未提交文件 |

---

## 16. 评审修正记录（v1 → v2）

1. ~~Scrollback 改本地 tick~~ → Scrollback 完全去 tick；仅 ActivityLine 持有按需局部 tick；reduced-motion 迁为静态配置模块
2. ~~P3 Block / P4 Registry~~ → P3 Action Registry 提前（P2 建立最小 seam），P4 Block Model
3. ~~deriveBlocks(TuiMessage[])~~ → `deriveTranscriptBlocks(state, viewState)` 结构化输入，禁止文本解析，带身份字段
4. ~~折叠状态放派生结果~~ → TranscriptViewState 独立 reducer + prune + 稳定 block ID + 生命周期默认模式
5. useTuiSelector 明确 snapshot 缓存与 equality 语义 + 定向测试
6. ~~confirm/rewind/model/runtime 命名~~ → confirm / rewind / settings（model+effort）/ runtime-inspector；InteractionSlot 与 overlay 分离
7. SessionLine 字段优先级：blocked/error > running/idle > queue > mode > model > ctx > provider > branch
8. PlanPanel 拆分：非交互 → PlanBlock；需决策 → InteractionSlot
9. Action Registry 定义与执行分离（Definition / HandlerMap）
10. P1 增加量化性能基线 + render 门禁（ORCANA_TUI_PROFILE=1）
11. Inspector 验收条款量化（TranscriptViewport render = 0）
12. Golden 增加状态矩阵 + ASCII/Unicode + reduced-motion 双轨
