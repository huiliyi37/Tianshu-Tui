<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { usePrefersReducedMotion } from '@/composables/usePrefersReducedMotion'
import { useElementVisibility } from '@/composables/useElementVisibility'

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  radius: number
  opacity: number
}

const PARTICLE_COUNT = 80
const CONNECTION_DIST = 120
const MOUSE_RADIUS = 200

const canvasRef = ref<HTMLCanvasElement | null>(null)
const prefersReducedMotion = usePrefersReducedMotion()
const isVisible = useElementVisibility(canvasRef)
const mouseRef = ref({ x: -1000, y: -1000 })
const particlesRef = ref<Particle[]>([])
let rafId = 0

function initParticles(w: number, h: number) {
  particlesRef.value = Array.from({ length: PARTICLE_COUNT }, () => ({
    x: Math.random() * w,
    y: Math.random() * h,
    vx: (Math.random() - 0.5) * 0.3,
    vy: (Math.random() - 0.5) * 0.3,
    radius: Math.random() * 1.5 + 0.5,
    opacity: Math.random() * 0.5 + 0.2,
  }))
}

function startCanvas() {
  const canvas = canvasRef.value
  if (!canvas || prefersReducedMotion.value) return

  const ctx = canvas.getContext('2d')!
  let w = 0
  let h = 0

  const resize = () => {
    w = canvas.parentElement!.clientWidth
    h = canvas.parentElement!.clientHeight
    canvas.width = w
    canvas.height = h
    if (particlesRef.value.length === 0) initParticles(w, h)
  }

  resize()
  window.addEventListener('resize', resize)

  const onMouse = (e: MouseEvent) => {
    const rect = canvas.getBoundingClientRect()
    mouseRef.value = { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  window.addEventListener('mousemove', onMouse, { passive: true })

  const draw = () => {
    if (!isVisible.value) {
      rafId = requestAnimationFrame(draw)
      return
    }
    ctx.clearRect(0, 0, w, h)
    const particles = particlesRef.value
    const mx = mouseRef.value.x
    const my = mouseRef.value.y

    for (const p of particles) {
      const dx = mx - p.x
      const dy = my - p.y
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist < MOUSE_RADIUS && dist > 0) {
        p.vx += (dx / dist) * 0.02
        p.vy += (dy / dist) * 0.02
      }

      p.vx *= 0.99
      p.vy *= 0.99
      p.x += p.vx
      p.y += p.vy

      if (p.x < 0) p.x = w
      if (p.x > w) p.x = 0
      if (p.y < 0) p.y = h
      if (p.y > h) p.y = 0

      ctx.beginPath()
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(129, 140, 248, ${p.opacity})`
      ctx.fill()
    }

    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx = particles[i].x - particles[j].x
        const dy = particles[i].y - particles[j].y
        const dist = Math.sqrt(dx * dx + dy * dy)
        if (dist < CONNECTION_DIST) {
          const alpha = (1 - dist / CONNECTION_DIST) * 0.15
          ctx.beginPath()
          ctx.moveTo(particles[i].x, particles[i].y)
          ctx.lineTo(particles[j].x, particles[j].y)
          ctx.strokeStyle = `rgba(99, 102, 241, ${alpha})`
          ctx.lineWidth = 0.5
          ctx.stroke()
        }
      }
    }

    rafId = requestAnimationFrame(draw)
  }

  rafId = requestAnimationFrame(draw)

  return () => {
    cancelAnimationFrame(rafId)
    window.removeEventListener('resize', resize)
    window.removeEventListener('mousemove', onMouse)
  }
}

let cleanup: (() => void) | undefined

onMounted(() => {
  if (!prefersReducedMotion.value) {
    cleanup = startCanvas()
  }
})

watch(prefersReducedMotion, (reduced) => {
  if (reduced) {
    cleanup?.()
    cleanup = undefined
  } else if (!cleanup) {
    cleanup = startCanvas()
  }
})

onUnmounted(() => {
  cleanup?.()
})
</script>

<template>
  <canvas
    v-if="!prefersReducedMotion"
    ref="canvasRef"
    class="pointer-events-none absolute inset-0 z-0"
    aria-hidden="true"
  />
</template>
