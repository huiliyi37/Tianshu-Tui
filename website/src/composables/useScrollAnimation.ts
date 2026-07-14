import { ref, onMounted, onUnmounted } from 'vue'

export function useScrollAnimation(threshold = 0.1) {
  const isVisible = ref(false)
  const targetRef = ref<HTMLElement | null>(null)
  let observer: IntersectionObserver | null = null

  onMounted(() => {
    const node = targetRef.value
    if (!node) return

    observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          isVisible.value = true
          observer?.unobserve(entry.target)
        }
      },
      { threshold }
    )

    observer.observe(node)
  })

  onUnmounted(() => {
    observer?.disconnect()
  })

  return { ref: targetRef, isVisible }
}
