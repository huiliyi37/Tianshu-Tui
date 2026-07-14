<script setup lang="ts">
import { cn } from '@/lib/utils'

const props = defineProps<{
  class?: string
}>()
</script>

<template>
  <div :class="cn('rounded-xl border border-white/10 bg-bg-secondary/50 backdrop-blur-sm', props.class)">
    <slot />
  </div>
</template>
