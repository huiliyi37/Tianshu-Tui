<script setup lang="ts">
import { ref } from 'vue'
import { ChevronDown } from 'lucide-vue-next'
import Card from '@/components/ui/Card.vue'
import CardContent from '@/components/ui/CardContent.vue'
import { useScrollAnimation } from '@/composables/useScrollAnimation'
import { useI18n } from '@/composables/useI18n'

const openIndex = ref<number | null>(0)
const { ref: scrollRef, isVisible } = useScrollAnimation(0.1)
const { t } = useI18n()

const faqKeys = [
  { q: 'faq.q1', a: 'faq.a1' },
  { q: 'faq.q2', a: 'faq.a2' },
  { q: 'faq.q3', a: 'faq.a3' },
  { q: 'faq.q4', a: 'faq.a4' },
  { q: 'faq.q5', a: 'faq.a5' },
  { q: 'faq.q6', a: 'faq.a6' },
]

function toggle(index: number) {
  openIndex.value = openIndex.value === index ? null : index
}
</script>

<template>
  <section id="faq" class="relative bg-bg-secondary px-6 py-24">
    <div class="pointer-events-none absolute inset-0 bg-glow opacity-30" />

    <div
      ref="scrollRef"
      :class="['relative mx-auto max-w-3xl animate-on-scroll', isVisible ? 'visible' : '']"
    >
      <div class="mb-12 text-center">
        <h2 class="mb-4 text-3xl font-bold tracking-tight md:text-5xl">
          {{ t('faq.title') }}
        </h2>
      </div>

      <div class="space-y-4">
        <Card
          v-for="(faq, index) in faqKeys"
          :key="index"
          :class="['shine-border border-white/10 bg-bg-primary/80 backdrop-blur-sm transition-all', openIndex === index ? 'ring-1 ring-accent/20' : '']"
        >
          <button
            class="w-full"
            @click="toggle(index)"
            :aria-expanded="openIndex === index"
          >
            <CardContent class="flex items-start justify-between gap-4 p-5 text-left">
              <span class="font-medium text-text-primary">{{ t(faq.q) }}</span>
              <ChevronDown
                :class="['mt-0.5 h-5 w-5 shrink-0 text-text-secondary transition-transform', openIndex === index ? 'rotate-180' : '']"
              />
            </CardContent>
          </button>
          <CardContent v-if="openIndex === index" class="border-t border-white/5 px-5 pb-5 pt-0">
            <p class="pt-4 text-text-secondary leading-relaxed">{{ t(faq.a) }}</p>
          </CardContent>
        </Card>
      </div>
    </div>
  </section>
</template>
