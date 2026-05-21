import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

describe('startup memory baseline', () => {
  it('RSS should be below 115MB after import', async () => {
    const { stdout } = await execFileAsync('node', [
      '--max-old-space-size=256',
      '-e',
      `import('./dist/main.js').then(() => {
        const m = process.memoryUsage();
        console.log(JSON.stringify({ rss_MB: +(m.rss / 1048576).toFixed(1) }));
        process.exit(0);
      }).catch(() => process.exit(0));`,
    ], { timeout: 15_000 })

    const lines = stdout.trim().split('\n')
    const last = lines[lines.length - 1] ?? ''
    let rss = 200
    try { rss = JSON.parse(last).rss_MB } catch { /* use default */ }
    assert.ok(rss < 115, `Startup RSS ${rss}MB exceeds 115MB budget`)
  })
})
