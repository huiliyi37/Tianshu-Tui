<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { usePrefersReducedMotion } from '@/composables/usePrefersReducedMotion'

const props = withDefaults(defineProps<{
  speed?: number
  class?: string
}>(), {
  speed: 0.5,
})

const elRef = ref<HTMLDivElement | null>(null)
const prefersReducedMotion = usePrefersReducedMotion()

function onScroll() {
  if (!elRef.value) return
  const scrollY = window.scrollY
  elRef.value.style.transform = `translateY(${scrollY * props.speed}px)`
}

onMounted(() => {
  if (prefersReducedMotion.value) return
  window.addEventListener('scroll', onScroll, { passive: true })
})

onUnmounted(() => {
  window.removeEventListener('scroll', onScroll)
})
</script>

<template>
  <div ref="elRef" :class="['will-change-transform', props.class]">
    <slot />
  </div>
</template>
