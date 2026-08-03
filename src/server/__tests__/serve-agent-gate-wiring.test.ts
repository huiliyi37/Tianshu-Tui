import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(process.cwd(), 'src', 'server', 'serve-agent.ts'), 'utf8')

describe('serve-agent gate wiring', () => {
  it('assigns refs.getImpactedTests so delivery gate module coverage runs on sidecar', () => {
    assert.match(source, /refs\.getImpactedTests\s*=/,
      'sidecar 未接 getImpactedTests —— delivery-gate-v2 的 moduleCoverage 分支在桌面端/插件上永不触发')
  })

  it('passes cwd to injectDurableClaims so the cross-project pollution gate runs', () => {
    assert.match(source, /injectDurableClaims\(\s*claimStore\s*,\s*cwd\s*\)/,
      'sidecar 未传 cwd —— session-persist.ts 的文件交集门禁被整块跳过')
  })
})
