/** Orcana TUI — 深海虎鲸启动画面
 *
 *  Logo A: 几何尾鳍 (Geometric Fin)
 *  动画 D: 尾鳍出水 (Tail Fin) — 4帧上升, 100ms/帧
 *  状态栏 E: 抽象声呐波 (Minimal Sonar)
 *  气泡: · ◦ ○ ◌ 浮动动画
 *  配色: Nord 极光蓝
 */

import React, { useState, useEffect } from "react"
import { render, Box, Text } from "ink"
import { GeometricFin } from "./logo"
import { VERSION_LABEL } from "../version"

// ── 气泡动画 ──

const BUBBLE_CHARS = ["·", "◦", "○", "◌", "◌", "○", "◦", "·"]
const BUBBLE_COLS = [3, 22, 42, 8, 34, 48, 14, 38, 5, 28]

function Bubbles({ frame }: { frame: number }) {
  return (
    <Text>
      {BUBBLE_COLS.map((col, i) => {
        const idx = (frame + i * 3) % BUBBLE_CHARS.length
        return (
          <React.Fragment key={i}>
            {" ".repeat(Math.max(0, col - (i > 0 ? BUBBLE_COLS[i - 1]! + 1 : 0)))}
            <Text color={idx < 3 ? "#88C0D0" : "#616E88"}>{BUBBLE_CHARS[idx]}</Text>
          </React.Fragment>
        )
      })}
    </Text>
  )
}

// ── 尾鳍出水帧 ──

const TAIL_FIN_FRAMES = [
  // 4帧, 从下往上露出更多
  [
    `                                                    `,
    `                                                    `,
    `                                                    `,
    `                ▐▛███▌                               `,
    `              ▐███████▌                              `,
    `  ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀                             `,
  ],
  [
    `                                                    `,
    `                                                    `,
    `                ▐▛███▌                               `,
    `              ▐███████▌                              `,
    `            ▄███████████▌                            `,
    `          ▄█████████████▌                            `,
    `  ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀                   `,
  ],
  [
    `                ▐▛███▌                               `,
    `              ▐███████▌                              `,
    `            ▄███████████▌                            `,
    `          ▄█████████████▌                            `,
    `        ▄███████████████▌                            `,
    `     ▄▄█████████████████▌                            `,
    `  ▄█████████████████████▌                            `,
    `  ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀   `,
  ],
  [
    `                ▐▛███▌                               `,
    `              ▐███████▌                              `,
    `            ▄███████████▌                            `,
    `          ▄█████████████▌                            `,
    `        ▄███████████████▌                            `,
    `     ▄▄█████████████████▌                            `,
    `  ▄█████████████████████▌                            `,
    `  ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀   `,
    `  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   `,
  ],
]

// ── 启动状态机: 0=上升, 1=Logo, 2=Ready ──
type SplashPhase = "rise" | "logo" | "ready"

// ── 启动画面 ──

function SplashScreen({ frame }: { frame: number }) {
  const phase: SplashPhase = frame < 6 ? "rise" : frame < 14 ? "logo" : "ready"
  const tailIdx = Math.min(Math.floor(frame / 1.5), 3)

  return (
    <Box flexDirection="column" paddingTop={2} paddingLeft={3} paddingRight={3}>
      {/* 气泡层 */}
      <Box height={1} marginBottom={1}>
        <Bubbles frame={frame} />
      </Box>

      {phase === "rise" && (
        <Box flexDirection="column">
          {TAIL_FIN_FRAMES[tailIdx]!.map((line, i) => (
            <Text key={i} color={i < 2 ? "#616E88" : i < 5 ? "#81A1C1" : i < 7 ? "#88C0D0" : "#D8DEE9"}>{line}</Text>
          ))}
          <Box height={1} />
          <Text color="#616E88">  Surfacing...</Text>
        </Box>
      )}

      {phase === "logo" && (
        <>
          {TAIL_FIN_FRAMES[3]!.map((line, i) => (
            <Text key={i} color={i < 2 ? "#616E88" : i < 5 ? "#81A1C1" : i < 7 ? "#88C0D0" : i === 8 ? "#616E88" : "#D8DEE9"}>{line}</Text>
          ))}
          <Box height={1} />
          <GeometricFin />
          <Box height={1} />
          <Text color="#88C0D0">  Initializing sonar...</Text>
        </>
      )}

      {phase === "ready" && (
        <>
          <Box height={1} />
          {/* 状态栏 E: 抽象声呐波 */}
          <Text color="#616E88">{`  ╭─ ◦ ◌ ○ ◎ ○ ◌ ◦ ────────────────────────────────╮`}</Text>
          <Text color="#88C0D0">{`  │  🐋 Orcana ${VERSION_LABEL} · hraness               │`}</Text>
          <Text color="#D8DEE9">{`  ╰──────────────────────────────────────────────────╯`}</Text>
          <Box height={1} />
          <GeometricFin />
          <Box height={1} />
          <Text bold color="#88C0D0">{`  🐋 Orcana ${VERSION_LABEL} — Hraness`}</Text>
          <Box height={1} />
          <Text color="#81A1C1">  深海之下，声呐先行。Sonar first, strike once.</Text>
          <Box height={1} />
          <Box flexDirection="row">
            <Text color="#88C0D0">  ripple</Text><Text color="#616E88"> · </Text>
            <Text color="#81A1C1">think</Text><Text color="#616E88"> · </Text>
            <Text color="#B48EAD">verify</Text><Text color="#616E88"> · </Text>
            <Text color="#EBCB8B">checkpoint</Text><Text color="#616E88"> · </Text>
            <Text color="#A3BE8C">resume</Text>
          </Box>
          <Box height={1} />
          <Text color="#4C566A">  ══════════════════════════════════════════════════════</Text>
          <Box height={1} />
          <Text color="#D8DEE9">  Ready. Type your request or /help to get started.</Text>
        </>
      )}
    </Box>
  )
}

// ── 主 App — 14帧动画后稳定 ──

export function App() {
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    if (frame >= 14) return
    const timer = setTimeout(() => setFrame(f => f + 1), 100)
    return () => clearTimeout(timer)
  }, [frame])

  return <SplashScreen frame={frame} />
}

export function startInkApp() {
  const { waitUntilExit } = render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
  return waitUntilExit()
}
