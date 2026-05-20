import React, { useMemo } from 'react'
import { Box, Text } from 'ink'
import type { StarPhase } from '../agent/star-event.js'
import type { AlchemyStage } from './alchemy-bar.js'
import type { AvatarContext, AvatarMode, AvatarMood, DomainId } from './avatar/types.js'
import { renderAvatar } from './avatar/avatar-renderer.js'
import { renderConstellationVertical, getActiveStarIndex } from './constellation.js'
import { PHASE_LABELS, PHASE_GLYPHS } from '../agent/star-event.js'
import { alchemyBar, alchemyStage } from './alchemy-bar.js'
import { MODE_COLORS, PANEL_BORDER, PHASE_LABEL, RADIO_TEXT, ACTIVE_STAR_GLOW, FAR_STAR_GRAY, CONSTELLATION_LINE } from './star-panel-colors.js'

/**
 * 紫微星桥 — 侧边星图面板
 *
 * 国风设计：
 * - 星君 Avatar（印章冠 + kaomoji 面 + 中国礼仪手势）
 * - 纵向七星连线（北斗七星在北方，纵向如天梯）
 * - 炼金五行进度条
 * - 无线电消息流
 */

export interface StarPanelProps {
  /** 当前星相位 */
  activePhase: StarPhase
  /** 感官数据 */
  sensorium: {
    confidence: number
    momentum: number
    complexity: number
    freshness: number
  }
  /** 当前回合数 */
  turnCount: number
  /** 最大回合数 */
  maxTurns?: number
  /** 最近的无线电消息 */
  recentRadio?: string[]
  /** 星域 */
  domain?: DomainId
  /** 是否卡住 */
  isStuck?: boolean
  /** 测试失败次数 */
  testFailing?: number
  /** 空闲秒数 */
  idleSeconds?: number
  /** 动画 tick */
  tick?: number
}

/**
 * 感官仪表组件 — 六维数据显示
 */
function SensoriumGauges({ sensorium }: { sensorium: StarPanelProps['sensorium'] }) {
  const gauges = [
    { label: '动力', value: sensorium.momentum, color: '#34d399' },
    { label: '信心', value: sensorium.confidence, color: '#818cf8' },
    { label: '复杂', value: sensorium.complexity, color: '#f59e0b' },
    { label: '新鲜', value: sensorium.freshness, color: '#22d3ee' },
  ]

  return (
    <Box flexDirection="column" marginY={1}>
      <Text color={PHASE_LABEL}>感官仪表</Text>
      {gauges.map(g => (
        <Box key={g.label}>
          <Text color={g.color}>{g.label} </Text>
          <Text>{'⣿'.repeat(Math.round(g.value * 5))}{'⣀'.repeat(5 - Math.round(g.value * 5))}</Text>
        </Box>
      ))}
    </Box>
  )
}

/**
 * 炼金进度条组件
 */
function AlchemyProgress({ confidence, turnCount, maxTurns }: {
  confidence: number
  turnCount: number
  maxTurns: number
}) {
  const stage = alchemyStage(confidence)
  const bar = alchemyBar(confidence)

  return (
    <Box flexDirection="column" marginY={1}>
      <Text color={PHASE_LABEL}>炼金进度</Text>
      <Text>
        {bar} │ T{turnCount}/{maxTurns}
      </Text>
    </Box>
  )
}

/**
 * 无线电消息流组件
 */
function RadioFeed({ messages }: { messages: string[] }) {
  if (messages.length === 0) return null

  return (
    <Box flexDirection="column" marginY={1}>
      <Text color={RADIO_TEXT}>📡 电报</Text>
      {messages.slice(-3).map((msg, i) => (
        <Text key={i} color={RADIO_TEXT} wrap="truncate">
          {msg}
        </Text>
      ))}
    </Box>
  )
}

/**
 * 紫微星桥主组件
 *
 * 布局结构：
 * 1. 星君 Avatar（印章冠 + kaomoji + 手势）
 * 2. 纵向七星连线
 * 3. 感官仪表
 * 4. 炼金进度条
 * 5. 无线电消息流
 */
export function StarPanel({
  activePhase,
  sensorium,
  turnCount,
  maxTurns = 50,
  recentRadio = [],
  domain = null,
  isStuck = false,
  testFailing = 0,
  idleSeconds = 0,
  tick = 1,
}: StarPanelProps) {
  // 构建 Avatar 上下文
  const avatarCtx: AvatarContext = useMemo(() => ({
    phase: activePhase,
    alchemy: alchemyStage(sensorium.confidence),
    domain,
    mood: 'calm' as AvatarMood, // 渲染器会覆盖
    mode: (activePhase === 'yuheng-implementing' || activePhase === 'kaiyang-testing'
      ? 'wuxing' : 'wenxing') as AvatarMode,
    tick,
    isStuck,
    isTestFailing: testFailing,
    idleSeconds,
  }), [activePhase, sensorium.confidence, domain, isStuck, testFailing, idleSeconds, tick])

  // 渲染 Avatar
  const avatar = useMemo(() => renderAvatar(avatarCtx), [avatarCtx])

  // 渲染纵向七星
  const constellationLines = useMemo(
    () => renderConstellationVertical(activePhase),
    [activePhase],
  )

  // 活跃星索引
  const activeIdx = useMemo(() => getActiveStarIndex(activePhase), [activePhase])

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={PANEL_BORDER}
      paddingX={1}
      width={20}
    >
      {/* 标题 */}
      <Box justifyContent="center">
        <Text color={MODE_COLORS[avatar.mode]} bold>
          紫微星桥
        </Text>
      </Box>

      {/* 星君 Avatar */}
      <Box flexDirection="column" marginY={1}>
        {avatar.lines.map((line, i) => (
          <Text key={i} color={MODE_COLORS[avatar.mode]}>
            {line}
          </Text>
        ))}
      </Box>

      {/* 分隔线 */}
      <Text color={PANEL_BORDER}>────────────</Text>

      {/* 纵向七星 */}
      <Box flexDirection="column" marginY={1}>
        {constellationLines.map((line, i) => (
          <Text
            key={i}
            color={i % 2 === 0 ? (Math.floor(i / 2) === activeIdx ? ACTIVE_STAR_GLOW : FAR_STAR_GRAY) : CONSTELLATION_LINE}
          >
            {line}
          </Text>
        ))}
      </Box>

      {/* 分隔线 */}
      <Text color={PANEL_BORDER}>────────────</Text>

      {/* 感官仪表 */}
      <SensoriumGauges sensorium={sensorium} />

      {/* 炼金进度 */}
      <AlchemyProgress
        confidence={sensorium.confidence}
        turnCount={turnCount}
        maxTurns={maxTurns}
      />

      {/* 分隔线 */}
      <Text color={PANEL_BORDER}>────────────</Text>

      {/* 无线电消息 */}
      <RadioFeed messages={recentRadio} />

      {/* 底部快捷键提示 */}
      <Box justifyContent="center" marginTop={1}>
        <Text color="#64748b" dimColor>
          Esc=折叠
        </Text>
      </Box>
    </Box>
  )
}
