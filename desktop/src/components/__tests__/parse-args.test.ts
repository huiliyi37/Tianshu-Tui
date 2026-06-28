import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs } from '../McpSettings'

describe('parseArgs (MCP argv 解析)', () => {
  it('简单空格分隔', () => {
    assert.deepEqual(parseArgs('-y @x/server /tmp'), ['-y', '@x/server', '/tmp'])
  })

  it('双引号包裹含空格的 Windows 路径作为单个参数', () => {
    // 旧 split(/\s+/) 会拆成 ['C:\\Users\\Alice\\My', 'Documents'] —— MCP 配置错乱
    const result = parseArgs('-y @x/server "C:\\Users\\Alice\\My Documents"')
    assert.deepEqual(result, ['-y', '@x/server', 'C:\\Users\\Alice\\My Documents'])
  })

  it('单引号包裹含空格路径', () => {
    assert.deepEqual(parseArgs("'/path with space/server' arg"), ['/path with space/server', 'arg'])
  })

  it('多个含空格参数混合', () => {
    assert.deepEqual(
      parseArgs('"C:\\Program Files\\node" "C:\\My Data"'),
      ['C:\\Program Files\\node', 'C:\\My Data'],
    )
  })

  it('引号内含空格、引号外正常切分', () => {
    assert.deepEqual(
      parseArgs('-y @modelcontextprotocol/server-filesystem "C:\\Users\\docs" --flag'),
      ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Users\\docs', '--flag'],
    )
  })

  it('空字符串返回空数组', () => {
    assert.deepEqual(parseArgs(''), [])
  })

  it('只有空白返回空数组', () => {
    assert.deepEqual(parseArgs('   '), [])
  })

  it('多个连续空白不产生空参数', () => {
    assert.deepEqual(parseArgs('a   b    c'), ['a', 'b', 'c'])
  })

  it('未闭合引号容忍处理（取到行尾）', () => {
    // 不应崩溃，应把后续内容作为一个参数
    assert.deepEqual(parseArgs('"unclosed path'), ['unclosed path'])
  })

  it('复现报告场景：filesystem MCP 指向含空格目录', () => {
    // 烟雾测试报错现场：Windows 用户配 filesystem MCP，路径含空格
    const result = parseArgs('-y @modelcontextprotocol/server-filesystem "C:\\Users\\Admin\\My Documents"')
    assert.equal(result.length, 3, '三个参数：flag、包名、目录')
    assert.equal(result[2], 'C:\\Users\\Admin\\My Documents', '目录路径完整不被拆分')
  })
})
