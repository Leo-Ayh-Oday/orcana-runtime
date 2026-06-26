import React, { useEffect, useState } from "react"
import { Box, Text, render } from "ink"
import BigText from "ink-big-text"

export interface InkStartupOptions {
  version: string
  toolsCount: number
  thinkingEffort: string
  modelName: string
  durationMs?: number
}

const palette = {
  cyan: "#38BDF8",
  blue: "#60A5FA",
  green: "#22C55E",
  yellow: "#EAB308",
  dim: "#6B7280",
  fg: "#E5E7EB",
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

  return <Text color={palette.blue}>{chars}</Text>
}

function Capsule({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <Box marginRight={2}>
      <Text color={palette.dim}>[</Text>
      <Text color={color}>{label}</Text>
      <Text> {value}</Text>
      <Text color={palette.dim}>]</Text>
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
        <Text color={palette.cyan}>
          <BigText text="DEEPSEEK" font="block" space={false} />
        </Text>
      </Box>

      <Box marginTop={-1}>
        <Text color={palette.fg} bold>DeepSeek Code </Text>
        <Text color={palette.dim}>v{version} / </Text>
        <Text color={palette.cyan}>Hraness runtime</Text>
      </Box>

      <Box marginTop={1} marginBottom={1}>
        <Text color={palette.dim}>Sonar first. Ripple before writes. Evidence before done.</Text>
      </Box>

      <Box flexDirection="row" marginBottom={1}>
        <Capsule label="model" value={modelName} color={palette.cyan} />
        <Capsule label="fim" value="on" color={palette.green} />
        <Capsule label="tools" value={String(toolsCount)} color={palette.yellow} />
        <Capsule label="thinking" value={thinkingEffort} color={palette.blue} />
      </Box>

      <SignalLine tick={tick} />

      <Box marginTop={1}>
        <Text color={palette.cyan}>{["calibrating", "indexing", "routing", "readying"][tick % 4]}</Text>
        <Text color={palette.dim}> context, tools, memory</Text>
      </Box>

      <Box marginTop={1}>
        <Text color={palette.dim}>/help commands  /sessions history  /compact memory  /stats telemetry</Text>
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
