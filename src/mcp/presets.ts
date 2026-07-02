/**
 * Curated MCP server presets for one-click "discover & enable" in the desktop
 * Settings UI. Mirrors the provider-preset pattern (src/config/provider-presets.ts):
 * a static catalog the server exposes via `GET /mcp/presets`, with the set of
 * already-configured ids so the UI can render an "add / configured" state.
 *
 * Presets that need secrets declare `requiredEnv` — the UI collects those keys
 * inline and passes them as the server's `env` (same plaintext-in-config
 * tradeoff as provider API keys).
 */

export interface McpPresetEnvField {
  /** Env var name passed to the MCP server process (e.g. GITHUB_PERSONAL_ACCESS_TOKEN). */
  key: string
  /** Human label for the input. */
  label: string
  /** Optional help / where to obtain the value. */
  help?: string
}

export interface McpPreset {
  id: string
  name: string
  description: string
  /** Rough grouping for the discovery grid. */
  category: 'dev' | 'productivity' | 'communication' | 'knowledge'
  transport: 'stdio' | 'sse'
  /** stdio */
  command?: string
  args?: string[]
  /** sse */
  url?: string
  /** Secrets the preset needs; collected inline and stored as `env`. */
  requiredEnv?: McpPresetEnvField[]
  /** A few representative tool names to set expectations (not exhaustive). */
  expectedTools?: string[]
  docsUrl?: string
}

export const MCP_PRESETS: McpPreset[] = [
  {
    id: 'context7',
    name: 'Context7',
    description: '实时库文档查询 —— 为编码 agent 提供最新框架/库 API 参考，减少幻觉',
    category: 'knowledge',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp'],
    expectedTools: ['resolve-library-id', 'get-library-docs'],
    docsUrl: 'https://github.com/upstash/context7',
  },
  {
    id: 'github',
    name: 'GitHub',
    description: '读写 issues / PR / 仓库文件 —— 让 agent 直接在 GitHub 上协作',
    category: 'dev',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    requiredEnv: [
      {
        key: 'GITHUB_PERSONAL_ACCESS_TOKEN',
        label: 'GitHub Personal Access Token',
        help: '在 GitHub Settings → Developer settings → Personal access tokens 生成（需 repo 权限）',
      },
    ],
    expectedTools: ['create_issue', 'get_pull_request', 'search_repositories'],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/github',
  },
  {
    id: 'slack',
    name: 'Slack',
    description: '读取频道消息、发送通知 —— agent 可在团队 Slack 中同步进展',
    category: 'communication',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    requiredEnv: [
      { key: 'SLACK_BOT_TOKEN', label: 'Slack Bot Token', help: 'xoxb- 开头的 Bot User OAuth Token' },
      { key: 'SLACK_TEAM_ID', label: 'Slack Team ID', help: '工作区 ID（T 开头）' },
    ],
    expectedTools: ['slack_post_message', 'slack_list_channels'],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/slack',
  },
  {
    id: 'notion',
    name: 'Notion',
    description: '检索与更新 Notion 页面 / 数据库 —— 把项目知识接进 agent',
    category: 'productivity',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@notionhq/notion-mcp-server'],
    requiredEnv: [
      {
        key: 'NOTION_API_KEY',
        label: 'Notion Integration Token',
        help: '在 notion.so/my-integrations 创建 internal integration 并共享目标页面',
      },
    ],
    expectedTools: ['search', 'query_database', 'update_page'],
    docsUrl: 'https://github.com/makenotion/notion-mcp-server',
  },
  {
    id: 'linear',
    name: 'Linear',
    description: '管理 Linear issues / 项目 —— agent 可创建、更新、检索任务',
    category: 'productivity',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'mcp-linear'],
    requiredEnv: [
      { key: 'LINEAR_API_KEY', label: 'Linear API Key', help: '在 Linear Settings → API → Personal API keys 生成' },
    ],
    expectedTools: ['list_issues', 'create_issue', 'update_issue'],
    docsUrl: 'https://github.com/jerhadf/linear-mcp-server',
  },
]

/** Look up a preset by id. */
export function findMcpPreset(id: string): McpPreset | undefined {
  return MCP_PRESETS.find((p) => p.id === id)
}
