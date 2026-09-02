import { test } from 'node:test'
import assert from 'node:assert/strict'
import { STAR_DOMAINS } from '../star-domain-data.js'
import {
  STARTER_DOMAIN_IDS,
  getStarDomainTier,
  partitionDomainsByTier,
} from '../domain-tiers.js'

test('第一档恰好是四颗默认星域：天权 / 启明 / 瑶光 / 天梁', () => {
  assert.deepEqual([...STARTER_DOMAIN_IDS], ['tianquan', 'qiming', 'yaoguang', 'tianliang'])
  for (const id of STARTER_DOMAIN_IDS) {
    assert.equal(getStarDomainTier(id), 'starter')
  }
})

test('其余内置星域全部归第二档', () => {
  const all = Object.keys(STAR_DOMAINS) as Array<keyof typeof STAR_DOMAINS>
  const advanced = all.filter((id) => getStarDomainTier(id) === 'advanced')
  assert.equal(advanced.length, all.length - STARTER_DOMAIN_IDS.length)
  assert.ok(advanced.includes('changgeng'))
  assert.ok(advanced.includes('taiyi'))
  assert.ok(advanced.includes('kaiyang'))
  assert.ok(advanced.includes('qisha'))
  assert.ok(advanced.includes('tianxuan'))
  assert.ok(advanced.includes('tianshu'))
})

test('partitionDomainsByTier 保持第一档展示顺序，第二档保持传入顺序', () => {
  const all = Object.keys(STAR_DOMAINS) as Array<keyof typeof STAR_DOMAINS>
  const result = partitionDomainsByTier(all)
  assert.deepEqual(result.starter, [...STARTER_DOMAIN_IDS])
  assert.deepEqual(result.advanced, all.filter((id) => !STARTER_DOMAIN_IDS.includes(id)))
  assert.deepEqual([...new Set([...result.starter, ...result.advanced])].sort(), [...all].sort())
})
