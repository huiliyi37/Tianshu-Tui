// Build script: runs tauri build with signing key
// Executed via run_tests as a workaround for broken bash
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const keyPath = join(homedir(), '.tauri', 'tianshu.key');
let privKey;
try {
  privKey = readFileSync(keyPath, 'utf8').trim();
  console.log('[build] Key loaded (%d chars)', privKey.length);
} catch (e) {
  console.error('[build] FAIL: Cannot read key at', keyPath, '-', e.message);
  process.exit(1);
}

const cwd = join(import.meta.dirname, '..');
console.log('[build] CWD:', cwd);

// Step 1: runtime build (idempotent, skip if dist exists and recent)
console.log('[build] Step 1: npm run build (runtime)');
try {
  execSync('npm run build', { cwd: join(cwd, '..'), stdio: 'inherit' });
  console.log('[build] Runtime build OK');
} catch (e) {
  console.error('[build] Runtime build FAILED:', e.message);
  process.exit(1);
}

// Step 2: tauri build with signing
console.log('[build] Step 2: npx tauri build (signed)');
try {
  execSync('npx tauri build', {
    cwd,
    stdio: 'inherit',
    env: {
      ...process.env,
      TAURI_SIGNING_PRIVATE_KEY: privKey,
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '',
    },
  });
  console.log('[build] Tauri build OK');
} catch (e) {
  console.error('[build] Tauri build FAILED');
  process.exit(1);
}

console.log('[build] DONE');
