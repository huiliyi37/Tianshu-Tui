import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderModelPicker, renderThemePicker } from '../format/overlay.js'
import type { ModelPickerData, ThemePickerData } from '../format/overlay.js'
import { getTheme, THEMES } from '../theme.js'

const theme = getTheme()

function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
}

describe('renderModelPicker', () => {
  it('renders border and model list', () => {
    const data: ModelPickerData = {
      entries: [
        { id: 'deepseek-chat', alias: 'deepseek-v4-pro', provider: 'deepseek', current: true, contextWindow: 64000 },
        { id: 'gpt-5.5', alias: 'gpt-5.5', provider: 'openai', current: false, contextWindow: 128000 },
      ],
      selectedIndex: 0,
    }
    const lines = renderModelPicker(data, 80, 20, theme)
    assert.ok(lines.length > 0)
    assert.ok(stripAnsi(lines[0]!).includes('│'))
    assert.ok(lines.some(l => stripAnsi(l).includes('deepseek-v4-pro')))
    assert.ok(lines.some(l => stripAnsi(l).includes('gpt-5.5')))
  })

  it('shows selected indicator and current mark', () => {
    const data: ModelPickerData = {
      entries: [
        { id: 'model-a', alias: 'Model A', provider: 'provider-a', current: false },
        { id: 'model-b', alias: 'Model B', provider: 'provider-b', current: true },
      ],
      selectedIndex: 0,
    }
    const lines = renderModelPicker(data, 80, 20, theme)
    // SelectedIndex = 0 (Model A) -> should have > cursor
    const modelALine = lines.find(l => stripAnsi(l).includes('Model A'))
    const modelBLine = lines.find(l => stripAnsi(l).includes('Model B'))
    assert.ok(modelALine && stripAnsi(modelALine).includes('>'))
    // Current = true (Model B) -> should have ● current mark
    assert.ok(modelBLine && stripAnsi(modelBLine).includes('●'))
  })

  it('shows model specs in bottom preview region', () => {
    const data: ModelPickerData = {
      entries: [
        { id: 'deepseek-chat', alias: 'deepseek-v4-pro', provider: 'deepseek', current: true, contextWindow: 64000 },
      ],
      selectedIndex: 0,
    }
    const lines = renderModelPicker(data, 80, 15, theme)
    assert.ok(lines.some(l => stripAnsi(l).includes('上下文配额: 64,000 tokens')))
    assert.ok(lines.some(l => stripAnsi(l).includes('极速先锋')))
  })
})

describe('renderThemePicker', () => {
  it('renders themes list', () => {
    const data: ThemePickerData = {
      entries: [
        { name: 'cobalt', current: true, isDefault: false, description: '钴蓝主题' },
        { name: 'gemini', current: false, isDefault: true, description: '双子星主题' },
      ],
      selectedIndex: 1,
    }
    const lines = renderThemePicker(data, 80, 20, theme)
    assert.ok(lines.length > 0)
    assert.ok(lines.some(l => stripAnsi(l).includes('cobalt')))
    assert.ok(lines.some(l => stripAnsi(l).includes('gemini')))
    // selectedIndex = 1 (gemini) -> has > cursor
    const geminiLine = lines.find(l => stripAnsi(l).includes('gemini'))
    assert.ok(geminiLine && stripAnsi(geminiLine).includes('>'))
  })

  it('renders theme details and primary/secondary color swatches', () => {
    const data: ThemePickerData = {
      entries: [
        { name: 'gemini', current: true, isDefault: false, description: '双子星独特微光渐变' },
      ],
      selectedIndex: 0,
    }
    const lines = renderThemePicker(data, 80, 15, theme)
    assert.ok(lines.some(l => stripAnsi(l).includes('双子星独特微光渐变')))
    // Test ANSI color swatch preview
    const swatchLine = lines.find(l => stripAnsi(l).includes('Accent') && stripAnsi(l).includes('Success'))
    assert.ok(swatchLine)
    assert.ok(/\x1B\[/.test(swatchLine), 'swatch preview row has ANSI color sequences')
  })
})
