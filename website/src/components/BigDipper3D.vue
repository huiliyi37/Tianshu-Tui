<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { usePrefersReducedMotion } from '@/composables/usePrefersReducedMotion'
import { useElementVisibility } from '@/composables/useElementVisibility'

const STAR_POSITIONS: [number, number, number][] = [
  [-2.2, 0.8, 0],
  [-1.5, 1.0, 0],
  [-0.6, 1.1, 0],
  [0.2, 0.9, 0],
  [1.0, 0.5, 0],
  [1.9, 0.2, 0],
  [2.6, -0.3, 0],
]

const CONNECTIONS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [0, 3],
]

const prefersReducedMotion = usePrefersReducedMotion()
const containerRef = ref<HTMLDivElement | null>(null)
const isVisible = useElementVisibility(containerRef)

let scene: THREE.Scene | null = null
let camera: THREE.PerspectiveCamera | null = null
let renderer: THREE.WebGLRenderer | null = null
let controls: OrbitControls | null = null
let group: THREE.Group | null = null
let animateId = 0
let clock: THREE.Clock | null = null
let handleResize: (() => void) | null = null

function animate() {
  if (!group || !controls || !renderer || !camera || !isVisible.value) return
  animateId = requestAnimationFrame(animate)
  const delta = clock?.getDelta() ?? 0
  group.rotation.y += delta * 0.08
  controls.update()
  renderer.render(scene!, camera)
}

onMounted(() => {
  if (prefersReducedMotion.value || !containerRef.value) return

  const container = containerRef.value

  scene = new THREE.Scene()
  camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.1, 100)
  camera.position.set(0, 0.5, 4.5)

  renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
  renderer.setSize(container.clientWidth, container.clientHeight)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  container.appendChild(renderer.domElement)

  controls = new OrbitControls(camera, renderer.domElement)
  controls.enableZoom = false
  controls.enablePan = false
  controls.minPolarAngle = Math.PI / 4
  controls.maxPolarAngle = (3 * Math.PI) / 4

  const ambientLight = new THREE.AmbientLight(0xffffff, 0.2)
  scene.add(ambientLight)

  group = new THREE.Group()
  scene.add(group)

  const sphereGeo = new THREE.SphereGeometry(0.08, 16, 16)
  const glowGeo = new THREE.SphereGeometry(0.03, 12, 12)

  STAR_POSITIONS.forEach((pos) => {
    const starMat = new THREE.MeshStandardMaterial({
      color: '#818cf8',
      emissive: '#6366f1',
      emissiveIntensity: 2,
      transparent: true,
      opacity: 0.9,
    })
    const star = new THREE.Mesh(sphereGeo, starMat)
    star.position.set(...pos)
    group!.add(star)

    const light = new THREE.PointLight('#6366f1', 0.3, 2)
    light.position.set(...pos)
    group!.add(light)

    const glowMat = new THREE.MeshBasicMaterial({ color: '#c7d2fe', transparent: true, opacity: 0.8 })
    const glow = new THREE.Mesh(glowGeo, glowMat)
    glow.position.set(...pos)
    group!.add(glow)
  })

  CONNECTIONS.forEach(([a, b]) => {
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(...STAR_POSITIONS[a]),
      new THREE.Vector3(...STAR_POSITIONS[b]),
    ])
    const mat = new THREE.LineBasicMaterial({ color: '#6366f1', transparent: true, opacity: 0.4 })
    const line = new THREE.Line(geo, mat)
    group!.add(line)
  })

  // Background stars
  const starsGeo = new THREE.BufferGeometry()
  const starsCount = 1000
  const starsPositions = new Float32Array(starsCount * 3)
  for (let i = 0; i < starsCount * 3; i++) {
    starsPositions[i] = (Math.random() - 0.5) * 100
  }
  starsGeo.setAttribute('position', new THREE.BufferAttribute(starsPositions, 3))
  const starsMat = new THREE.PointsMaterial({ color: '#818cf8', size: 0.08, transparent: true, opacity: 0.6 })
  const stars = new THREE.Points(starsGeo, starsMat)
  scene.add(stars)

  clock = new THREE.Clock()
  if (isVisible.value) {
    animateId = requestAnimationFrame(animate)
  }

  handleResize = () => {
    if (!camera || !renderer || !container) return
    camera.aspect = container.clientWidth / container.clientHeight
    camera.updateProjectionMatrix()
    renderer.setSize(container.clientWidth, container.clientHeight)
  }

  window.addEventListener('resize', handleResize)
})

watch(isVisible, (visible) => {
  if (visible && renderer) {
    animateId = requestAnimationFrame(animate)
  }
})

onUnmounted(() => {
  cancelAnimationFrame(animateId)
  if (handleResize) window.removeEventListener('resize', handleResize)
  controls?.dispose()
  renderer?.dispose()
  if (renderer?.domElement && containerRef.value) {
    containerRef.value.removeChild(renderer.domElement)
  }
})
</script>

<template>
  <div
    v-if="prefersReducedMotion"
    class="relative mx-auto flex h-[200px] w-full max-w-md items-center justify-center md:h-[260px]"
    aria-label="Big Dipper constellation"
  >
    <div class="text-accent-glow opacity-50 text-6xl">✦</div>
  </div>
  <div
    v-else
    ref="containerRef"
    class="relative mx-auto h-[200px] w-full max-w-md md:h-[260px]"
    aria-label="Interactive 3D Big Dipper constellation"
  />
</template>
