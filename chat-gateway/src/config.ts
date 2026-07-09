import { z } from 'zod'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const feishuConfigSchema = z.object({
  enabled: z.boolean().default(false),
  appId: z.string().optional(),
  appSecret: z.string().optional(),
  encryptKey: z.string().optional(),
  verificationToken: z.string().optional(),
})

export const wechatConfigSchema = z.object({
  enabled: z.boolean().default(false),
  appId: z.string().optional(),
  token: z.string().optional(),
  encodingAesKey: z.string().optional(),
  appSecret: z.string().optional(),
  /** 'official' | 'work' for now; 'personal' is experimental. */
  kind: z.enum(['official', 'work', 'personal']).default('official'),
  /** For personal WeChat group chats: only respond to messages starting with this prefix or @mention. */
  groupTriggerPrefix: z.string().default('@天枢 '),
  /** For personal WeChat: override the Wechaty puppet package. Default wechaty-puppet-wechat4u. */
  puppet: z.string().default('wechaty-puppet-wechat4u'),
})

export const gatewayConfigSchema = z.object({
  port: z.number().int().positive().default(7373),
  host: z.string().default('0.0.0.0'),
  /** Public HTTPS URL that IM platforms reach this gateway on. */
  publicUrl: z.string().url().optional(),
  rivet: z.object({
    baseUrl: z.string().url().default('http://127.0.0.1:41421'),
    token: z.string().optional(),
    cwd: z.string().default(process.cwd()),
  }).default({}),
  security: z.object({
    /** Require explicit allowlist entry before responding to a sender. */
    allowlistOnly: z.boolean().default(true),
    /** Allowed sender identifiers: platform:id, platform:conversation, or bare id. */
    allowlist: z.array(z.string()).default([]),
    /** Default approval mode for chat-initiated sessions. */
    approvalMode: z.enum(['manual', 'auto-safe', 'auto-accept']).default('manual'),
    /** Tools that can run without explicit user approval in chat. */
    autoApproveTools: z.array(z.string()).default([
      'read_file', 'read_section', 'grep', 'glob', 'file_info',
      'git_status', 'git_log', 'git_diff', 'web_search', 'web_fetch',
    ]),
  }).default({}),
  feishu: feishuConfigSchema.default({}),
  wechat: wechatConfigSchema.default({}),
})

export type GatewayConfig = z.infer<typeof gatewayConfigSchema>
export type FeishuConfig = z.infer<typeof feishuConfigSchema>
export type WechatConfig = z.infer<typeof wechatConfigSchema>

function defaultConfigPath(): string {
  return join(homedir(), '.rivet', 'chat-gateway.json')
}

export function loadConfig(path = defaultConfigPath()): GatewayConfig {
  if (!existsSync(path)) {
    return gatewayConfigSchema.parse({})
  }
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  return gatewayConfigSchema.parse(raw)
}

export function envAwareConfig(path = defaultConfigPath()): GatewayConfig {
  const base = loadConfig(path)
  return gatewayConfigSchema.parse({
    ...base,
    port: process.env.PORT ? Number(process.env.PORT) : base.port,
    host: process.env.HOST ?? base.host,
    publicUrl: process.env.PUBLIC_URL ?? base.publicUrl,
    rivet: {
      ...base.rivet,
      baseUrl: process.env.RIVET_BASE_URL ?? base.rivet.baseUrl,
      token: process.env.RIVET_TOKEN ?? base.rivet.token,
      cwd: process.env.RIVET_CWD ?? base.rivet.cwd,
    },
    feishu: {
      ...base.feishu,
      appId: process.env.FEISHU_APP_ID ?? base.feishu.appId,
      appSecret: process.env.FEISHU_APP_SECRET ?? base.feishu.appSecret,
      encryptKey: process.env.FEISHU_ENCRYPT_KEY ?? base.feishu.encryptKey,
      verificationToken: process.env.FEISHU_VERIFICATION_TOKEN ?? base.feishu.verificationToken,
    },
    wechat: {
      ...base.wechat,
      appId: process.env.WECHAT_APP_ID ?? base.wechat.appId,
      token: process.env.WECHAT_TOKEN ?? base.wechat.token,
      encodingAesKey: process.env.WECHAT_ENCODING_AES_KEY ?? base.wechat.encodingAesKey,
      appSecret: process.env.WECHAT_APP_SECRET ?? base.wechat.appSecret,
      kind: (process.env.WECHAT_KIND as any) ?? base.wechat.kind,
      groupTriggerPrefix: process.env.WECHAT_GROUP_TRIGGER_PREFIX ?? base.wechat.groupTriggerPrefix,
      puppet: process.env.WECHAT_PUPPET ?? base.wechat.puppet,
    },
  })
}
