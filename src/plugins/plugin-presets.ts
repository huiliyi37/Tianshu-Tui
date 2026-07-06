/**
 * First-party plugin presets — static catalog for the plugin market.
 * Mirrors the MCP_PRESETS pattern (src/mcp/presets.ts):
 * a discoverable catalog the plugin command can reference.
 *
 * Each entry describes a plugin that can be installed from the
 * repository's `plugins/` directory (local path install).
 */

export interface PluginPreset {
  id: string
  name: string
  description: string
  /** Category for filtering / discovery grid. */
  category: 'office' | 'dev' | 'productivity'
  /** Relative path from repo root (local path install source). */
  installPath: string
  /** Tools this plugin registers. */
  tools: string[]
  /** Permissions this plugin requires. */
  permissions: { fs?: boolean; net?: boolean; shell?: boolean }
}

export const PLUGIN_PRESETS: PluginPreset[] = [
  {
    id: 'office-pdf',
    name: 'PDF 办公',
    description: '真 PDF 生成（文本/标题/表格排版）+ PDF 文本抽取（读 PDF 进上下文）',
    category: 'office',
    installPath: 'plugins/office-pdf',
    tools: ['pdf_create', 'pdf_read'],
    permissions: { fs: true },
  },
  {
    id: 'office-excel',
    name: 'Excel 办公',
    description: '真 .xlsx 读写（sheet/单元格/公式值读取，表格数据写出）',
    category: 'office',
    installPath: 'plugins/office-excel',
    tools: ['xlsx_read', 'xlsx_write'],
    permissions: { fs: true },
  },
  {
    id: 'office-ppt',
    name: 'PPT 办公',
    description: '真 .pptx 生成（标题页/内容页/图文布局）',
    category: 'office',
    installPath: 'plugins/office-ppt',
    tools: ['pptx_create'],
    permissions: { fs: true },
  },
]
