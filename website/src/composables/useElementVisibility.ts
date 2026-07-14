import { ref, onMounted, onUnmounted, type Ref } from 'vue'

/**
 * Tracks whether an element is visible in the viewport.
 * Used to pause expensive animations (WebGL/Canvas) when off-screen.
 */
export function useElementVisibility(elementRef: Ref<HTMLElement | null>) {
  const isVisible = ref(false)
  let observer: IntersectionObserver | null = null

  onMounted(() => {
    const el = elementRef.value
    if (!el) return

    observer = new IntersectionObserver(
      ([entry]) => {
        isVisible.value = entry.isIntersecting
      },
      { threshold: 0.01 } // trigger when even 1% is visible
    )
    observer.observe(el)
  })

  onUnmounted(() => {
    observer?.disconnect()
  })

  return isVisible
}
