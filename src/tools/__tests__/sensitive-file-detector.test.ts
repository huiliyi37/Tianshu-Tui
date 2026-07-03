import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  detectSensitiveFile,
  detectSensitiveGitAdd,
} from '../sensitive-file-detector.js'

describe('sensitive-file-detector', () => {
  describe('detectSensitiveFile', () => {
    it('detects .env as sensitive', () => {
      const r = detectSensitiveFile('.env')
      assert.equal(r.sensitive, true)
      assert.equal(r.patternName, '.env (real)')
    })

    it('detects .env.local as sensitive', () => {
      assert.equal(detectSensitiveFile('.env.local').sensitive, true)
    })

    it('detects .env.production as sensitive', () => {
      assert.equal(detectSensitiveFile('.env.production').sensitive, true)
    })

    it('does NOT detect .env.example (whitelisted)', () => {
      assert.equal(detectSensitiveFile('.env.example').sensitive, false)
    })

    it('does NOT detect .env.template (whitelisted)', () => {
      assert.equal(detectSensitiveFile('.env.template').sensitive, false)
    })

    it('detects credentials.json', () => {
      const r = detectSensitiveFile('config/credentials.json')
      assert.equal(r.sensitive, true)
    })

    it('detects SSH private keys', () => {
      assert.equal(detectSensitiveFile('~/.ssh/id_rsa').sensitive, true)
      assert.equal(detectSensitiveFile('id_ed25519').sensitive, true)
    })

    it('detects .pem and .key files', () => {
      assert.equal(detectSensitiveFile('certs/server.pem').sensitive, true)
      assert.equal(detectSensitiveFile('tls/private.key').sensitive, true)
    })

    it('detects .npmrc', () => {
      assert.equal(detectSensitiveFile('.npmrc').sensitive, true)
    })

    it('detects secrets.json', () => {
      assert.equal(detectSensitiveFile('secrets.json').sensitive, true)
      assert.equal(detectSensitiveFile('config/tokens.yaml').sensitive, true)
    })

    it('does NOT detect .ts source files (auth/token-manager.ts)', () => {
      assert.equal(detectSensitiveFile('src/auth/token-manager.ts').sensitive, false)
    })

    it('does NOT detect .js source files', () => {
      assert.equal(detectSensitiveFile('src/auth/secrets.js').sensitive, false)
    })

    it('does NOT detect test files', () => {
      assert.equal(detectSensitiveFile('src/env.test.ts').sensitive, false)
    })

    it('does NOT detect fixtures', () => {
      assert.equal(detectSensitiveFile('fixtures/.env').sensitive, false)
    })

    it('does NOT detect regular source files', () => {
      assert.equal(detectSensitiveFile('src/agent/loop.ts').sensitive, false)
    })

    it('does NOT detect markdown docs', () => {
      assert.equal(detectSensitiveFile('docs/secrets.md').sensitive, false)
    })
  })

  describe('detectSensitiveGitAdd', () => {
    it('detects git add .env', () => {
      const files = detectSensitiveGitAdd('git add .env')
      assert.deepEqual(files, ['.env'])
    })

    it('detects git add with multiple files including sensitive', () => {
      const files = detectSensitiveGitAdd('git add src/foo.ts .env credentials.json')
      assert.ok(files.includes('.env'))
      assert.ok(files.includes('credentials.json'))
    })

    it('returns empty for git add with no sensitive files', () => {
      const files = detectSensitiveGitAdd('git add src/foo.ts src/bar.ts')
      assert.equal(files.length, 0)
    })

    it('returns empty for non-git-add commands', () => {
      const files = detectSensitiveGitAdd('git status')
      assert.equal(files.length, 0)
    })

    it('handles git add with flags', () => {
      const files = detectSensitiveGitAdd('git add -A')
      assert.equal(files.length, 0) // -A is a flag, not a file
    })
  })
})
