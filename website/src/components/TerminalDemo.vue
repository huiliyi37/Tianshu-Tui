<script setup lang="ts">
import { ref, watch, onUnmounted } from 'vue'
import { useScrollAnimation } from '@/composables/useScrollAnimation'
import { useI18n } from '@/composables/useI18n'

interface Line {
  type: 'input' | 'output' | 'tool' | 'success'
  text: string
}

const demoScript: Line[] = [
  { type: 'input', text: 'rivet /goal 重构认证模块，全面使用 async/await' },
  { type: 'output', text: '🚀 Goal set: 重构认证模块，全面使用 async/await' },
  { type: 'tool', text: 'read: src/auth.ts (unchanged, cached ref)' },
  { type: 'tool', text: 'read: src/middleware.ts (unchanged, cached ref)' },
  { type: 'output', text: 'Plan: 1) 提取 token 验证为 async 函数  2) 更新中间件  3) 跑测试' },
  { type: 'tool', text: 'edit: src/auth.ts  (+12/-8 lines)' },
  { type: 'tool', text: 'edit: src/middleware.ts  (+6/-4 lines)' },
  { type: 'tool', text: 'run: npm test' },
  { type: 'success', text: '✅ 42 passed' },
  { type: 'output', text: '✅ 完成。缓存命中率 98%，未触发审批。' },
]

const lines = ref<Line[]>([])
const currentLineIndex = ref(0)
const currentCharIndex = ref(0)
const isPaused = ref(false)
const { ref: scrollRef, isVisible } = useScrollAnimation(0.1)
const { t } = useI18n()

let timer: ReturnType<typeof setTimeout> | null = null

function clearTimer() {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}

function tick() {
  clearTimer()

  if (isPaused.value) {
    timer = setTimeout(tick, 100)
    return
  }

  if (currentLineIndex.value >= demoScript.length) {
    timer = setTimeout(() => {
      lines.value = []
      currentLineIndex.value = 0
      currentCharIndex.value = 0
    }, 4000)
    return
  }

  const currentLine = demoScript[currentLineIndex.value]
  const fullText = currentLine.text

  if (currentCharIndex.value < fullText.length) {
    timer = setTimeout(() => {
      currentCharIndex.value += 1
      tick()
    }, currentLine.type === 'input' ? 30 : 12)
  } else {
    timer = setTimeout(() => {
      lines.value = [...lines.value, currentLine]
      currentLineIndex.value += 1
      currentCharIndex.value = 0
      tick()
    }, currentLine.type === 'output' ? 1000 : 600)
  }
}

watch(isVisible, (visible) => {
  if (visible && lines.value.length === 0 && currentLineIndex.value === 0 && currentCharIndex.value === 0) {
    tick()
  }
})

onUnmounted(() => {
  clearTimer()
})

function lineColor(type: Line['type']) {
  switch (type) {
    case 'input':
      return 'text-accent-glow'
    case 'tool':
      return 'text-accent-cyan'
    case 'success':
      return 'text-success'
    default:
      return 'text-text-secondary'
  }
}
</script>

<template>
  <section id="demo" class="relative bg-bg-secondary px-4 sm:px-6 py-16 sm:py-24">
    <div class="pointer-events-none absolute inset-0 bg-glow opacity-30" />

    <div
      ref="scrollRef"
      :class="['relative mx-auto max-w-4xl animate-on-scroll', isVisible ? 'visible' : '']"
    >
      <div class="mb-8 sm:mb-12 text-center">
        <h2 class="mb-3 sm:mb-4 text-2xl sm:text-3xl font-bold tracking-tight md:text-5xl">
          {{ t('demo.title') }}
        </h2>
        <p class="mx-auto max-w-2xl text-base sm:text-lg text-text-secondary">
          {{ t('demo.desc') }}
        </p>
      </div>

      <div
        class="relative shine-border overflow-hidden rounded-xl sm:rounded-2xl border border-white/10 bg-bg-primary shadow-2xl shadow-accent/5"
        @mouseenter="isPaused = true"
        @mouseleave="isPaused = false"
      >
        <!-- Window title bar -->
        <div class="flex items-center gap-2 border-b border-white/10 bg-bg-tertiary px-3 sm:px-4 py-2 sm:py-3">
          <div class="h-2.5 w-2.5 sm:h-3 sm:w-3 rounded-full bg-danger" />
          <div class="h-2.5 w-2.5 sm:h-3 sm:w-3 rounded-full bg-warning" />
          <div class="h-2.5 w-2.5 sm:h-3 sm:w-3 rounded-full bg-success" />
          <span class="ml-2 text-xs text-text-secondary font-mono">rivet — tianshu</span>
          <span class="ml-auto text-xs text-text-secondary">{{ t('demo.hover_pause') }}</span>
        </div>

        <!-- Terminal content -->
        <div
          class="terminal-scroll h-[280px] sm:h-[360px] overflow-y-auto p-4 sm:p-5 md:h-[420px] md:p-6"
        >
          <div
            v-for="(line, index) in lines"
            :key="`${line.text}-${index}`"
            class="font-mono text-base leading-relaxed md:text-lg"
          >
            <span :class="lineColor(line.type)">{{ line.text }}</span>
          </div>
          <div
            v-if="currentLineIndex < demoScript.length"
            class="font-mono text-base leading-relaxed md:text-lg"
          >
            <span :class="lineColor(demoScript[currentLineIndex].type)">
              {{ demoScript[currentLineIndex].text.slice(0, currentCharIndex) }}
            </span>
            <span class="ml-0.5 inline-block h-5 w-2 animate-pulse bg-accent align-text-bottom md:h-6" />
          </div>
        </div>
        <!-- Scan line overlay -->
        <div
          class="pointer-events-none absolute inset-0 overflow-hidden rounded-xl sm:rounded-2xl"
          aria-hidden="true"
        >
          <div
            class="absolute inset-0 animate-scan-line"
            :style="{
              background: 'linear-gradient(to bottom, transparent 45%, rgba(34, 211, 238, 0.03) 50%, transparent 55%)',
              height: '200%',
            }"
          />
        </div>
      </div>
    </div>
  </section>
</template>
