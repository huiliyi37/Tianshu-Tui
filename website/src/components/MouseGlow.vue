<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'

const position = ref({ x: 0, y: 0 })
const isVisible = ref(false)

function handleMouseMove(e: MouseEvent) {
  position.value = { x: e.clientX, y: e.clientY }
  if (!isVisible.value) isVisible.value = true
}

function handleMouseLeave() {
  isVisible.value = false
}

onMounted(() => {
  window.addEventListener('mousemove', handleMouseMove)
  document.addEventListener('mouseleave', handleMouseLeave)
})

onUnmounted(() => {
  window.removeEventListener('mousemove', handleMouseMove)
  document.removeEventListener('mouseleave', handleMouseLeave)
})
</script>

<template>
  <div
    v-if="isVisible"
    class="pointer-events-none fixed inset-0 z-30 transition duration-300"
    :style="{
      background: `radial-gradient(600px at ${position.x}px ${position.y}px, rgba(99, 102, 241, 0.12), transparent 80%)`,
    }"
  />
</template>
