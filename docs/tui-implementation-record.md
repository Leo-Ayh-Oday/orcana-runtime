# Orcana TUI 实施与修复记录

> 范围：Depthline 重构（2026-08）全部 TUI 改动、Bug 修复与踩坑教训。
> 对应方案：`docs/tui-depthline-plan.md`；提交线：`b944862` … `63d2d8f`。

## 一、背景

TUI 原始形态「多面板（RightRail/StatusBar/ThinkingDock）+ 多动画 + 全局共享时钟」，问题：不好看 + 会卡。
依据 Grok Build 分析 → **Depthline 方案 v2**：单画布、7-token 色、单动画（唯一 pulse）、ActionRegistry 单一键位源。

## 二、阶段实施记录

| 阶段 | commit | 内容 |
|---|---|---|
| 计划 | `b944862` | docs: tui depthline redesign plan v2 |
| P1 性能底座 | `6e66679` | 删全局 ClockContext → `motion.ts` 静态配置；Scrollback 去 tick（`applyPendingAnimation`/tail dots 删除）；`render-metrics.ts`（`ORCANA_TUI_PROFILE=1`）；`overlays.ts` 互斥 Overlay union；`useOverlayController.ts` 抽离 main.tsx 300 行对话框按键；`state/use-tui-selector.ts`（snapshot 缓存 + shallowEqual）；AppShell 只接 presentation props。TUI 测试 722 pass |
| P2 单画布骨架 | `824187b` | `SessionLine`（错误优先字段链+四档降级）、`ActivityLine`（唯一 pulse，160ms 局部 tick，stalled 静态标签）、`InteractionSlot`（Clarification/Question 互斥）、`LegacyPlanAdapter`、`HintBar`（≤3 动作）、`overlays/RuntimeInspector`（RightRail 能力迁移，Ctrl+T 或 /runtime）、`presentation/actions.ts` seam、`ComposerFrame` 双线改单线、Esc=run.stop 接通 harness cancel。测试 750 pass |
| P3 Action Registry | `d9bc2ba` | `actions.ts` 全量注册表（matchable/disabled 语义）、`presentation/dispatcher.ts`（定义/执行分离，pageScrollAmount=bodyHeight-4）、`presentation/hints.ts`（HintBar 与 Ctrl+? 统一派生）、`overlays/ShortcutsPanel`（Ctrl+?）、`input/keymap.ts` 变薄、Command→Action 映射（/runtime→runtime.open）。测试 787 pass |
| P4 Block 模型 | `def4600` | `block-model.ts` / `block-view-state.ts`（reducer + prune）/ `derive-blocks.ts`（结构化输入禁文本解析、ToolGroup 归组、ExecutionSummaryBlock 来自 state 数组）/ `TranscriptViewport.tsx`（BlockLineCache、▸/▾ 折叠标记）/ tokens 加 collapse 色。测试 817 pass |
| P5 视觉收敛 | `3b91f6d` | 7-token 调色板收敛（领域色全部归 dim + 兼容别名）、FlowLine 删除、splash 去装饰依赖（figlet/ink-big-text/ink-gradient/boxen 移除）、`presentation/golden.ts` + 44 张快照。测试 819 pass |
| P6 死代码清理 | `fbbd739` `de7ed29` | 删 HeaderBar/StatusBar/FooterHints/ModeContract/RightRail/RuntimePanel/StreamingBlock/ThinkingDock/SonarPulse + 旧视图 app/dashboard/conversation + 6 个旧测试 + 2 个 hooks；−2831 行。测试 698 pass |
| 审计修复 | `23c26c6` | 见 Bug 清单 #1 #2 #3 |
| P7 视觉优化 | `a51bbf1` | 容器语言（╭╮ 半框、品牌面板）、双行 SessionLine（符号状态 + ctx 块条）、HintBar 胶囊、splash 提示同步；44 张 golden 重写。测试 701 pass |
| 模型切换 | `0288707` | `/model <id>` 直接切换 + provider 过滤兜底 |
| 面板接线 | `20076bf` | 见 Bug 清单 #5 |
| 退出保护 | `63d2d8f` | 见 Bug 清单 #6 |

## 三、Bug 修复清单

1. **[失效] 5 个斜杠命令静默泄漏给 agent**（`23c26c6`）
   `/save /compact /sessions /search /undo` 在 registry 有定义但 dispatcher 无 handler → `pass_to_agent` 当普通 prompt 发给 LLM（历史遗留）。修复：`enabled:false` + disabledReason（shelf 显示 dim+原因、Tab 拒绝补全），dispatcher 兜底提示，绝不静默发 agent。

2. **[陷阱] 裸 `/` 回车误触发第一个命令**（`23c26c6`）
   输入 `/` 直接回车被补全成 `/ripple`。修复：`bareSlash` 守卫。

3. **[UX] `/model <参数>` 不让换模型**（`0288707`）
   用户报「余额不足 → 用 model 换一个 → 不让人换」。根因：参数被当 provider 过滤，模型名查询得空列表。修复：精确 modelId→直接切换 / 精确 provider→过滤对话框 / 唯一前缀→直接切换 / 无匹配→提示可用 provider。

4. **[回归] `/models` `/effort` 面板完全不弹**（`20076bf`）
   用户报「直接输入 /model 不弹配置面板」。根因：P1 抽离 `useOverlayController` 时 `openModelPicker`/`openEffort` 返回但**未接到 `controlsRef`**，dispatcher 调的是初始化空函数（"handled" 但 no-op）。修复：接线两行。

5. **[误杀] Ctrl+C 直接退出丢会话**（`63d2d8f`）
   运行任务时 Ctrl+C 直退。修复：`render(..., { exitOnCtrlC: false })` + useInput 接管——working 第一下=停止任务+提示，3s 内第二下才退出；idle/splash 直接退出；`/exit` 同步双确认。

6. **[误导] splash 提示不可用命令**（`a51bbf1`）
   splash 显示 `/sessions /compact` 但已禁用。修复：改为 /runtime /gates /stats。

7. **[连带] P6 漏提交**（`de7ed29`）
   `thinking/index.ts` 与 `thinking-dock.test.ts` 的修改未进 `fbbd739`（当时只 add 了删除文件 + docs），工作区悬挂 2 个文件直到审计时发现补交。教训见下文。

## 四、犯过的错误与教训

1. **部分提交（漏 add）**：P6 用「只 add 自己改的文件」策略时只 add 了删除项和文档，漏掉同批修改的 2 个文件 → 提交后工作区还有悬挂改动。教训：commit 前 `git status` 全量核对，自己改的文件一个都不能少；删除文件与修改文件分开审查。

2. **引入无感知回归（P1）**：抽离 controller 时类型层面一切正常（空函数也是合法值），`/models` 静默 no-op 达多轮无人发现——因为 dispatcher 测试用 spy 注入、golden 无交互场景。教训：**拆组件时必须有「接线级」冒烟验证**（真实 render + 按键），纯单测覆盖不到 ref 接线；这次是用户手动发现。

3. **参数语义拍脑袋**：`/model <arg>` 想当然把 arg 当 provider。教训：命令参数的用户预期是「模型 ID 优先」，实现前先定义解析优先级（精确→provider→前缀→提示）。

4. **匹配顺序 bug**：`resolveModelArg` 前缀匹配先于 provider 匹配，`/model anthropic` 被 `anthropic/claude-sonnet`.includes() 误判为模型切换——测试当场抓住。教训：前缀包含匹配必须先排除精确 provider 命中。

5. **Ctrl+C 两个隐性坑**：① ink `exitOnCtrlC` 默认 true 时 useInput **收不到** ctrl+c（必须先 render option 关闭）；② splash 期间 `isActive: !showStartup` 使 handler 未挂载，关闭 exitOnCtrlC 后 Ctrl+C 挂起（脚本实测 exit=124 暴露）。教训：改全局输入行为要用伪 TTY 实测（`script -qec` + `printf '\x03'`），不能只看类型和单测。

6. **断言惯性**：视觉改动连带旧断言失效（makeDivider 全角线、bodyHeight+3 常量、golden 44 张）——预期内，但需一次性同步重写而非逐个 patch。

7. **把「历史遗留」当「正常」**：首次审计把 5 个失效命令判定为「历史遗留非回归」而差点只记录不修——用户视角它就是坏的。教训：对用户可感知的失效，历史遗留不等于可接受。

## 五、遗留缺口（跨会话，已记录不动）

| 缺口 | 状态 |
|---|---|
| 权限确认断链 | harness confirm 事件被 `event-adapter.ts:104-106` 显式丢弃，ConfirmModal 的 y/n/a/Esc 是死注册。等 harness 权限流接入后补 overlay set 点 + 回执 |
| Rewind 无入口 | rewind stub，`kind:"rewind"` 无打开点；/undo 已禁用并标注 |
| sessions/save/compact/search 面板 | 未接入，已禁用 + 明确提示 |

## 六、门禁基线

- `bun run typecheck` / `bun test tests/tui/` / `bun run build` / `git diff --check`
- 当前基线：**705 pass**（含 44 张 golden 快照矩阵，`ORCANA_GOLDEN_WRITE=1` 可重写）
- 性能契约：idle 零 timer（`ORCANA_TUI_PROFILE=1` 验证 activeTimers=0）；唯一 tick 为 ActivityLine 局部 pulse（160ms）
