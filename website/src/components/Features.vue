<script setup lang="ts">
import { Monitor, Network, Puzzle, Shield, Sparkles, Users, Zap } from 'lucide-vue-next'
import Button from '@/components/ui/Button.vue'
import { useI18n } from '@/composables/useI18n'

const { t } = useI18n()

const features = [
  { icon: Zap, titleKey: 'feature.cache.title', descKey: 'feature.cache.desc', color: 'from-amber-500/20 to-orange-500/20' },
  { icon: Network, titleKey: 'feature.router.title', descKey: 'feature.router.desc', color: 'from-blue-500/20 to-cyan-500/20' },
  { icon: Users, titleKey: 'feature.agent.title', descKey: 'feature.agent.desc', color: 'from-emerald-500/20 to-teal-500/20' },
  { icon: Shield, titleKey: 'feature.security.title', descKey: 'feature.security.desc', color: 'from-rose-500/20 to-pink-500/20' },
  { icon: Puzzle, titleKey: 'feature.mcp.title', descKey: 'feature.mcp.desc', color: 'from-violet-500/20 to-purple-500/20' },
  { icon: Monitor, titleKey: 'feature.desktop.title', descKey: 'feature.desktop.desc', color: 'from-indigo-500/20 to-fuchsia-500/20' },
]
</script>

<template>
  <section id="features" class="relative overflow-hidden bg-bg-primary px-6 py-24 lg:py-32">
    <div class="pointer-events-none absolute inset-0">
      <div class="absolute inset-0 bg-[radial-gradient(ellipse_60%_50%_at_50%_50%,rgba(99,102,241,0.18),transparent)]" />
      <div class="absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,rgba(168,85,247,0.08),transparent_50%)]" />
    </div>

    <div class="relative mx-auto max-w-7xl">
      <div class="grid min-h-[700px] items-center gap-12 lg:grid-cols-2">
        <!-- Left: central copy -->
        <div class="relative z-10 mx-auto max-w-lg text-center lg:mx-0 lg:text-left">
          <div class="mb-6 inline-flex items-center gap-2 rounded-full border border-accent/30 bg-accent/10 px-4 py-1.5 text-sm text-accent-glow">
            <Sparkles class="h-4 w-4" />
            {{ t('features.badge') }}
          </div>
          <h2 class="mb-6 text-4xl font-bold tracking-tight text-white md:text-5xl lg:text-6xl">
            {{ t('features.title') }}
          </h2>
          <p class="mb-8 text-lg text-white/60">
            {{ t('features.desc') }}
          </p>
          <Button
            size="lg"
            href="#download"
            class="h-12 rounded-full bg-accent px-8 text-base text-white hover:bg-accent/90"
          >
            {{ t('hero.cta_download') }}
          </Button>
        </div>

        <!-- Right: circular card layout -->
        <div class="relative mt-12 flex h-[520px] w-full items-center justify-center sm:h-[600px] lg:mt-20 lg:h-[680px]">
          <!-- Orbit rings -->
          <div class="absolute h-[260px] w-[260px] rounded-full border border-white/5 sm:h-[340px] sm:w-[340px] lg:h-[420px] lg:w-[420px]" />
          <div class="absolute h-[380px] w-[380px] rounded-full border border-white/5 sm:h-[480px] sm:w-[480px] lg:h-[560px] lg:w-[560px]" />
          <div class="absolute h-[480px] w-[480px] rounded-full border border-white/5 sm:h-[580px] sm:w-[580px] lg:h-[640px] lg:w-[640px]" />

          <!-- Center glow -->
          <div class="absolute h-40 w-40 rounded-full bg-accent/15 blur-[80px] sm:h-48 sm:w-48" />

          <!-- Cards placed on a circle -->
          <div
            v-for="(feature, index) in features"
            :key="feature.titleKey"
            class="absolute left-1/2 top-1/2 w-36 -translate-x-1/2 -translate-y-1/2 sm:w-40 lg:w-44"
            :style="{
              transform: `translate(-50%, -50%) translate(calc(${Math.cos((index * 60 - 90) * Math.PI / 180).toFixed(6)} * var(--feature-orbit-r)), calc(${Math.sin((index * 60 - 90) * Math.PI / 180).toFixed(6)} * var(--feature-orbit-r)))`,
            }"
          >
            <div class="group relative overflow-hidden rounded-2xl border border-white/10 bg-bg-secondary/80 p-4 shadow-xl shadow-black/20 backdrop-blur-xl transition-all duration-300 hover:-translate-y-1 hover:border-accent/30 hover:bg-bg-secondary">
              <div :class="['absolute inset-0 bg-gradient-to-br', feature.color, 'opacity-0 transition-opacity group-hover:opacity-100']" />
              <div class="relative">
                <div class="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-white/10 text-accent-glow transition-colors group-hover:bg-accent group-hover:text-white">
                  <component :is="feature.icon" class="h-5 w-5" />
                </div>
                <h3 class="mb-1 text-sm font-semibold text-white">{{ t(feature.titleKey) }}</h3>
                <p class="text-xs leading-relaxed text-white/50 line-clamp-3">{{ t(feature.descKey) }}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
