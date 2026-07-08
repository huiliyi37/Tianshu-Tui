import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import javascriptObfuscator from 'vite-plugin-javascript-obfuscator'
import path from 'node:path'

// Tauri expects a fixed dev port and ignores Vite's HMR websocket host detection.
const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    javascriptObfuscator({
      options: {
        compact: true,
        controlFlowFlattening: true,
        controlFlowFlatteningThreshold: 0.5,
        identifierNamesGenerator: 'hexadecimal',
        ignoreImports: true,
        splitStrings: true,
        splitStringsChunkLength: 10,
        stringArray: true,
        stringArrayEncoding: ['base64'],
        stringArrayThreshold: 0.5,
        target: 'browser',
        transformObjectKeys: false,
        sourceMap: false,
      },
      apply: 'build',
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  clearScreen: false,
  server: {
    port: 5273,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 5274 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    target: 'es2021',
    outDir: 'dist',
    emptyOutDir: true,
  },
})
