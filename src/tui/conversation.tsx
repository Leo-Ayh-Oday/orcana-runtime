/** Conversation view — connects agentLoop to Ink rendering */
import React, { useState, useEffect, useRef, useCallback } from "react"
import { Box, Text } from "ink"

const Cyan = "#88C0D0"
const Blue = "#81A1C1"
const White = "#D8DEE9"
const Dim = "#616E88"
const Yellow = "#EBCB8B"
const Green = "#A3BE8C"
const Red = "#BF616A"
const Border = "#4C566A"

export interface Message {
  role: "user" | "assistant" | "system"
  content: string
  timestamp: number
}

export interface ToolEvent {
  id: string
  name: string
  status: "running" | "done" | "error"
  detail: string
}

export interface StatusData {
  model: string
  round: number
  contextTokens: number
  contextMax: number
  cacheHitRate: number
  toolCount: number
}

interface Props {
  messages: Message[]
  streamingText: string
  toolEvents: ToolEvent[]
  status: StatusData
  inputValue: string
  onInputChange: (value: string) => void
  onSubmit: () => void
}

export function ConversationView({ messages, streamingText, toolEvents, status, inputValue, onInputChange, onSubmit }: Props) {
  return (
    <Box flexDirection="column">
      {/* Status bar */}
      <Box flexDirection="row" height={1}>
        <Text color={Cyan}>🐋 Orcana v0.4</Text>
        <Text color={Dim}>{"  │  "}</Text>
        <Text color={Blue}>{status.model}</Text>
        <Text color={Dim}>{"  │  "}</Text>
        <Text color={White}>Round {status.round}</Text>
        <Text color={Dim}>{"  │  "}</Text>
        <Text color={Cyan}>Context: {Math.round(status.contextTokens / 1000)}K/{Math.round(status.contextMax / 1000)}K</Text>
        <Text color={Dim}>{"  │  "}</Text>
        <Text color={status.cacheHitRate > 80 ? Green : Yellow}>Cache: {status.cacheHitRate}%</Text>
      </Box>

      <Text color={Border}>{"═".repeat(80)}</Text>

      {/* Messages */}
      <Box flexDirection="column" height={20}>
        {messages.slice(-15).map((msg, i) => (
          <Box key={i} flexDirection="row">
            <Text color={msg.role === "user" ? Blue : msg.role === "system" ? Yellow : White}>
              {msg.role === "user" ? "> " : msg.role === "system" ? "[sys] " : "  "}
            </Text>
            <Text color={msg.role === "system" ? Dim : White}>
              {msg.content.slice(-200)}
            </Text>
          </Box>
        ))}

        {/* Streaming text */}
        {streamingText && (
          <Box flexDirection="row">
            <Text color={Cyan}>  </Text>
            <Text>{streamingText.slice(-500)}</Text>
          </Box>
        )}
      </Box>

      {/* Tool events */}
      {toolEvents.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={Dim}>── Tools ──</Text>
          {toolEvents.slice(-5).map((ev, i) => (
            <Box key={i} flexDirection="row">
              <Text color={ev.status === "done" ? Green : ev.status === "error" ? Red : Yellow}>
                {ev.status === "running" ? "⏳" : ev.status === "done" ? "✅" : "❌"}
              </Text>
              <Text color={Cyan}>{" "}{ev.name}</Text>
              <Text color={Dim}>{" "}{ev.detail.slice(0, 60)}</Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  )
}
