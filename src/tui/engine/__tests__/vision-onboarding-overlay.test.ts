import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { makeApp } from './_harness.js'
import type { VisionOnboardingRequest } from '../../vision-onboarding-flow.js'

interface AppInternals {
  startVisionOnboarding(execute: (request: VisionOnboardingRequest) => Promise<{ candidates?: Array<{ id: string; knownVision: boolean }> }>): void
  registerOverlays(data: Record<string, never>): void
  handleOverlayKey(key: { name: string; char?: string; ctrl?: boolean }): boolean
  overlay: { activeId(): string | null }
  getVisionOnboardingOverlayData(): { input: string; cursorPos?: number }
}

function internals(app: unknown): AppInternals { return app as AppInternals }
function key(char: string): { name: string; char: string } { return { name: '', char } }

async function flush(): Promise<void> { await new Promise(resolve => setImmediate(resolve)) }

describe('vision onboarding overlay', () => {
  it('uses dedicated discover and onboard descriptors without provider probing', async () => {
    const app = internals(makeApp().app)
    const requests: VisionOnboardingRequest[] = []
    app.registerOverlays({})
    app.startVisionOnboarding(async request => {
      requests.push(request)
      return request.kind === 'discover' ? { candidates: [{ id: 'vision-1', knownVision: false }] } : {}
    })
    assert.equal(app.overlay.activeId(), 'vision-onboarding')
    for (const char of 'https://vision.example/v1') app.handleOverlayKey(key(char))
    app.handleOverlayKey({ name: 'return', char: '' })
    const providerNameStep = app.getVisionOnboardingOverlayData()
    assert.equal(providerNameStep.input, '')
    assert.equal(providerNameStep.cursorPos, 0)
    for (const char of 'vision-custom') app.handleOverlayKey(key(char))
    app.handleOverlayKey({ name: 'return', char: '' })
    app.handleOverlayKey({ name: 'return', char: '' })
    for (const char of 'sk-test') app.handleOverlayKey(key(char))
    app.handleOverlayKey({ name: 'return', char: '' })
    await flush()
    app.handleOverlayKey({ name: 'return', char: '' })
    await flush()

    assert.deepEqual(requests, [
      { kind: 'discover', body: { baseUrl: 'https://vision.example/v1', providerName: 'vision-custom', apiKey: 'sk-test' } },
      { kind: 'onboard', body: { baseUrl: 'https://vision.example/v1', providerName: 'vision-custom', apiKey: 'sk-test', modelId: 'vision-1' } },
    ])
    assert.equal(app.overlay.activeId(), null)
  })
})
