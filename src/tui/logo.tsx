/** Orcana logo variants — 深海虎鲸 / Sonar Orca theme.
 *
 *  PR-9: 3 ASCII-safe logo variants + 700ms startup animation.
 *    - 方案 A 声呐脉冲 (Sonar Pulse): 7 rows, max 25 cols, ASCII/Unicode dual-track
 *    - 方案 B 深海尾鳍 (Tail Fin):    6 rows, max 15 cols, ASCII/Unicode dual-track
 *    - 方案 C 极简徽标 (Minimal Badge): 4 rows, 16 cols, ASCII/Unicode dual-track
 *  所有方案在 DEEPSEEK_TUI_UNICODE 未设置时纯 ASCII（charCode < 128），60 列终端不换行。
 *  品牌色统一使用 theme.brand / theme.brandShimmer，无硬编码 hex。
 *
 *  Phase 8: 旧 5 套 logo 保留向后兼容（app.tsx 引用 GeometricFin）。
 */

import React, { useEffect, useRef, useState } from "react"
import { Box, Text } from "ink"
import { theme } from "./theme/theme"
import { VERSION_LABEL } from "../version"
import { useClock } from "./clock"

// ── PR-9: 类型 ──

export type LogoVariant = "sonar" | "tailfin" | "minimal"
export type LogoFrame = 0 | 1 | 2 | 3

export interface LogoLine {
  text: string
  color: string
  bold?: boolean
}

/** 内部行定义 — ASCII + Unicode 双轨 + 语义 kind（控制 frame 可见性 + 颜色） */
interface LogoLineDef {
  ascii: string
  unicode: string
  kind: "pulse" | "center" | "version" | "tagline" | "border" | "content" | "decoration"
}

// ── PR-9: 纯数据 — 三个 ASCII-safe 方案 ──

/** 方案 A: 声呐脉冲 — 5 行脉冲 + 动态 version/tagline = 7 rows
 *  Pulse rows max 19 cols, tagline row 25 cols. 60-col safe. */
const SONAR_PULSE_PULSE: LogoLineDef[] = [
  { ascii: "    .  o  O  o  .", unicode: "    \u{2591}  \u{2592}  \u{2593}  \u{2588}  \u{2593}  \u{2592}  \u{2591}", kind: "pulse" },
  { ascii: "  . o          o .", unicode: "  \u{2591} \u{2592}            \u{2592} \u{2591}", kind: "pulse" },
  { ascii: "  O   ORCANA    O", unicode: "  \u{2593}   ORCANA      \u{2593}", kind: "center" },
  { ascii: "  ' o          o '", unicode: "  \u{2591} \u{2592}            \u{2592} \u{2591}", kind: "pulse" },
  { ascii: "    '  o  .  o  '", unicode: "    \u{2591}  \u{2592}  \u{2593}  \u{2592}  \u{2591}", kind: "pulse" },
]

/** 方案 B: 深海尾鳍 — 6 rows, max 15 cols. 60-col safe. */
const TAIL_FIN_LINES: LogoLineDef[] = [
  { ascii: "       ___",           unicode: "       \u{2584}\u{2580}\u{2584}",       kind: "decoration" },
  { ascii: "   ___/   \\___",       unicode: "   \u{2584}\u{2580}\u{2580}   \u{2580}\u{2580}\u{2584}",     kind: "decoration" },
  { ascii: "  /           \\",      unicode: "  \u{2588}         \u{2588}",   kind: "content" },
  { ascii: "  \\___     ___/",      unicode: "  \u{2580}\u{2584}\u{2584}     \u{2584}\u{2584}\u{2580}",   kind: "content" },
  { ascii: "      \\___/",          unicode: "      \u{2580}\u{2580}\u{2580}",       kind: "decoration" },
  { ascii: "  ~~~~~~~~~~~~~",      unicode: "  ~~~~~~~~~~~~~", kind: "decoration" },
]

/** 方案 C: 极简徽标 — 4 rows, 16 cols. 60-col safe. */
const MINIMAL_BADGE_LINES: LogoLineDef[] = [
  { ascii: "+--------------+",      unicode: "\u{256D}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{256E}", kind: "border" },
  { ascii: "| ~ Orcana ~   |",      unicode: "\u{2502} ~ Orcana ~   \u{2502}", kind: "content" },
  { ascii: "| sonar.ripple |",      unicode: "\u{2502} sonar.ripple \u{2502}", kind: "content" },
  { ascii: "+--------------+",      unicode: "\u{2570}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{256F}", kind: "border" },
]

// ── PR-9: 纯函数 — 根据 variant/frame/unicode 计算 LogoLine[] ──

/** 计算指定 variant/frame/unicode 下的 logo 行数据。
 *  纯函数，便于测试（ASCII 安全性、60 列安全、frame 可见性）。 */
export function computeLogoLines(
  variant: LogoVariant,
  frame: LogoFrame,
  unicode: boolean,
  versionLabel: string,
): LogoLine[] {
  if (variant === "sonar") {
    return computeSonarLines(frame, unicode, versionLabel)
  }
  if (variant === "tailfin") {
    return computeTailFinLines(unicode)
  }
  return computeMinimalLines(unicode)
}

/** 方案 A 声呐脉冲 — frame 控制行可见性 + pulse 颜色：
 *    Frame 0: 仅 center 行（ORCANA brand bold）
 *    Frame 1: + pulse 行（brandShimmer）
 *    Frame 2: + version + tagline（textDim）
 *    Frame 3: 全部 — pulse 切换到 brand 色（最终态） */
function computeSonarLines(frame: LogoFrame, unicode: boolean, versionLabel: string): LogoLine[] {
  const lines: LogoLine[] = []
  const showPulse = frame >= 1
  const showText = frame >= 2
  const pulseColor = frame >= 3 ? theme.brand : theme.brandShimmer

  for (const def of SONAR_PULSE_PULSE) {
    if (def.kind === "pulse" && !showPulse) continue
    const text = unicode ? def.unicode : def.ascii
    if (def.kind === "center") {
      lines.push({ text, color: theme.brand, bold: true })
    } else {
      lines.push({ text, color: pulseColor })
    }
  }

  if (showText) {
    const versionText = `  Orcana ${versionLabel}`
    const taglineText = unicode ? "  sonar \u{00B7} ripple \u{00B7} verify" : "  sonar . ripple . verify"
    lines.push({ text: versionText, color: theme.textDim })
    lines.push({ text: taglineText, color: theme.textDim })
  }

  return lines
}

/** 方案 B 深海尾鳍 — 静态（无 frame 渐进），decoration=textFaint, content=brand */
function computeTailFinLines(unicode: boolean): LogoLine[] {
  return TAIL_FIN_LINES.map(def => ({
    text: unicode ? def.unicode : def.ascii,
    color: def.kind === "content" ? theme.brand : theme.textFaint,
  }))
}

/** 方案 C 极简徽标 — 静态（无 frame 渐进），border=textFaint, content=brand */
function computeMinimalLines(unicode: boolean): LogoLine[] {
  return MINIMAL_BADGE_LINES.map(def => ({
    text: unicode ? def.unicode : def.ascii,
    color: def.kind === "content" ? theme.brand : theme.textFaint,
  }))
}

// ── PR-9: React 组件 — 三个 ASCII-safe logo 方案 ──

/** 方案 A: 声呐脉冲 (Sonar Pulse) — 7 rows, max 25 cols.
 *  接受可选 frame prop（默认 3 = 完整 logo），用于启动动画。 */
export function SonarPulseLogo({ frame = 3 }: { frame?: LogoFrame }) {
  const unicode = process.env.DEEPSEEK_TUI_UNICODE === "1"
  const lines = computeSonarLines(frame, unicode, VERSION_LABEL)
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i} color={line.color} bold={line.bold}>
          {line.text}
        </Text>
      ))}
    </Box>
  )
}

/** 方案 B: 深海尾鳍 (Tail Fin) — 6 rows, max 15 cols. */
export function TailFinLogo() {
  const unicode = process.env.DEEPSEEK_TUI_UNICODE === "1"
  const lines = computeTailFinLines(unicode)
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i} color={line.color}>
          {line.text}
        </Text>
      ))}
    </Box>
  )
}

/** 方案 C: 极简徽标 (Minimal Badge) — 4 rows, 16 cols. */
export function MinimalBadgeLogo() {
  const unicode = process.env.DEEPSEEK_TUI_UNICODE === "1"
  const lines = computeMinimalLines(unicode)
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i} color={line.color}>
          {line.text}
        </Text>
      ))}
    </Box>
  )
}

// ── PR-9: 启动动画 — 700ms, 4 帧渐进 ──

/** 帧间延迟（ms）：0→1=200ms, 1→2=200ms, 2→3=300ms，总计 700ms。 */
const LOGO_FRAME_DELAYS = [200, 200, 300]

/** LogoAnimation — 700ms 启动动画，基于方案 A（声呐脉冲）。
 *
 *  帧时序（计划 E.2）：
 *    帧 0 (0ms):   仅 ORCANA brand 行（brand 色）
 *    帧 1 (200ms): + 声呐点 pulse 行（brandShimmer 色，淡入）
 *    帧 2 (400ms): + version + tagline（textDim 色）
 *    帧 3 (700ms): 完整 logo — pulse 切换到 brand 色（最终态）
 *
 *  reduced-motion: 跳过动画，直接显示帧 3。
 *  onComplete: 动画完成（帧 3）时回调。 */
export function LogoAnimation({
  variant = "sonar",
  onComplete,
}: {
  variant?: LogoVariant
  onComplete?: () => void
}) {
  const { reducedMotion } = useClock()
  const [frame, setFrame] = useState<LogoFrame>(reducedMotion ? 3 : 0)
  const calledRef = useRef(false)

  useEffect(() => {
    // reduced-motion 或帧已到 3：触发 onComplete（仅一次）
    if (reducedMotion || frame >= 3) {
      if (!calledRef.current) {
        calledRef.current = true
        onComplete?.()
      }
      return
    }
    const delay = LOGO_FRAME_DELAYS[frame] ?? 300
    const timer = setTimeout(() => {
      setFrame(f => Math.min(3, f + 1) as LogoFrame)
    }, delay)
    return () => clearTimeout(timer)
  }, [frame, reducedMotion, onComplete])

  const unicode = process.env.DEEPSEEK_TUI_UNICODE === "1"
  const lines = computeLogoLines(variant, frame, unicode, VERSION_LABEL)

  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i} color={line.color} bold={line.bold}>
          {line.text}
        </Text>
      ))}
    </Box>
  )
}

// ── PR-9: 工具函数 — 供外部测试与 60 列安全校验 ──

/** 检查字符串是否纯 ASCII（所有字符 charCode < 128）。 */
export function isPureAscii(str: string): boolean {
  for (const ch of str) {
    if (ch.codePointAt(0)! >= 128) return false
  }
  return true
}

/** 返回指定 variant 在 ASCII 模式下的最大行宽（列数）。 */
export function maxLogoWidth(variant: LogoVariant, versionLabel: string = "v0.0.0"): number {
  const lines = computeLogoLines(variant, 3, false, versionLabel)
  let max = 0
  for (const line of lines) {
    max = Math.max(max, line.text.length)
  }
  return max
}

// ── Phase 8 旧 logo（向后兼容 — app.tsx 引用 GeometricFin） ──
// 保留原有 5 套 Unicode logo，供 ShowAllLogos 对比与旧代码兼容。

/** Variant 1: 几何尾鳍 — 极简现代（Phase 8，Unicode-only） */
export function GeometricFin() {
  return (
    <Box flexDirection="column">
      <Text color={theme.brand}>{`       ▄▄▄▄▄▄▄▄`}</Text>
      <Text color={theme.brand}>{`     ▄██████████▄`}</Text>
      <Text color={theme.info}>{`    ██▀▀▀▀▀▀▀▀██`}</Text>
      <Text color={theme.info}>{`   ██    ▄▄   ██`}</Text>
      <Text color={theme.brand}>{`   ██   ████  ██     Orcana`}</Text>
      <Text color={theme.brand}>{`    ██▄▄▄▄▄▄▄▄██     Hraness ${VERSION_LABEL}`}</Text>
      <Text color={theme.textFaint}>{`      ▀▀▀▀▀▀▀▀`}</Text>
    </Box>
  )
}

/** Variant 2: 声呐脉冲（Phase 8 旧版，Unicode-only）— 见 SonarPulseLogo for ASCII-safe PR-9 版 */
export function SonarPulse() {
  return (
    <Box flexDirection="column">
      <Text color={theme.textFaint}>{`              ░░░░░░░░`}</Text>
      <Text color={theme.textFaint}>{`           ░░▒▒▒▒▒▒▒▒░░`}</Text>
      <Text color={theme.info}>{`         ░▒▓▓▓▓▓▓▓▓▓▓▒░`}</Text>
      <Text color={theme.brand}>{`       ░▒▓▓▓▓▓█▓▓▓▓▓▓▒░       ░▒▓▓▓▓▓█▓▓▓▓▓▓▒░       Hraness`}</Text>
      <Text color={theme.brand}>{`        ░▒▓▓▓▓▓▓▓▓▓▓▒░        Orcana ${VERSION_LABEL}`}</Text>
      <Text color={theme.info}>{`          ░▒▒▒▒▒▒▒▒░`}</Text>
      <Text color={theme.textFaint}>{`            ░░░░░░`}</Text>
    </Box>
  )
}

/** Variant 3: 深海虎鲸侧影（Phase 8 旧版，Unicode-only） */
export function OrcaSilhouette() {
  return (
    <Box flexDirection="column">
      <Text color={theme.brand}>{`            ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄`}</Text>
      <Text color={theme.brand}>{`         ▄██████████████████████▄▄`}</Text>
      <Text color={theme.info}>{`       ▄█▀▀▀██████████▀▀▀▀▀▀█████▄`}</Text>
      <Text color={theme.text}>{`     ▄█▀    ██████████        ▀▀███▄`}</Text>
      <Text color={theme.text}>{`    ██      ██████████▌          ████`}</Text>
      <Text color={theme.info}>{`   ██       ██████████▌          ▐███`}</Text>
      <Text color={theme.info}>{`   ██       ██████████▌           ███`}</Text>
      <Text color={theme.brand}>{`   ██      ▄██████████▄           ███`}</Text>
      <Text color={theme.brand}>{`   ██     ██████████████          ███`}</Text>
      <Text color={theme.info}>{`    ██▄  ████████████████        ▄██`}</Text>
      <Text color={theme.info}>{`     ▀█████████████████████▄▄▄▄▄██▀`}</Text>
      <Text color={theme.brand}>{`       ▀▀███████████████████████▀▀`}</Text>
    </Box>
  )
}

/** Variant 4: 虎鲸尾鳍出水（Phase 8 旧版，Unicode-only） */
export function TailFin() {
  return (
    <Box flexDirection="column">
      <Text color={theme.eventTask}>{`                ▐▛███▌`}</Text>
      <Text color={theme.eventTask}>{`              ▐███████▌`}</Text>
      <Text color={theme.brand}>{`            ▄███████████▌`}</Text>
      <Text color={theme.brand}>{`          ▄█████████████▌`}</Text>
      <Text color={theme.info}>{`        ▄███████████████▌`}</Text>
      <Text color={theme.info}>{`     ▄▄█████████████████▌`}</Text>
      <Text color={theme.text}>{`  ▄█████████████████████▌`}</Text>
      <Text color={theme.text}>{`  ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀`}</Text>
      <Text color={theme.textFaint}>{`  ░░░░░░░░░░░░░░░░░░░░░░  深海之下，声呐先行`}</Text>
      <Text> </Text>
      <Text color={theme.brand}>{`  Orcana ${VERSION_LABEL}`}</Text>
      <Text color={theme.textFaint}>{`  Sonar Pulse · Swarm Concurrency · Cold Memory`}</Text>
    </Box>
  )
}

/** Variant 5: 抽象声呐波（Phase 8 旧版，Unicode-only） */
export function MinimalSonar() {
  return (
    <Box flexDirection="column">
      <Text color={theme.textFaint}>{`         ╭─ . o O o O o . ─╮`}</Text>
      <Text color={theme.info}>{`        ╭┤  Orcana  ├╮`}</Text>
      <Text color={theme.brand}>{`       ╭┤   ${VERSION_LABEL} · hraness  ├╮`}</Text>
      <Text color={theme.brand}>{`      ╭┤    sonar · swarm      ├╮`}</Text>
      <Text color={theme.info}>{`      ╰─────────────────────────╯`}</Text>
      <Text> </Text>
      <Text color={theme.textFaint}>{`      ~~~ ripple - think - verify ~~~`}</Text>
    </Box>
  )
}

/** Show all variants — PR-9 ASCII-safe 优先，Phase 8 旧版附后对比。 */
export function ShowAllLogos() {
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color={theme.text}>Orcana Logo 方案选择</Text>
      <Text color={theme.textFaint}>──────────────────────────────────────────────</Text>
      <Text> </Text>
      <Text bold color={theme.brand}>PR-9 方案 A: 声呐脉冲 (Sonar Pulse) — ASCII-safe</Text>
      <SonarPulseLogo />
      <Text> </Text>
      <Text color={theme.textFaint}>──────────────────────────────────────────────</Text>
      <Text bold color={theme.brand}>PR-9 方案 B: 深海尾鳍 (Tail Fin) — ASCII-safe</Text>
      <TailFinLogo />
      <Text> </Text>
      <Text color={theme.textFaint}>──────────────────────────────────────────────</Text>
      <Text bold color={theme.brand}>PR-9 方案 C: 极简徽标 (Minimal Badge) — ASCII-safe</Text>
      <MinimalBadgeLogo />
      <Text> </Text>
      <Text color={theme.textFaint}>──────────────────────────────────────────────</Text>
      <Text bold color={theme.textDim}>Phase 8 旧版（Unicode-only，向后兼容）</Text>
      <Text> </Text>
      <Text color={theme.brand}>旧方案 A: 几何尾鳍 (Geometric Fin)</Text>
      <GeometricFin />
      <Text> </Text>
      <Text color={theme.brand}>旧方案 B: 声呐脉冲 (Sonar Pulse)</Text>
      <SonarPulse />
      <Text> </Text>
      <Text color={theme.brand}>旧方案 C: 深海虎鲸侧影 (Orca Silhouette)</Text>
      <OrcaSilhouette />
      <Text> </Text>
      <Text color={theme.brand}>旧方案 D: 尾鳍出水 (Tail Fin)</Text>
      <TailFin />
      <Text> </Text>
      <Text color={theme.brand}>旧方案 E: 抽象声呐波 (Minimal Sonar)</Text>
      <MinimalSonar />
    </Box>
  )
}
