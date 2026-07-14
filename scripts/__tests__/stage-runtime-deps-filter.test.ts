import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isForeignPlatformPackage } from '../runtime-platform-filter.js'

test('isForeignPlatformPackage detects @esbuild platform pkgs', () => {
  assert.equal(isForeignPlatformPackage('@esbuild/darwin-x64', 'arm64'), true)
  assert.equal(isForeignPlatformPackage('@esbuild/darwin-arm64', 'arm64'), false)
  assert.equal(isForeignPlatformPackage('@esbuild/darwin-arm64', 'x64'), true)
  assert.equal(isForeignPlatformPackage('@esbuild/linux-x64', 'x64'), false)
})

test('isForeignPlatformPackage detects @ast-grep napi pkgs', () => {
  assert.equal(isForeignPlatformPackage('@ast-grep/napi-darwin-x64', 'arm64'), true)
  assert.equal(isForeignPlatformPackage('@ast-grep/napi-darwin-arm64', 'arm64'), false)
  assert.equal(isForeignPlatformPackage('@ast-grep/napi', 'arm64'), false)
})

test('isForeignPlatformPackage leaves non-platform packages alone', () => {
  assert.equal(isForeignPlatformPackage('esbuild', 'arm64'), false)
  assert.equal(isForeignPlatformPackage('typescript', 'arm64'), false)
  assert.equal(isForeignPlatformPackage('@ast-grep/lang-python', 'arm64'), false)
})
