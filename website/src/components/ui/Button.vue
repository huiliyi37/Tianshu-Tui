<script setup lang="ts">
import { computed } from 'vue'
import { cn } from '@/lib/utils'

export type ButtonVariant = 'default' | 'secondary' | 'ghost' | 'outline'
export type ButtonSize = 'default' | 'sm' | 'lg' | 'icon'

const props = withDefaults(
  defineProps<{
    variant?: ButtonVariant
    size?: ButtonSize
    href?: string
    target?: string
    rel?: string
    disabled?: boolean
    type?: 'button' | 'submit' | 'reset'
    class?: string
  }>(),
  {
    variant: 'default',
    size: 'default',
    type: 'button',
  }
)

const emit = defineEmits<{
  click: [e: MouseEvent]
}>()

const baseClasses =
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-50'

const variantClasses: Record<ButtonVariant, string> = {
  default: 'bg-accent text-white hover:bg-accent-glow shadow-lg shadow-accent/20',
  secondary:
    'bg-bg-tertiary text-text-primary border border-white/10 hover:border-accent/50 hover:bg-accent/10',
  ghost: 'hover:bg-white/5 text-text-secondary hover:text-text-primary',
  outline: 'border border-white/10 bg-transparent hover:bg-white/5 text-text-primary',
}

const sizeClasses: Record<ButtonSize, string> = {
  default: 'h-10 px-5 py-2',
  sm: 'h-8 px-3 text-xs',
  lg: 'h-12 px-8 text-base',
  icon: 'h-9 w-9',
}

const classes = computed(() => cn(baseClasses, variantClasses[props.variant], sizeClasses[props.size], props.class))
</script>

<template>
  <a
    v-if="href"
    :href="href"
    :target="target"
    :rel="rel"
    :class="classes"
    @click="(e) => emit('click', e)"
  >
    <slot />
  </a>
  <button
    v-else
    :type="type"
    :disabled="disabled"
    :class="classes"
    @click="(e) => emit('click', e)"
  >
    <slot />
  </button>
</template>
