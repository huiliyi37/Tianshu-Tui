import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTerminalTabsState } from '../../lib/terminal-tabs-state'

// ── TerminalTabs state management (pure logic, no React/xterm) ───

test('createTerminalTabsState: initial state has one tab', () => {
  const state = createTerminalTabsState('/project')
  assert.equal(state.tabs.length, 1)
  assert.equal(state.activeId, state.tabs[0]!.id)
  assert.equal(state.tabs[0]!.cwd, '/project')
  assert.equal(state.tabs[0]!.title, 'bash')
})

test('createTerminalTabsState: addTab creates new tab and sets active', () => {
  const state = createTerminalTabsState('/project')
  const before = state.tabs.length
  state.addTab()
  assert.equal(state.tabs.length, before + 1)
  assert.equal(state.activeId, state.tabs[state.tabs.length - 1]!.id)
})

test('createTerminalTabsState: closeTab removes tab and selects neighbor', () => {
  const state = createTerminalTabsState('/project')
  state.addTab()
  const firstId = state.tabs[0]!.id
  const secondId = state.tabs[1]!.id
  state.activeId = secondId

  // Close the active (second) tab → should fall back to first
  state.closeTab(secondId)
  assert.equal(state.tabs.length, 1)
  assert.equal(state.activeId, firstId)
})

test('createTerminalTabsState: closeTab on middle tab selects previous', () => {
  const state = createTerminalTabsState('/project')
  state.addTab()
  state.addTab()
  // tabs: [0, 1, 2]
  const ids = state.tabs.map(t => t.id)
  state.activeId = ids[1]!
  state.closeTab(ids[1]!)
  assert.equal(state.tabs.length, 2)
  assert.equal(state.activeId, ids[0]!)
})

test('createTerminalTabsState: closing last tab creates a fresh one', () => {
  const state = createTerminalTabsState('/project')
  const onlyId = state.tabs[0]!.id
  state.closeTab(onlyId)
  // Must not end up with zero tabs — always at least one
  assert.equal(state.tabs.length, 1)
  assert.notEqual(state.tabs[0]!.id, onlyId)
})

test('createTerminalTabsState: closeOtherTabs keeps only active', () => {
  const state = createTerminalTabsState('/project')
  state.addTab()
  state.addTab()
  const keepId = state.tabs[1]!.id
  state.activeId = keepId
  state.closeOtherTabs()
  assert.equal(state.tabs.length, 1)
  assert.equal(state.tabs[0]!.id, keepId)
})

test('createTerminalTabsState: tab titles auto-number after first', () => {
  const state = createTerminalTabsState('/project')
  assert.equal(state.tabs[0]!.title, 'bash')
  state.addTab()
  assert.equal(state.tabs[1]!.title, 'bash 2')
  state.addTab()
  assert.equal(state.tabs[2]!.title, 'bash 3')
})

test('createTerminalTabsState: setActive switches active tab', () => {
  const state = createTerminalTabsState('/project')
  state.addTab()
  const firstId = state.tabs[0]!.id
  const secondId = state.tabs[1]!.id
  state.setActive(secondId)
  assert.equal(state.activeId, secondId)
  state.setActive(firstId)
  assert.equal(state.activeId, firstId)
})

test('TerminalTab has stable unique id', () => {
  const state = createTerminalTabsState('/project')
  state.addTab()
  const ids = state.tabs.map(t => t.id)
  assert.equal(new Set(ids).size, ids.length, 'all ids unique')
})
