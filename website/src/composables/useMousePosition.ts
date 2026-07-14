import { ref, onMounted, onUnmounted } from 'vue'

export function useMousePosition() {
  const pos = ref({ x: 0, y: 0 })

  const onMove = (e: MouseEvent) => {
    pos.value = { x: e.clientX, y: e.clientY }
  }

  onMounted(() => {
    window.addEventListener('mousemove', onMove, { passive: true })
  })

  onUnmounted(() => {
    window.removeEventListener('mousemove', onMove)
  })

  return pos
}
