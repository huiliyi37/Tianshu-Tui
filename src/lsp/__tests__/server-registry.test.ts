import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  serverDefForExt,
  serverForFile,
  isServerAvailable,
  availableServers,
  LSP_SERVERS,
} from '../server-registry.js'

describe('lsp server-registry (C2 polyglot)', () => {
  it('maps extensions to the right server', () => {
    assert.equal(serverDefForExt('.py')?.id, 'pyright')
    assert.equal(serverDefForExt('.go')?.id, 'gopls')
    assert.equal(serverDefForExt('.rs')?.id, 'rust-analyzer')
    assert.equal(serverDefForExt('.cpp')?.id, 'clangd')
    assert.equal(serverDefForExt('.java')?.id, 'jdtls')
    assert.equal(serverDefForExt('.ts')?.id, 'typescript')
  })

  it('returns null for unsupported extensions', () => {
    assert.equal(serverDefForExt('.txt'), null)
    assert.equal(serverDefForExt('.md'), null)
  })

  it('typescript is always available (launched via npx)', () => {
    const ts = LSP_SERVERS.find(s => s.id === 'typescript')!
    assert.equal(isServerAvailable(ts, () => false), true)
  })

  it('non-ts servers require their binary on PATH', () => {
    const gopls = LSP_SERVERS.find(s => s.id === 'gopls')!
    assert.equal(isServerAvailable(gopls, () => false), false)
    assert.equal(isServerAvailable(gopls, (b) => b === 'gopls'), true)
  })

  it('serverForFile only returns installed servers', () => {
    // gopls not installed → no server for .go
    assert.equal(serverForFile('main.go', () => false), null)
    // gopls installed → resolves
    assert.equal(serverForFile('main.go', (b) => b === 'gopls')?.id, 'gopls')
    // ts always resolves
    assert.equal(serverForFile('app.ts', () => false)?.id, 'typescript')
  })

  it('availableServers reflects which binaries are present', () => {
    const all = availableServers((b) => b === 'pyright-langserver')
    const ids = all.map(s => s.id).sort()
    // typescript (always) + pyright (present)
    assert.deepEqual(ids, ['pyright', 'typescript'])
  })
})
