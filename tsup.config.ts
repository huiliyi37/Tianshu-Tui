import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/main.tsx'],
  format: ['esm'],
  target: 'node22',
  dts: true,
  clean: true,
  shims: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
})
