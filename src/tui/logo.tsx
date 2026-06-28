/** DeepSeek Code logo variants — 深海虎鲸 / Sonar Orca theme */
import React from "react"
import { Box, Text } from "ink"

const Cyan = "#88C0D0"
const Blue = "#81A1C1"
const White = "#D8DEE9"
const Dim = "#616E88"
const Teal = "#8FBCBB"

/** Variant 1: 几何尾鳍 — 极简现代 ASCII */
export function GeometricFin() {
  return (
    <Box flexDirection="column">
      <Text color={Cyan}>{`       ▄▄▄▄▄▄▄▄`}</Text>
      <Text color={Cyan}>{`     ▄██████████▄`}</Text>
      <Text color={Blue}>{`    ██▀▀▀▀▀▀▀▀██`}</Text>
      <Text color={Blue}>{`   ██    ▄▄   ██`}</Text>
      <Text color={Cyan}>{`   ██   ████  ██     🐋 Hraness`}</Text>
      <Text color={Cyan}>{`    ██▄▄▄▄▄▄▄▄██     DeepSeek Code v0.4`}</Text>
      <Text color={Dim}>{`      ▀▀▀▀▀▀▀▀`}</Text>
    </Box>
  )
}

/** Variant 2: 声呐脉冲 — 圆形波纹扩散 */
export function SonarPulse() {
  return (
    <Box flexDirection="column">
      <Text color={Dim}>{`              ░░░░░░░░`}</Text>
      <Text color={Dim}>{`           ░░▒▒▒▒▒▒▒▒░░`}</Text>
      <Text color={Blue}>{`         ░▒▓▓▓▓▓▓▓▓▓▓▒░`}</Text>
      <Text color={Cyan}>{`       ░▒▓▓▓▓████▓▓▓▓▒░       ░▒▓▓▓▓████▓▓▓▓▒░       Hraness`}</Text>
      <Text color={Cyan}>{`        ░▒▓▓▓▓▓▓▓▓▓▓▒░        DeepSeek Code v0.4`}</Text>
      <Text color={Blue}>{`          ░▒▒▒▒▒▒▒▒░`}</Text>
      <Text color={Dim}>{`            ░░░░░░`}</Text>
    </Box>
  )
}

/** Variant 3: 深海虎鲸侧影 — 完整鲸鱼剪影 */
export function OrcaSilhouette() {
  return (
    <Box flexDirection="column">
      <Text color={Cyan}>{`            ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄`}</Text>
      <Text color={Cyan}>{`         ▄██████████████████████▄▄`}</Text>
      <Text color={Blue}>{`       ▄█▀▀▀██████████▀▀▀▀▀▀█████▄`}</Text>
      <Text color={White}>{`     ▄█▀    ██████████        ▀▀███▄`}</Text>
      <Text color={White}>{`    ██      ██████████▌          ████`}</Text>
      <Text color={Blue}>{`   ██       ██████████▌          ▐███`}</Text>
      <Text color={Blue}>{`   ██       ██████████▌           ███`}</Text>
      <Text color={Cyan}>{`   ██      ▄██████████▄           ███`}</Text>
      <Text color={Cyan}>{`   ██     ██████████████          ███`}</Text>
      <Text color={Blue}>{`    ██▄  ████████████████        ▄██`}</Text>
      <Text color={Blue}>{`     ▀█████████████████████▄▄▄▄▄██▀`}</Text>
      <Text color={Cyan}>{`       ▀▀███████████████████████▀▀`}</Text>
    </Box>
  )
}

/** Variant 4: 虎鲸尾鳍出水 — 只露出尾部, 动态感 */
export function TailFin() {
  return (
    <Box flexDirection="column">
      <Text color={Teal}>{`                ▐▛███▌`}</Text>
      <Text color={Teal}>{`              ▐███████▌`}</Text>
      <Text color={Cyan}>{`            ▄███████████▌`}</Text>
      <Text color={Cyan}>{`          ▄█████████████▌`}</Text>
      <Text color={Blue}>{`        ▄███████████████▌`}</Text>
      <Text color={Blue}>{`     ▄▄█████████████████▌`}</Text>
      <Text color={White}>{`  ▄█████████████████████▌`}</Text>
      <Text color={White}>{`  ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀`}</Text>
      <Text color={Dim}>{`  ░░░░░░░░░░░░░░░░░░░░░░  深海之下，声呐先行`}</Text>
      <Text> </Text>
      <Text color={Cyan}>{`  🐋 DeepSeek Code v0.3.0`}</Text>
      <Text color={Dim}>{`  Sonar Pulse · Swarm Concurrency · Cold Memory`}</Text>
    </Box>
  )
}

/** Variant 5: 抽象声呐波 — 纯字符艺术, 最小化 */
export function MinimalSonar() {
  return (
    <Box flexDirection="column">
      <Text color={Dim}>{`         ╭─ ◦ ◌ ○ ◎ ○ ◌ ◦ ─╮`}</Text>
      <Text color={Blue}>{`        ╭┤  🐋 DeepSeek Code  ├╮`}</Text>
      <Text color={Cyan}>{`       ╭┤   v0.3.0 · hraness  ├╮`}</Text>
      <Text color={Cyan}>{`      ╭┤    sonar · swarm      ├╮`}</Text>
      <Text color={Blue}>{`      ╰─────────────────────────╯`}</Text>
      <Text> </Text>
      <Text color={Dim}>{`      ∿∿∿ ripple · think · verify ∿∿∿`}</Text>
    </Box>
  )
}

/** Show all variants side by side for comparison */
export function ShowAllLogos() {
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color={White}>Hraness Logo 方案选择</Text>
      <Text color={Dim}>──────────────────────────────────────────────</Text>
      <Text> </Text>
      <Text bold color={Cyan}>方案 A: 几何尾鳍 (Geometric Fin)</Text>
      <GeometricFin />
      <Text> </Text>
      <Text color={Dim}>──────────────────────────────────────────────</Text>
      <Text bold color={Cyan}>方案 B: 声呐脉冲 (Sonar Pulse)</Text>
      <SonarPulse />
      <Text> </Text>
      <Text color={Dim}>──────────────────────────────────────────────</Text>
      <Text bold color={Cyan}>方案 C: 深海虎鲸侧影 (Orca Silhouette)</Text>
      <OrcaSilhouette />
      <Text> </Text>
      <Text color={Dim}>──────────────────────────────────────────────</Text>
      <Text bold color={Cyan}>方案 D: 尾鳍出水 (Tail Fin)</Text>
      <TailFin />
      <Text> </Text>
      <Text color={Dim}>──────────────────────────────────────────────</Text>
      <Text bold color={Cyan}>方案 E: 抽象声呐波 (Minimal Sonar)</Text>
      <MinimalSonar />
    </Box>
  )
}
