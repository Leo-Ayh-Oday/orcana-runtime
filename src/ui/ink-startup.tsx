/** InkStartupScreen — Orcana 启动画面（Depthline P5 简化）。
 *
 *  P5: 删除 BigText 大字与 SignalLine 动画（依赖清理 + 单一动画原则）。
 *  静态品牌行 + Capsule 胶囊布局。
 */

import React from "react"
import { Box, Text, render } from "ink"
import { theme } from "../tui/theme/theme"

export interface InkStartupOptions {
  version: string
  toolsCount: number
  thinkingEffort: string
  modelName: string
  durationMs?: number
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
  return (
    <Box flexDirection="column" paddingX={2} paddingTop={1}>
      <Box>
        <Text bold color={theme.brand}>Orcana</Text>
        <Text color={theme.textFaint}>  v{version} · Harness runtime</Text>
      </Box>

      <Box marginTop={1} marginBottom={1}>
        <Text color={theme.textFaint}>Sonar first. Ripple before writes. Evidence before done.</Text>
      </Box>

      <Box flexDirection="row" marginBottom={1}>
        <Capsule label="model" value={modelName} color={theme.brand} />
        <Capsule label="tools" value={String(toolsCount)} color={theme.warning} />
        <Capsule label="thinking" value={thinkingEffort} color={theme.info} />
      </Box>

      <Box marginTop={1}>
        <Text color={theme.textFaint}>/help commands  /runtime inspector  /gates ledger  /stats telemetry</Text>
      </Box>
    </Box>
  )
}

export async function playInkStartupScreen(options: InkStartupOptions): Promise<boolean> {
  if (!process.stdout.isTTY || process.env.ORCANA_TUI_INK === "off") return false

  const durationMs = Math.max(1400, options.durationMs ?? 2200)
  const instance = render(<InkStartupScreen {...options} />, { exitOnCtrlC: false })
  await new Promise(resolve => setTimeout(resolve, durationMs))
  instance.unmount()
  return true
}
