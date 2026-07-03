# Orcana TUI 生产级改造方案

> 知识蒸馏自 Claude Code TUI 源码（`E:\备份\claudcodesrc-ponponon`），落地到 Orcana 自有的"深海/暗流/涟漪/证据链"语义体系。
>
> 基线：`bun run typecheck` 0 errors + `bun test tests/tui` 426 pass（2026-07-02 核实）
>
> 约束：Ink + React 可行 · ASCII fallback 全覆盖 · YAGNI · 不复制 Claude Code 源码

---

## 1. 总览（设计哲学）

Claude Code TUI 的核心设计哲学是"**克制的信息密度**"：单列布局拒绝 sidebar 的视觉负担，用 2 列 gutter + `marginTop=1` 的轻量分隔替代卡片边框；动画遵循"**共享时钟 + 视口暂停**"——所有动画从单一 ClockContext 派生，无订阅者时自动停止，避免多 setInterval 的 CPU 累积；流式输出"**不做打字机**"，而是用 stable-prefix 锁定算法让已确认的 markdown 块永不重解析，仅对正在生长的尾部块增量 lex；颜色系统"**品牌色恒定 + 语义色分层**"，主色在 dark/light 主题中保持一致仅调亮度，每个主色配对 shimmer 亮色用于扫光；拒绝/失败"**静默退场**"——工具拒绝无 shake/pulse，仅 subtle 灰色静态文本，唯一"卡住"信号是 stalled 渐变红（3s 阈值 + 2s 线性淡入）。

Orcana 改造的核心命题是：**在不放弃"深海/暗流/涟漪/证据链"语义的前提下，把这五条哲学落地为自有模式**。具体而言——把当前 9 色 palette 扩展为 18 色 token 系统（含 shimmer 配对），把 7 种 PendingActivity 从共用 spinner 升级为 5 相涟漪状态机（每相有独立 glyph + glimmer 方向），把 trimForViewport 的"头部截断"反转为"尾部保留 + 头部指示器"，把窄屏"隐藏 RightRail"升级为"降级到 StatusBar 的紧凑态"，把流式消息从"塞进数组"改为"列表外兄弟节点 + stable-prefix 锁定"。Logo 提供纯 ASCII 的 60 列安全方案。所有改动保持向后兼容的 glyph 主题双轨制（ASCII/Unicode）。

---

## 2. 分项方案

### A. 颜色系统重设计

#### 现状

[palette.ts](file:///e:/备份/deepseek-code/src/tui/theme/palette.ts) 仅 9 色（cyan/blue/white/dim/green/yellow/red/border），[theme.ts](file:///e:/备份/deepseek-code/src/tui/theme/theme.ts) 映射为 21 个语义键但底层颜色大量复用：`eventTool` 和 `eventPatch` 都是 green，`eventTask` 和 `eventEvidence` 都是 blue，`gatePending` 和 `eventActivity` 都是 yellow。无 shimmer 配对、无 dark/light 适配、无 dimColor 机制。

#### 诊断

1. **gate/evidence/patch/task 同时出现时视觉混淆**：四类事件共享 3 种颜色，用户无法快速区分"门禁阻断"与"证据失败"
2. **无 dimColor 抽象**：组件手写 `C.dim`，主题切换时无法统一调整
3. **无 shimmer 配对**：涟漪扫光动画无对应亮色，所有动画都是单色
4. **无暗色/亮色检测**：在浅色终端上 `#38BDF8` cyan 对比度不足
5. **brand 色未恒定**：HeaderBar 用 cyan、logo 用自定义 `#88C0D0`，品牌色不统一

#### 方案

**A.1 扩展 palette 到 14 个基础色 + 4 个 shimmer 配对 = 18 色**

```typescript
// palette.ts — 原始色值
export const palette = {
  // ── 品牌色（恒定，dark/light 不变）──
  abyss:      "#0EA5E9",  // 深海蓝 — Orcana 主品牌色（替代 cyan）
  abyssShimmer: "#7DD3FC", // 深海蓝亮色 — 涟漪扫光用
  // ── 语义色 ──
  teal:       "#2DD4BF",  // 暗流青 — task/plan
  tealShimmer:"#5EEAD4",
  coral:      "#FB7185",  // 珊瑚红 — error/blocked（比 red 更柔和）
  coralShimmer:"#FDA4AF",
  amber:      "#FBBF24",  // 琥珀黄 — warning/pending gate
  amberShimmer:"#FDE68A",
  jade:       "#34D399",  // 翡翠绿 — success/done
  jadeShimmer:"#6EE7B7",
  // ── 中性色 ──
  white:      "#E5E7EB",  // 主文本
  mist:       "#94A3B8",  // 次要文本（替代 dim，更可读）
  fog:        "#475569",  // 最弱文本（gutter/separator）
  border:     "#334155",  // 边框
  // ── 证据链专用色（新增，解决混淆）──
  evidence:   "#A78BFA",  // 紫罗兰 — evidence 专属（区别于 task blue）
  gate:       "#F472B6",  // 粉红 — gate 专属（区别于 warning amber）
  patch:      "#5EEAD4",  // 薄荷 — patch 专属（区别于 success jade）
  sonar:      "#38BDF8",  // 声呐蓝 — streaming/active tool
} as const
```

**A.2 theme.ts 语义映射表（21 → 28 键）**

| 语义键 | palette | 用途 | 典型场景 |
|--------|---------|------|----------|
| `text` | white | 主文本 | 消息正文 |
| `textDim` | mist | 次要文本 | 时间戳、计数 |
| `textFaint` | fog | 最弱文本 | gutter、separator |
| `brand` | abyss | 品牌主色 | Header "Orcana"、logo |
| `brandShimmer` | abyssShimmer | 扫光亮色 | 涟漪 propagate 扫光 |
| `success` | jade | 成功 | gate pass、done |
| `successShimmer` | jadeShimmer | 成功扫光 | settled 相位 |
| `warning` | amber | 警告 | pending gate、warn |
| `warningShimmer` | amberShimmer | 警告扫光 | verify 相位 |
| `error` | coral | 错误 | error、blocked |
| `errorShimmer` | coralShimmer | 错误扫光 | stalled 渐变终点 |
| `info` | sonar | 信息 | streaming、active tool |
| `task` | teal | 任务 | task 事件 |
| `taskShimmer` | tealShimmer | 任务扫光 | task 进行中 |
| `evidence` | evidence | 证据 | evidence 事件（专用） |
| `gate` | gate | 门禁 | gate 事件（专用） |
| `patch` | patch | 补丁 | patch 事件（专用） |
| `plan` | abyss | 计划 | plan 事件（复用品牌色） |
| `border` | border | 边框 | 分隔线 |
| `borderActive` | abyss | 激活边框 | focused input |
| `surface` | fog | 表面 | 背景提示 |

**A.3 dimColor 机制**：组件用 `<Text dimColor>` 替代 `<Text color={C.dim}>`，由 ThemedText 包装器自动映射到 `theme.textDim`。

**A.4 暗色/亮色策略**：暂不实现自动检测（YAGNI），但 palette 设计已保证：
- 所有语义色在暗色终端（`#1E1E2E` 背景）对比度 ≥ 4.5:1（AA）
- `textFaint`(`#475569`) 在亮色终端对比度不足，仅用于暗色；亮色 fallback 到 `textDim`

#### 验收

- [ ] palette ≥ 14 色，theme ≥ 28 键
- [ ] gate/evidence/patch 三色在 24-bit 终端肉眼可区分
- [ ] 每个主色有对应 shimmer 配对
- [ ] `bun test tests/tui/tokens.test.ts` 通过（更新色值断言）
- [ ] `bun run typecheck` 0 errors

---

### B. 动效规范

#### 现状

[pending-activity.ts](file:///e:/备份/deepseek-code/src/tui/pending-activity.ts) 定义 7 种 PendingActivity（routing/reading/editing/verifying/blocked/streaming/working），但 `activityGlyph` 中 routing/reading/streaming/working 全部使用同一个 `spinnerChars[tick % spinnerLen]`，仅 editing（editingGlow）和 verifying（verifyWave）有差异化。[tokens.ts](file:///e:/备份/deepseek-code/src/tui/tokens.ts) 的 `frameMs: 96` 单一帧率，无共享时钟、无视口暂停、无 reduced-motion、无 stalled 信号。

#### 诊断

1. **状态不可区分**：routing/reading/streaming/working 视觉 identical，用户看不出"准备上下文"和"流式输出"的区别
2. **无 glimmer 扫光**：Claude Code 用"光斑在文字上滑动"作为流式信号，Orcana 只有 spinner 旋转
3. **无共享时钟**：每个动画组件可能各自 tick，多 spinner 不同步
4. **无 stalled 信号**：agent 卡住 10 秒和正常思考 10 秒视觉无差异
5. **无 reduced-motion**：`prefers-reduced-motion` 用户无法降级
6. **涟漪相位无方向语义**：scan/propagate/verify 用不同字符但无"方向"暗示

#### 方案

**B.1 共享时钟架构**

新建 `src/tui/hooks/use-animation-frame.ts`：

```typescript
// 单一时钟源，所有动画从同一 time 派生
// keepAlive 订阅者驱动：无订阅者时时钟停止
// 视口不可见时自动退订
export function useAnimationFrame(intervalMs: number | null): number
```

- `intervalMs === null` 时停止（reduced-motion / idle）
- 通过 React Context 共享 `time`，所有 spinner 从同一 `time` 派生帧索引
- 替换当前 Scrollback 的 `tick` prop 透传（保留 tick 作为 fallback 兼容）

**B.2 涟漪 5 相状态机视觉规格表**

| 相位 | glyph 序列（Unicode） | ASCII fallback | 周期 | glimmer 方向 | 附加效果 | 颜色 |
|------|----------------------|----------------|------|-------------|----------|------|
| `idle` | `·`（静态） | `.` | — | 无 | 无 | textFaint |
| `scan` | `░▒▓█▓▒`（雷达扫描） | `.-+=+-.` | 240ms/帧 | 无 | 文本呼吸光（2s 正弦波） | brand |
| `propagate` | `○○○→●○○→●●○→●●●`（涟漪扩散） | `...->o..->oo.->ooo` | 200ms/帧 | 正向（左→右扫光） | brandShimmer 扫过标签 | brand |
| `verify` | `▁▃▅▇▅▃`（验证脉冲） | `.-^-.` | 180ms/帧 | 反向（右→左扫光） | warningShimmer 扫过 | warning |
| `blocked` | `! ! ! !`（阻塞闪烁） | `! ! ! !` | 300ms/帧 | 无 | stalled 渐变红（见 B.3） | error |
| `settled` | `✓`（静态） | `v` | — | 无 | 1 次 fade-out | success |

**glimmer 方向语义**：propagate 正向（向外扩散），verify 反向（向内收敛）—— 与涟漪物理语义对齐。

**B.3 stalled 渐变红机制**

```typescript
// 3 秒无新 token 触发 stalled
// 2 秒线性淡入到 error 色
// 新 token 到达立即重置（无淡出）
function useStalledAnimation(lastTokenAt: number, hasActiveTools: boolean): {
  isStalled: boolean
  intensity: number  // 0..1
}
```

- `intensity` 通过 `interpolateColor(normalColor, errorColor, intensity)` 渐变
- reduced-motion 时立即 `intensity = 1`（无渐变）

**B.4 reduced-motion 支持**

- 环境变量 `DEEPSEEK_TUI_REDUCED_MOTION=1` 或检测 `NO_COLOR`
- 所有动画组件 `intervalMs = null`，渲染静态字符
- fallback 字符：`idle→·` `scan→█` `propagate→●` `verify→▆` `blocked→!` `settled→✓`

**B.5 帧率预算**

| 层级 | 周期 | 用途 |
|------|------|------|
| 50ms (20fps) | 主循环（glimmer + stalled） | 仅活跃时 |
| 96ms (~10fps) | glyph 帧切换（保持现有 frameMs） | 兼容 |
| 250ms | RuntimePanel phase 可视化（保持现有） | 低帧 |
| 600ms | 光标闪烁 | 失焦暂停 |

**B.6 最小展示时长**：涟漪相位转换加 1.5s 最小展示门控，避免 `scan → propagate` 快速闪烁。

#### 验收

- [ ] 5 相状态机每相有独立 glyph + 颜色
- [ ] glimmer 方向在 propagate（正向）和 verify（反向）可见
- [ ] stalled 3s 触发 + 2s 渐变红
- [ ] reduced-motion 渲染静态字符
- [ ] 共享时钟：多 spinner 同步
- [ ] `bun test tests/tui/scrollback-animation.test.ts` 通过（更新帧断言）

---

### C. 布局重设计

#### 现状

[HeaderBar.tsx](file:///e:/备份/deepseek-code/src/tui/components/HeaderBar.tsx) 单行布局但字段优先级未定义——`narrow = cols < 80` 时仅砍 cache% 和 round，但 mode/model/state 全部固定宽度无截断。[RightRail.tsx](file:///e:/备份/deepseek-code/src/tui/components/RightRail.tsx) 在 `cols < 96`（[tokens.ts](file:///e:/备份/deepseek-code/src/tui/tokens.ts) `breakpointCompact`）时直接隐藏，runtime/gate/evidence 信息全部丢失。[AppShell.tsx](file:///e:/备份/deepseek-code/src/tui/components/AppShell.tsx) 有 `computeAppShellLayout` 但未定义字段优先级链。[StatusBar.tsx](file:///e:/备份/deepseek-code/src/tui/components/StatusBar.tsx) 与 HeaderBar 信息重叠。

#### 诊断

1. **Header 字段无优先级链**：窄屏时砍 cache% 和 round 是硬编码，非优先级驱动
2. **RightRail 隐藏即信息丢失**：96 列以下 runtime/gate/evidence/patch 全部消失，无降级
3. **StatusBar 与 HeaderBar 冗余**：两者都显示 ctx%/cache%，浪费一行
4. **无稳定高度保证**：Footer 高度随 `inputChrome.textRows` 变化，可能导致 Scrollback 跳动
5. **无早退优先级链**：FooterHints 没有 exitMessage > pasting > searching 互斥链

#### 方案

**C.1 Header 字段优先级链（flexShrink + truncate）**

```
[Orcana] · [mode] · [model] · [state] · [ctx %] · [cache %] · [r<n> · q:n]
   1         2        3        4          5          6           7
```

| 优先级 | 字段 | flexShrink | 窄屏行为 |
|--------|------|-----------|----------|
| 1 | brand "Orcana" | 0 | 永不截断 |
| 2 | mode | 0 | 永不截断 |
| 3 | model | 0 | 永不截断 |
| 4 | state（done/idle/thinking/blocked） | 0 | 永不截断 |
| 5 | ctx % | 0 | cols<80 砍 |
| 6 | cache % | 0 | cols<96 砍 |
| 7 | round + queue | 0 | round=0 不显示；queue=0 不显示 |

字段分隔符统一 ` · `（空格 + U+00B7 中点 + 空格），textFaint 色。

**C.2 窄/宽两套布局**

| 断点 | cols | 布局 |
|------|------|row 可见行|
|------|------|---------|
| 极窄 | <60 | Header(1) + Scrollback(bodyHeight) + Composer(2) + Footer(1) |
| 窄 | 60-95 | Header(1) + StatusBar(1, 紧凑) + Scrollback + Composer + Footer |
| 标准 | 96-119 | Header(1) + Scrollback + RightRail(28-36) + Composer + Footer |
| 舒适 | ≥120 | Header(1) + Scrollback + RightRail(36-42) + Composer + Footer |

**C.3 StatusBar 紧凑态（窄屏降级目标）**

窄屏下 StatusBar 从独立行变为 Header 的延伸（合并到 Header），显示：
```
Orcana · readonly · deepseek-v3 · idle · ctx 23% · r2
```
极窄下进一步砍 cache%，保留 ctx%。

**C.4 RightRail 三态显示策略**

| 状态 | 触发条件 | 宽屏（≥96） | 窄屏（<96） |
|------|----------|------------|------------|
| `idle` | ripplePhase=idle && gates=0 && patches=0 | 折叠为单行 "Runtime: idle" | 完全隐藏，Header 显示 "idle" |
| `running` | ripplePhase≠idle \|\| activeTools>0 | 完整显示 5 区块 | 降级到 StatusBar：`ripple <phase> · gates 2p/1b · ctx 45%` |
| `blocked` | ripplePhase=blocked \|\| gates.block>0 | 完整显示 + findings 前 2 条 | 降级到 StatusBar：`! blocked · <reason 24 chars>` |

**C.5 Footer 稳定高度**

```tsx
<Box height={1} overflow="hidden">
  {parts.length > 0 ? <Byline>{parts}</Byline> : <Text> </Text>}
</Box>
```
- 空内容渲染 `<Text> </Text>` 占 1 行，防止 Scrollback 跳动
- FooterHints 早退优先级链：`confirmModal > rewindModal > clarification > busy > idle`

#### 验收

- [ ] 60 cols 终端 Header 不换行、不截断关键字段
- [ ] 96 cols 以下 RightRail 信息降级到 StatusBar
- [ ] blocked 状态在窄屏可见
- [ ] Footer 高度恒定（空内容占 1 行）
- [ ] `bun test tests/tui/app-shell.test.ts` 通过（更新布局断言）

---

### D. 消息流视觉升级

#### 现状

[MessageItem.tsx](file:///e:/备份/deepseek-code/src/tui/components/MessageItem.tsx) 用 `$/#+/~/!/g/e/p` 作为 event marker，gate/evidence/patch 共享 blue/green/yellow。[format.ts](file:///e:/备份/deepseek-code/src/tui/format.ts) 的 `trimForViewport` 在文本超长时**保留尾部、截断头部**（`text.slice(-maxChars)`），用户看不到开头。流式消息塞进 `messages` 数组，每次 delta 触发整个列表 reconciliation。

#### 诊断

1. **marker 字符抽象**：`g/e/p` 不如 Claude Code 的 `⏺/✻/※` 直观，且 ASCII 模式下易混淆
2. **颜色混淆**：gate(evidence) 与 warning(success) 共享色相
3. **头部截断是反模式**：用户输入"长问题描述"后看不到自己的问题开头
4. **流式重排**：streaming 消息在数组内，每次 delta 触发 O(messages) reconciliation
5. **无 stable-prefix 锁定**：长 markdown 输出每次重新 parse 全文

#### 方案

**D.1 8 种消息类型视觉规范表**

| 类型 | marker (Unicode) | marker (ASCII) | marker 颜色 | 文本色 | 缩进 | 说明 |
|------|------------------|----------------|-------------|--------|------|------|
| user | `›` | `>` | brand | text | 0 | 用户输入 |
| assistant | `⏺` | `*` | info | text | 0 | 模型回复 |
| tool | `⎿` | `\` | success | textDim | 1 | 工具调用结果 |
| task | `◈` | `+` | task | task | 0 | 任务进度 |
| gate | ` ◆` | `g` | gate | gate | 0 | 门禁事件 |
| evidence | ` ▸` | `e` | evidence | evidence | 0 | 证据链事件 |
| patch | ` ✎` | `p` | patch | patch | 0 | 补丁事件 |
| error | `!` | `!` | error | error | 0 | 错误消息 |

- gutter 宽度 3 列（保持现有），marker + 1 空格 + 内容
- 连续同类型 event 取消 marginTop（`isUserContinuation` 模式）

**D.2 截断策略反转（修复"输出不完整"）**

```typescript
// format.ts — 新增 truncateTail 保留头部
export function trimForViewport(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const hidden = text.length - maxChars
  // 保留头部（用户更关心开头），尾部用指示器替代
  return `${text.slice(0, maxChars)}\n⋯ ${hidden} chars hidden below (scroll down for full content)`
}
```

- user 消息：保留头部（用户看到自己问题的完整开头）
- assistant 消息：保留头部 + 尾部各 60%，中间省略（双端可见）
- 阈值保持 12000（upper）/ 2000（lower），但改为基于 `stringWidth` 而非 `text.length`

**D.3 流式消息作为列表外兄弟节点**

[Scrollback.tsx](file:///e:/备份/deepseek-code/src/tui/components/Scrollback.tsx) 重构：

```tsx
// 之前：streaming 消息在 messages 数组内
{messages.map(renderMessageRow)}

// 之后：streaming 作为列表外兄弟节点
{committedMessages.map(renderMessageRow)}
{streamingText && <StreamingBlock text={streamingText} tick={tick} />}
```

- `committedMessages` = `messages.filter(m => !m.pending)`
- `streamingText` = pending 消息的当前文本
- delta 仅触发 StreamingBlock 重渲染，不触碰历史列表

**D.4 stable-prefix 锁定算法（StreamingBlock 内部）**

```typescript
// 仅对 unstable suffix 重新 parse，stable prefix 缓存
function useStablePrefix(text: string): { stable: string; unstable: string } {
  const stableRef = useRef('')
  // 防御性 reset：文本被替换（非前缀扩展）时重置
  if (!text.startsWith(stableRef.current)) stableRef.current = ''
  // 找到最后一个块边界，锁定前缀
  const tokens = markedLexer(text.substring(stableRef.current.length))
  const lastContentIdx = findLastNonSpaceToken(tokens)
  let advance = 0
  for (let i = 0; i < lastContentIdx; i++) advance += tokens[i].raw.length
  if (advance > 0) stableRef.current = text.substring(0, stableRef.current.length + advance)
  return { stable: stableRef.current, unstable: text.substring(stableRef.current.length) }
}
```

- stable prefix 用 `useMemo` 缓存，永不重 parse
- unstable suffix 每次 delta 重新 lex
- `'use no memo'` 跳出 React Compiler（compiler 无法证明 ref mutation 单调）

**D.5 截断 API 补齐（4 方向）**

```typescript
// format.ts — 新增
truncateToWidth(str, maxWidth)        // 尾部 …
truncateStartToWidth(str, maxWidth)   // 头部 …
truncatePathMiddle(path, maxWidth)    // 中间 …（保留 filename）
truncateSingleLine(str, maxWidth)     // 首个 \n 截断 + …
```

所有基于 `stringWidth` + grapheme segmenter，CJK/emoji 安全。

#### 验收

- [ ] 8 种消息类型 marker + 颜色肉眼可区分
- [ ] trimForViewport 保留头部（user 消息开头可见）
- [ ] 流式 delta 不触发历史消息 reconciliation
- [ ] stable-prefix 锁定：长输出滚动时不卡顿
- [ ] `bun test tests/tui/component-render.test.ts` 通过（更新 marker 断言）
- [ ] `bun test tests/tui/scrollback-animation.test.ts` 通过

---

### E. Logo 与启动画面

#### 现状

[logo.tsx](file:///e:/备份/deepseek-code/src/tui/logo.tsx) 已有 5 个方案，但全部使用 Unicode 块字符（`▄▀█▓░▒`），在 ASCII-only 终端（`DEEPSEEK_TUI_UNICODE` 未设置）下渲染为 mojibake。多个方案超过 60 列（OrcaSilhouette 32 列但 12 行高，SonarPulse 含 emoji）。无启动动画时序。

#### 诊断

1. **非 ASCII-safe**：与 [tokens.ts](file:///e:/备份/deepseek-code/src/tui/tokens.ts) 的 ASCII_GLYPHS 双轨制矛盾
2. **60 列不安全**：TailFin 含中文 + emoji，窄终端换行
3. **无启动动画**：splash 静态显示，无渐进感
4. **品牌色不统一**：logo 用 `#88C0D0`，HeaderBar 用 `#38BDF8`

#### 方案

**E.1 三个 ASCII-safe logo 方案（60 列安全）**

```
方案 A: 声呐脉冲（ASCII）— 24 cols × 7 rows
    .  o  O  o  .
  . o          o .
  O   ORCANA    O
  ' o          o '
    '  o  .  o  '

方案 B: 深海尾鳍（ASCII）— 20 cols × 6 rows
       ___
   ___/   \___
  /           \
  \___     ___/
      \___/

方案 C: 极简徽标（ASCII）— 16 cols × 4 rows
  +---------------+
  | ~ Orcana ~    |
  | sonar . ripple|
  +---------------+
```

每个方案提供 Unicode 增强版（`DEEPSEEK_TUI_UNICODE=1` 时启用）：
- 方案 A Unicode：`░▒▓█▓▒░` 替代 `.oOo.`
- 方案 B Unicode：`▄▀█` 块字符替代 `___`
- 方案 C Unicode：`╭─╮│╰─╯` 替代 `+-+|`

**E.2 启动动画时序（700ms，3 帧）**

```
帧 1 (0ms):    方案 A 仅 brand 行 "Orcana"（brand 色）
帧 2 (200ms):  + 声呐点 ".oOo."（brandShimmer 色，淡入）
帧 3 (400ms):  + 版本号 + tagline "sonar · ripple · verify"（textDim 色）
帧 4 (700ms):  完整 logo，停留 300ms 后 fade 到主界面
```

- reduced-motion：跳过动画，直接显示帧 4
- `DEEPSEEK_TUI_SPLASH=off` 跳过 splash（已支持）

**E.3 品牌色统一**：所有 logo 使用 `theme.brand`（abyss）+ `theme.brandShimmer`，不再硬编码 `#88C0D0`。

#### 验收

- [ ] 3 个方案在 `DEEPSEEK_TUI_UNICODE` 未设置时无 mojibake
- [ ] 60 cols 终端不换行
- [ ] 启动动画 700ms 内完成
- [ ] reduced-motion 跳过动画
- [ ] `bun test tests/tui/tokens.test.ts` 通过

---

### F. 修复方案（4 个已知问题）

#### F.1 输出不完整

**根因**：[format.ts:14-20](file:///e:/备份/deepseek-code/src/tui/format.ts) `trimForViewport` 用 `text.slice(-maxChars)` 保留尾部，头部用 `⋯ X chars hidden above` 替代。但用户更关心消息**开头**（问题描述、结论、第一行代码），而非尾部。

**改动点**：
- `format.ts:trimForViewport` — 反转策略：保留头部，尾部用 `⋯ X chars hidden below` 替代
- `MessageItem.tsx:renderMessageLines` — assistant 消息改用双端截断（头 60% + 尾 30%，中间省略）
- 阈值保持 12000/2000，但改用 `stringWidth` 而非 `text.length`

**保障措施**：
- 截断指示器文本不变（`⋯ X chars hidden`），仅方向反转
- 滚动历史仍可看到完整内容（scrollback 不截断）
- 新增 `truncateStartToWidth` / `truncatePathMiddle` 工具函数

#### F.2 颜色层级不够

**根因**：[palette.ts](file:///e:/备份/deepseek-code/src/tui/theme/palette.ts) 仅 9 色，gate/evidence/patch 共享 green/blue/yellow。[theme.ts](file:///e:/备份/deepseek-code/src/tui/theme/theme.ts) 的 `eventColor` 把 `gate→yellow`、`evidence→blue`、`patch→green`，但 `gatePending→yellow`、`eventActivity→yellow` 也用 yellow，导致 yellow 过载。

**改动点**：
- `palette.ts` — 扩展到 18 色（见 A.1）
- `theme.ts` — 28 个语义键（见 A.2）
- `MessageItem.tsx:eventColor` — gate→gate 色、evidence→evidence 色、patch→patch 色
- `RightRail.tsx` — gates 行用 gate 色、evidence 行用 evidence 色、patches 行用 patch 色

**保障措施**：
- 保留 `C` 别名兼容（`export const C = palette`）
- 渐进迁移：新色用 `theme.gate`，旧代码 `C.yellow` 仍工作
- 更新 `tokens.test.ts` 色值断言

#### F.3 pending 动画单调

**根因**：[pending-activity.ts:activityGlyph](file:///e:/备份/deepseek-code/src/tui/pending-activity.ts) 中 routing/reading/streaming/working 全部 `g.spinnerChars[tick % g.spinnerLen]`，仅 editing/verifying/blocked 有差异化。无 glimmer、无 stalled、无 reduced-motion。

**改动点**：
- `pending-activity.ts:activityGlyph` — 7 种 activity 各自独立 glyph 序列（见 B.2）
- 新建 `hooks/use-animation-frame.ts` — 共享时钟
- `Scrollback.tsx:applyPendingAnimation` — glimmer 扫光叠加
- 新建 `hooks/use-stalled-animation.ts` — stalled 渐变红

**保障措施**：
- 保持 `PendingActivity` 类型不变（不破坏 classifyPendingActivity）
- `tick` prop 保留作为 fallback（兼容现有测试）
- 帧率不提高（保持 96ms），仅增加视觉差异化
- 新增 `DEEPSEEK_TUI_REDUCED_MOTION` 环境变量

#### F.4 窄屏体验差

**根因**：[AppShell.tsx:178](file:///e:/备份/deepseek-code/src/tui/components/AppShell.tsx) `showDash = cols >= breakpointComfortable`，[tokens.ts](file:///e:/备份/deepseek-code/src/tui/tokens.ts) `breakpointCompact: 96`，96 列以下 RightRail 完全隐藏，runtime/gate/evidence/patch 信息全部丢失。

**改动点**：
- `AppShell.tsx:computeAppShellLayout` — 新增 `narrow` / `compact` / `comfortable` 三档
- `StatusBar.tsx` — 窄屏下显示紧凑 runtime 摘要（`ripple <phase> · gates Np/Nb · ctx N%`）
- `RightRail.tsx` — 三态显示策略（见 C.4）
- `FooterHints.tsx` — 窄屏砍非关键 hint（`width < 60` 仅显示 `Enter queue`）

**保障措施**：
- 不改变 `breakpointCompact` 阈值（保持 96）
- StatusBar 紧凑态仅窄屏启用，宽屏仍显示完整信息
- 现有 `computeAppShellLayout` 测试更新断言
- blocked 状态在所有屏宽下可见（P0 优先级）

---

## 3. 实施路线（PR 序列）

| PR | 标题 | 依赖 | 改动量 | 风险 |
|----|------|------|--------|------|
| PR-1 | 颜色系统扩展（palette 18 色 + theme 28 键） | 无 | ~150 行 | 低：纯数据，不碰组件逻辑 |
| PR-2 | 截断策略反转 + 截断 API 补齐 | 无 | ~80 行 | 中：scrollback 测试需更新 |
| PR-3 | 共享时钟 + reduced-motion 基础设施 | PR-1 | ~120 行 | 低：新增 hook，不删旧 tick |
| PR-4 | 涟漪 5 相状态机视觉差异化 | PR-1, PR-3 | ~100 行 | 中：pending-activity 测试更新 |
| PR-5 | 消息流 8 类型视觉规范 | PR-1 | ~60 行 | 低：marker + 颜色映射 |
| PR-6 | 流式消息兄弟节点 + stable-prefix | 无 | ~150 行 | 高：Scrollback 重构 |
| PR-7 | Header 字段优先级链 + StatusBar 紧凑态 | PR-1 | ~100 行 | 中：app-shell 测试更新 |
| PR-8 | RightRail 三态降级策略 | PR-1, PR-7 | ~80 行 | 中：selectors 测试更新 |
| PR-9 | Logo ASCII-safe + 启动动画 | PR-1 | ~120 行 | 低：独立模块 |
| PR-10 | stalled 渐变红机制 | PR-3, PR-4 | ~60 行 | 低：新增 hook |

**依赖图**：
```
PR-1 (颜色) ──┬─→ PR-3 (时钟) ──→ PR-4 (涟漪) ──→ PR-10 (stalled)
              ├─→ PR-5 (消息视觉)
              ├─→ PR-7 (Header) ──→ PR-8 (RightRail 降级)
              └─→ PR-9 (Logo)
PR-2 (截断) ─── 独立
PR-6 (流式) ─── 独立
```

**建议合并顺序**：PR-1 → PR-2 → PR-3 → PR-5 → PR-4 → PR-6 → PR-7 → PR-8 → PR-9 → PR-10

---

## 4. 风险清单

| 风险 | 影响范围 | 缓解措施 |
|------|----------|----------|
| trimForViewport 反转破坏 scrollback-animation 测试 | `tests/tui/scrollback-animation.test.ts` | 同步更新断言，保持 `⋯ X chars hidden` 文案格式 |
| palette 色值改变破坏 tokens.test.ts | `tests/tui/tokens.test.ts` | PR-1 同步更新色值断言 |
| 流式兄弟节点破坏 scroll offset 计算 | `Scrollback.tsx` | 保持 `allLines` 计算逻辑，streaming 作为额外行追加 |
| stable-prefix `'use no memo'` 与 React Compiler 冲突 | `StreamingBlock` | 仅在该组件加指令，不影响其他组件 |
| ClockContext 与现有 `tick` prop 透传冲突 | 全局 | 双轨：tick 作为 fallback，ClockContext 优先；渐进迁移 |
| gate/evidence/patch 新色在 8-bit 终端降级 | 老终端 | palette 提供 ANSI 256 fallback 注释 |
| RightRail 降级到 StatusBar 导致信息重复 | StatusBar | 窄屏下 StatusBar 显示紧凑摘要，宽屏下独立行 |
| reduced-motion 环境变量未文档化 | 用户发现不了 | 在 `/help` 输出中列出 `DEEPSEEK_TUI_REDUCED_MOTION` |
| logo ASCII 方案丢失品牌识别度 | 品牌一致性 | Unicode 增强版默认在支持终端启用 |
| stalled 3s 阈值在慢网络下误触发 | 用户体验 | 仅在 `!hasActiveTools` 时触发（工具运行中不判定 stalled） |

---

## 5. 验收 Checklist

### 颜色系统（A）
- [ ] palette ≥ 14 色基础 + 4 shimmer = 18 色
- [ ] theme ≥ 28 个语义键
- [ ] gate / evidence / patch 三色在 24-bit 终端肉眼可区分
- [ ] 每个主色有对应 `*Shimmer` 配对
- [ ] `C` 别名向后兼容（旧代码 `C.cyan` 仍工作）

### 动效规范（B）
- [ ] 涟漪 5 相状态机每相有独立 glyph 序列
- [ ] propagate glimmer 正向扫光（左→右）
- [ ] verify glimmer 反向扫光（右→左）
- [ ] stalled 3s 触发 + 2s 线性渐变红
- [ ] reduced-motion 渲染静态字符（`DEEPSEEK_TUI_REDUCED_MOTION=1`）
- [ ] 共享时钟：多 spinner 同步（同一 time 源）

### 布局重设计（C）
- [ ] 60 cols 终端 Header 不换行、不截断 brand/mode/model/state
- [ ] 96 cols 以下 RightRail 信息降级到 StatusBar
- [ ] blocked 状态在所有屏宽下可见（P0）
- [ ] Footer 高度恒定（空内容 `<Text> </Text>` 占 1 行）
- [ ] Header 字段优先级链：brand > mode > model > state > ctx > cache > round > queue

### 消息流（D）
- [ ] 8 种消息类型 marker + 颜色肉眼可区分
- [ ] trimForViewport 保留头部（user 消息开头可见）
- [ ] assistant 消息双端截断（头 60% + 尾 30%，中间省略）
- [ ] 流式 delta 不触发历史消息 reconciliation
- [ ] stable-prefix 锁定：长输出滚动时不卡顿
- [ ] 截断 API 4 方向齐全（tail/head/pathMiddle/singleLine）

### Logo（E）
- [ ] 3 个方案在 `DEEPSEEK_TUI_UNICODE` 未设置时无 mojibake
- [ ] 60 cols 终端不换行
- [ ] 启动动画 700ms 内完成（3 帧 + 300ms 停留）
- [ ] reduced-motion 跳过动画
- [ ] 品牌色统一使用 `theme.brand`（不再硬编码 `#88C0D0`）

### 修复方案（F）
- [ ] F.1: trimForViewport 保留头部，`⋯ X chars hidden below` 指示器
- [ ] F.2: gate 用 `theme.gate` 色，evidence 用 `theme.evidence` 色，patch 用 `theme.patch` 色
- [ ] F.3: 7 种 PendingActivity 各有独立 glyph（无共用 spinner）
- [ ] F.4: 96 cols 以下 StatusBar 显示 `ripple <phase> · gates Np/Nb · ctx N%`

### 工程基线
- [ ] `bun run typecheck` 0 errors
- [ ] `bun test tests/tui` ≥ 426 pass（不回退）
- [ ] 无新增 `setInterval`（所有动画走 ClockContext）
- [ ] 无 Unicode 字符硬编码（全部走 `getGlyphTheme()`）
- [ ] `DEEPSEEK_TUI_REDUCED_MOTION` 环境变量生效

---

## 附录：Claude Code 设计哲学蒸馏（5 条不变量）

1. **用户输入永远优先**：命令队列三级优先级（now > next > later），busy 时输入排队不丢弃，UP 可拉回编辑
2. **终端状态必须可恢复**：cleanup 顺序 mouse→unmount→drain→disable→cursor→title，failsafe timer unref + SIGKILL 兜底
3. **异步操作必须有超时上限**：analytics flush 500ms race，session end hook 整体预算，cleanup 2s race
4. **关键路径同步执行**：resume hint 先于 async 打印，被 SIGKILL 也可见；cleanupTerminalModes 用 writeSync
5. **流式不做打字机**：stable-prefix 锁定 + glimmer 扫光替代逐字符动画，零延迟无重排

Orcana 改造时把这 5 条作为不变量贯穿始终——尤其是第 5 条，是解决"输出不完整"和"pending 动画单调"的根本方法论。
