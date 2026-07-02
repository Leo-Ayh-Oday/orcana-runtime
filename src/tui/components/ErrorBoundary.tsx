/** ErrorBoundary — 捕获 React 渲染错误，防止 TUI 崩溃后无反馈。
 *
 *  生产级 TUI 要求：任何组件渲染抛错时，用户应看到错误信息而非黑屏。
 *  Ink 不提供内置 ErrorBoundary，这里用 React class component 实现。
 *
 *  错误显示后用户可按 Ctrl+C 退出，或按任意键尝试恢复（重新渲染）。
 */

import React from "react"
import { Box, Text } from "ink"
import { C } from "../theme/theme"

interface ErrorBoundaryProps {
  children: React.ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
  errorMessage: string
  errorStack?: string
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, errorMessage: "" }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error.message || String(error),
      errorStack: error.stack?.split("\n").slice(0, 3).join("\n"),
    }
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // 输出到 stderr，不影响 Ink 渲染
    process.stderr.write(`[TUI Render Error] ${error.message}\n`)
    if (info.componentStack) {
      process.stderr.write(`Component stack: ${info.componentStack}\n`)
    }
  }

  override render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text color={C.red} bold>TUI Render Error</Text>
          <Text color={C.dim}> </Text>
          <Text color={C.red}>{this.state.errorMessage}</Text>
          {this.state.errorStack && (
            <Box marginTop={1}>
              <Text color={C.dim}>{this.state.errorStack}</Text>
            </Box>
          )}
          <Text color={C.dim}> </Text>
          <Text color={C.dim}>Press Ctrl+C to exit. The error has been logged to stderr.</Text>
        </Box>
      )
    }
    return this.props.children
  }
}
