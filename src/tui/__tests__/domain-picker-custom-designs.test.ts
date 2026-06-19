import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderDomainPicker, renderModelPicker, renderThemePicker } from '../format/overlay.js'
import type { DomainPickerData, ModelPickerData, ThemePickerData } from '../format/overlay.js'
import { getTheme } from '../theme.js'

const theme = getTheme()

function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
}

describe('renderTabBar UI Integration', () => {
  it('renders standard centered Tab Bar in all three pickers', () => {
    const dData: DomainPickerData = {
      entries: [
        { key: 'auto', name: 'Auto', motto: '自动', meta: 'meta', essence: 'essence', current: true },
      ],
      selectedIndex: 0,
    }
    const mData: ModelPickerData = {
      entries: [{ id: 'gpt-5.5', alias: 'gpt-5.5', current: true }],
      selectedIndex: 0,
    }
    const tData: ThemePickerData = {
      entries: [{ name: 'cobalt', current: true, description: '钴蓝' }],
      selectedIndex: 0,
    }

    const dLines = renderDomainPicker(dData, 80, 15, theme)
    const mLines = renderModelPicker(mData, 80, 15, theme)
    const tLines = renderThemePicker(tData, 80, 15, theme)

    // All pickers should now have the centered Tab Bar indicating Domain, Model, and Theme tabs
    assert.ok(dLines.some(l => stripAnsi(l).includes('Domain') && stripAnsi(l).includes('Model') && stripAnsi(l).includes('Theme')))
    assert.ok(mLines.some(l => stripAnsi(l).includes('Domain') && stripAnsi(l).includes('Model') && stripAnsi(l).includes('Theme')))
    assert.ok(tLines.some(l => stripAnsi(l).includes('Domain') && stripAnsi(l).includes('Model') && stripAnsi(l).includes('Theme')))
  })
})

describe('renderDomainPicker Star Domain Custom Designs', () => {
  it('renders custom star domain glyph, separator and accent color', () => {
    const data: DomainPickerData = {
      entries: [
        {
          key: 'tianshu',
          name: '天枢',
          motto: '执中调度，以全貌定向',
          meta: 'methodical',
          essence: '全貌不是为了快，是为了对。',
          current: true,
          uiPersona: { separator: 'thin', accent: 'secondary', glyph: '✹' },
        },
        {
          key: 'pojun',
          name: '破军',
          motto: '好男儿当负三尺剑',
          meta: 'bold',
          essence: '直觉指向未知。',
          current: false,
          uiPersona: { separator: 'thick', accent: 'error', glyph: '✷' },
        },
      ],
      selectedIndex: 0,
    }

    const lines = renderDomainPicker(data, 80, 15, theme)
    assert.ok(lines.length > 0)
    
    // Check that Tianshu glyph is rendered in the list
    assert.ok(lines.some(l => stripAnsi(l).includes('✹')))
    // Check that Pojun glyph is rendered in the list
    assert.ok(lines.some(l => stripAnsi(l).includes('✷')))

    // Verify Tianshu divider is '─' (thin)
    const hasThinDivider = lines.some(l => stripAnsi(l).includes('───') && !stripAnsi(l).includes('✹'))
    assert.ok(hasThinDivider)

    // Verify preview area renders the glyph and motto
    assert.ok(lines.some(l => stripAnsi(l).includes('✹') && stripAnsi(l).includes('执中调度')))
  })

  it('adapts divider line for Pojun style (thick / ━)', () => {
    const data: DomainPickerData = {
      entries: [
        {
          key: 'pojun',
          name: '破军',
          motto: '好男儿当负三尺剑',
          meta: 'bold',
          essence: '直觉指向未知。',
          current: true,
          uiPersona: { separator: 'thick', accent: 'error', glyph: '✷' },
        },
      ],
      selectedIndex: 0,
    }

    const lines = renderDomainPicker(data, 80, 15, theme)
    // Pojun is selected, divider should render thick style '━'
    const hasThickDivider = lines.some(l => stripAnsi(l).includes('━━━'))
    assert.ok(hasThickDivider)
  })
})
