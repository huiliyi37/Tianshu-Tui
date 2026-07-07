import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { classifyIrreversibleEffects, classifyIrreversibleEffectIds } from '../side-effect-classifier.js'

describe('side-effect-classifier', () => {
  it('flags outbound network mutations', () => {
    assert.deepEqual(classifyIrreversibleEffectIds('curl -X POST https://api.example.com/orders'), ['network-write'])
    assert.deepEqual(classifyIrreversibleEffectIds('curl -d "x=1" https://h/p'), ['network-write'])
    assert.deepEqual(classifyIrreversibleEffectIds('wget --post-data=foo https://h'), ['network-write'])
  })

  it('does NOT flag a read-only GET', () => {
    assert.deepEqual(classifyIrreversibleEffects('curl https://api.example.com/status'), [])
    assert.deepEqual(classifyIrreversibleEffects('curl -s -o out.json https://h/data'), [])
  })

  it('flags database writes but not read-only queries', () => {
    assert.deepEqual(classifyIrreversibleEffectIds(`psql -c "DELETE FROM users WHERE id=1"`), ['database-write'])
    assert.deepEqual(classifyIrreversibleEffectIds('redis-cli FLUSHALL'), ['database-write'])
    assert.deepEqual(classifyIrreversibleEffects(`psql -c "SELECT * FROM users"`), [])
  })

  it('flags package publish, vcs push, infra, and service control', () => {
    assert.deepEqual(classifyIrreversibleEffectIds('npm publish'), ['package-publish'])
    assert.deepEqual(classifyIrreversibleEffectIds('git push origin main'), ['vcs-push'])
    assert.deepEqual(classifyIrreversibleEffectIds('kubectl apply -f deploy.yaml'), ['infra-mutation'])
    assert.deepEqual(classifyIrreversibleEffectIds('docker push myimage:latest'), ['infra-mutation'])
    assert.deepEqual(classifyIrreversibleEffectIds('systemctl restart nginx'), ['service-control'])
  })

  it('returns multiple labels for a compound command', () => {
    const ids = classifyIrreversibleEffectIds('npm publish && git push --tags')
    assert.ok(ids.includes('package-publish'))
    assert.ok(ids.includes('vcs-push'))
  })

  it('returns empty for benign file-only commands', () => {
    assert.deepEqual(classifyIrreversibleEffects('echo hi > out.txt'), [])
    assert.deepEqual(classifyIrreversibleEffects('rm -rf node_modules && npm install'), [])
    assert.deepEqual(classifyIrreversibleEffects('mkdir -p build && cp a b'), [])
  })

  it('is robust to empty / non-string input', () => {
    assert.deepEqual(classifyIrreversibleEffects(''), [])
    // @ts-expect-error testing defensive guard
    assert.deepEqual(classifyIrreversibleEffects(undefined), [])
  })

  it('labels are human-readable and parallel to ids', () => {
    const labels = classifyIrreversibleEffects('git push')
    assert.equal(labels.length, 1)
    assert.match(labels[0]!, /VCS/i)
  })
})
