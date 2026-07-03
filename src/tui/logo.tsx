/** Orcana logo variants — 深海虎鲸 / Sonar Orca theme（Phase 8 rebrand）。
 *  Phase 8: 硬编码 hex → theme.* 迁移。保留5套logo方案不变。 */

import React from "react"
import { Box, Text } from "ink"
import { theme } from "../tui/theme/theme"
import { VERSION_LABEL } from "../version"

/** Variant 1: 几何尾鳍 — 极简现代 ASCII */
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

/** Variant 2: 声呐脉冲 — 圆形波纹扩散 */
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

/** Variant 3: 深海虎鲸侧影 — 完整鲸鱼剪影 */
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

/** Variant 4: 虎鲸尾鳍出水 — 只露出尾部, 动态感 */
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

/** Variant 5: 抽象声呐波 — 纯字符艺术, 最小化 */
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

/** Show all variants side by side for comparison */
export function ShowAllLogos() {
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color={theme.text}>Orcana Logo 方案选择</Text>
      <Text color={theme.textFaint}>──────────────────────────────────────────────</Text>
      <Text> </Text>
      <Text bold color={theme.brand}>方案 A: 几何尾鳍 (Geometric Fin)</Text>
      <GeometricFin />
      <Text> </Text>
      <Text color={theme.textFaint}>──────────────────────────────────────────────</Text>
      <Text bold color={theme.brand}>方案 B: 声呐脉冲 (Sonar Pulse)</Text>
      <SonarPulse />
      <Text> </Text>
      <Text color={theme.textFaint}>──────────────────────────────────────────────</Text>
      <Text bold color={theme.brand}>方案 C: 深海虎鲸侧影 (Orca Silhouette)</Text>
      <OrcaSilhouette />
      <Text> </Text>
      <Text color={theme.textFaint}>──────────────────────────────────────────────</Text>
      <Text bold color={theme.brand}>方案 D: 尾鳍出水 (Tail Fin)</Text>
      <TailFin />
      <Text> </Text>
      <Text color={theme.textFaint}>──────────────────────────────────────────────</Text>
      <Text bold color={theme.brand}>方案 E: 抽象声呐波 (Minimal Sonar)</Text>
      <MinimalSonar />
    </Box>
  )
}
