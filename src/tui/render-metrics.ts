/** render-metrics — P1 性能基线与 render 门禁 instrumentation。
 *
 *  仅在 ORCANA_TUI_PROFILE=1 时记录，正式 UI 零开销（布尔短路）。
 *
 *  指标：
 *    - appShellRenders      AppShell 渲染次数
 *    - transcriptRenders    Scrollback/TranscriptViewport 渲染次数
 *    - messageFormats       FormattedLineCache 实际重算次数（miss 数）
 *    - selectorNotifications useTuiSelector 快照求值次数
 *    - activeTimers         当前存活的自建定时器（setInterval/setTimeout 包装）
 */

export function profilingEnabled(): boolean {
  return process.env.ORCANA_TUI_PROFILE === "1"
}

export interface RenderMetricsSnapshot {
  appShellRenders: number
  transcriptRenders: number
  messageFormats: number
  selectorNotifications: number
  activeTimers: number
}

let appShellRenders = 0
let transcriptRenders = 0
let messageFormats = 0
let selectorNotifications = 0
const activeTimerIds = new Set<unknown>()

export const renderMetrics = {
  incAppShellRender(): void {
    if (!profilingEnabled()) return
    appShellRenders++
  },
  incTranscriptRender(): void {
    if (!profilingEnabled()) return
    transcriptRenders++
  },
  incMessageFormat(): void {
    if (!profilingEnabled()) return
    messageFormats++
  },
  incSelectorNotification(): void {
    if (!profilingEnabled()) return
    selectorNotifications++
  },
  /** 登记一个存活定时器（渲染门禁：idle 2s → activeTimers = 0）。 */
  trackTimer(id: unknown): void {
    if (!profilingEnabled()) return
    activeTimerIds.add(id)
  },
  untrackTimer(id: unknown): void {
    if (!profilingEnabled()) return
    activeTimerIds.delete(id)
  },
  activeTimerCount(): number {
    return profilingEnabled() ? activeTimerIds.size : 0
  },
  snapshot(): RenderMetricsSnapshot {
    return {
      appShellRenders,
      transcriptRenders,
      messageFormats,
      selectorNotifications,
      activeTimers: activeTimerIds.size,
    }
  },
  reset(): void {
    appShellRenders = 0
    transcriptRenders = 0
    messageFormats = 0
    selectorNotifications = 0
    activeTimerIds.clear()
  },
}

/** 进程退出时输出指标（仅 ORCANA_TUI_PROFILE=1）。 */
export function installProfileReporter(): void {
  if (!profilingEnabled()) return
  process.on("exit", () => {
    const s = renderMetrics.snapshot()
    // eslint-disable-next-line no-console
    console.error(
      `[tui-profile] renders app=${s.appShellRenders} transcript=${s.transcriptRenders} ` +
        `formats=${s.messageFormats} selectorEvals=${s.selectorNotifications} timers=${s.activeTimers}`,
    )
  })
}
