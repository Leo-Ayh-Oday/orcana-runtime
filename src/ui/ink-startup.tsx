/** InkStartupScreen — Orcana 启动画面（Phase 8 rebrand）。
 *
 *  Phase 8: 硬编码 palette → theme.* 迁移。"DEEPSEEK" → "ORCANA" 品牌更新。
 *  保留 BigText 字体 + SignalLine 动画 + Capsule 胶囊布局。
 */

import React, { useEffect, useState } from "react"
import { Box, Text, render } from "ink"
import BigText from "ink-big-text"
import { theme } from "../tui/theme/theme"

export interface InkStartupOptions {
  version: string
  toolsCount: number
  thinkingEffort: string
  modelName: string
  durationMs?: number
}

function SignalLine({ tick }: { tick: number }) {
  const width = 58
  const chars = Array.from({ length: width }, (_, i) => {
    const phase = (i + tick) % 16
    if (phase === 0) return "="
    if (phase <= 2 || phase >= 14) return "~"
    if (phase <= 5 || phase >= 11) return "-"
    return "."
  }).join("")

  return <Text color={theme.info}>{chars}</Text>
}

function Capsule({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <Box marginRight={2}>
      <Text color={theme.textFaint}>[</Text>
      <Text color={color}>{label}</Text>
      <Text> {value}</Text>
      <Text color={theme.textFaint}>]</Text>
    </Box>
  )
}

export function InkStartupScreen({ version, toolsCount, thinkingEffort, modelName }: InkStartupOptions) {
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => setTick(value => value + 1), 110)
    return () => clearInterval(timer)
  }, [])

  return (
    <Box flexDirection="column" paddingX={2} paddingTop={1}>
      <Box>
        <Text color={theme.brand}>
          <BigText text="ORCANA" font="block" space={false} />
        </Text>
      </Box>

      <Box marginTop={-1}>
        <Text color={theme.text} bold>Orcana </Text>
        <Text color={theme.textFaint}>v{version} / </Text>
        <Text color={theme.brand}>Hraness runtime</Text>
      </Box>

      <Box marginTop={1} marginBottom={1}>
        <Text color={theme.textFaint}>Sonar first. Ripple before writes. Evidence before done.</Text>
      </Box>

      <Box flexDirection="row" marginBottom={1}>
        <Capsule label="model" value={modelName} color={theme.brand} />
        <Capsule label="fim" value="on" color={theme.success} />
        <Capsule label="tools" value={String(toolsCount)} color={theme.warning} />
        <Capsule label="thinking" value={thinkingEffort} color={theme.info} />
      </Box>

      <SignalLine tick={tick} />

      <Box marginTop={1}>
        <Text color={theme.brand}>{["calibrating", "indexing", "routing", "readying"][tick % 4]}</Text>
        <Text color={theme.textFaint}> context, tools, memory</Text>
      </Box>

      <Box marginTop={1}>
        <Text color={theme.textFaint}>/help commands  /sessions history  /compact memory  /stats telemetry</Text>
      </Box>
    </Box>
  )
}

export async function playInkStartupScreen(options: InkStartupOptions): Promise<boolean> {
  if (!process.stdout.isTTY || process.env.DEEPSEEK_TUI_INK === "off") return false

  const durationMs = Math.max(1400, options.durationMs ?? 2200)
  const instance = render(<InkStartupScreen {...options} />, { exitOnCtrlC: false })
  await new Promise(resolve => setTimeout(resolve, durationMs))
  instance.unmount()
  return true
}
