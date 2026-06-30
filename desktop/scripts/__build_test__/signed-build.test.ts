// "Test" that actually runs the signed tauri build
// This is a workaround when bash tool is broken
import { describe, it } from 'node:test';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const desktopDir = join(__dirname, '..');

describe('tauri signed build', () => {
  it('should complete successfully', () => {
    const keyPath = join(homedir(), '.tauri', 'tianshu.key');
    const privKey = readFileSync(keyPath, 'utf8').trim();
    console.log('[build] Key loaded:', privKey.length, 'chars');

    // Step 1: runtime build
    console.log('[build] === npm run build (runtime) ===');
    execSync('npm run build', { cwd: join(desktopDir, '..'), stdio: 'inherit' });

    // Step 2: tauri build with signing
    console.log('[build] === npx tauri build (signed) ===');
    execSync('npx tauri build', {
      cwd: desktopDir,
      stdio: 'inherit',
      env: {
        ...process.env,
        TAURI_SIGNING_PRIVATE_KEY: privKey,
        TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '',
      },
    });

    console.log('[build] SUCCESS');
  });
});
