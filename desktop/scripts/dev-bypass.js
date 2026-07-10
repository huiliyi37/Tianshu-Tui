#!/usr/bin/env node
/**
 * Run `tauri dev` as Pro without a real license (dual-tier mode).
 *
 * Debug builds honor RIVET_ACTIVATION_DEV_BYPASS=1: activation.rs treats the
 * machine as Pro, so spawn_sidecar injects RIVET_PRO=1 and all Pro features
 * (computer_use / team max / multi-round council) unlock. Without it, dev
 * builds run as Basic — the app still works fully, just without Pro features.
 */

import { spawn } from 'node:child_process'
import process from 'node:process'

process.env.RIVET_ACTIVATION_DEV_BYPASS = '1'

const child = spawn('npm', ['run', 'tauri:dev'], {
  stdio: 'inherit',
  shell: true,
})

child.on('exit', (code) => {
  process.exit(code ?? 0)
})

child.on('error', (err) => {
  console.error('Failed to start tauri dev:', err)
  process.exit(1)
})
