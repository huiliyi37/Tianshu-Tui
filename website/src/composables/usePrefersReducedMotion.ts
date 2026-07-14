import { ref, onMounted, onUnmounted } from 'vue'

export function usePrefersReducedMotion() {
  const prefers = ref(false)
  let mq: MediaQueryList | null = null
  let handler: ((e: MediaQueryListEvent) => void) | null = null

  onMounted(() => {
    mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    prefers.value = mq.matches

    handler = (e: MediaQueryListEvent) => {
      prefers.value = e.matches
    }

    mq.addEventListener('change', handler)
  })

  onUnmounted(() => {
    if (mq && handler) {
      mq.removeEventListener('change', handler)
    }
  })

  return prefers
}
