/**
 * disconnect-flow — /disconnect 的纯视图模型（无副作用，可单测）。
 *
 * 「一个 API key 对应一个模型组」：每个 userSaved provider 条目即一个 key
 * 注册的模型组；本模块把条目渲染成 choice-panel 列表与确认标题。删除执行
 * 在 main.ts 的 choicePanelExec（removeProvider 整组删条目 + 清密钥）。
 */

import type { ProviderConfig } from '../config/schema.js'
import type { ChoiceEntry } from './format/overlay.js'

export type DisconnectCredentialImpact =
  | { kind: 'managed-exclusive'; keyRef: string }
  | { kind: 'managed-shared'; keyRef: string; sharedWith: string[] }
  | { kind: 'environment'; variable: string }
  | { kind: 'inline-legacy' }
  | { kind: 'none' }

export interface DisconnectEntry {
  name: string
  modelCount: number
  baseUrl: string
  /** 当前默认 provider——removeProvider 守卫会拒绝，列表标注提醒先切默认。 */
  isDefault: boolean
  /** 其他 provider 引用同一 keyRef；与 removeProvider 的保留条件同构。 */
  sharedKeyWith: string[]
  credentialImpact: DisconnectCredentialImpact
  /** agent.defaultModel 指向本组——删除时由 removeProvider 一并清理。 */
  defaultModelDangling: boolean
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}

export function buildDisconnectEntries(
  providers: Record<string, ProviderConfig>,
  opts: { defaultProvider: string; defaultModelRef?: string },
): DisconnectEntry[] {
  const saved = Object.entries(providers).filter(([, p]) => p.userSaved)
  return saved.map(([name, p]) => {
    const sharedKeyWith = p.keyRef
      ? saved
          .filter(([other, candidate]) => other !== name && candidate.keyRef === p.keyRef)
          .map(([other]) => other)
      : []
    const credentialImpact: DisconnectCredentialImpact = p.keyRef
      ? (sharedKeyWith.length > 0
          ? { kind: 'managed-shared', keyRef: p.keyRef, sharedWith: sharedKeyWith }
          : { kind: 'managed-exclusive', keyRef: p.keyRef })
      : p.apiKeyEnv
        ? { kind: 'environment', variable: p.apiKeyEnv }
        : p.apiKey
          ? { kind: 'inline-legacy' }
          : { kind: 'none' }
    return {
      name,
      modelCount: p.models.length,
      baseUrl: p.baseUrl,
      isDefault: name === opts.defaultProvider,
      sharedKeyWith,
      credentialImpact,
      defaultModelDangling: !!opts.defaultModelRef && opts.defaultModelRef.startsWith(`${name}:`),
    }
  })
}

export function toChoiceEntries(entries: DisconnectEntry[]): ChoiceEntry[] {
  return entries.map(e => {
    const notes: string[] = []
    if (e.isDefault) notes.push('当前默认——选中后先改设新默认，再回来删除')
    if (e.sharedKeyWith.length > 0) notes.push(`与 ${e.sharedKeyWith.join('、')} 共用同一 key（独立删除）`)
    if (e.defaultModelDangling) notes.push('全局默认模型在此组内，删除时一并清除')
    const description = [`${e.modelCount} 个模型 · ${hostOf(e.baseUrl)}`, ...notes].join('；')
    return { id: e.name, label: e.name, description, current: e.isDefault }
  })
}

export function buildDisconnectImpactText(entry: DisconnectEntry): string {
  switch (entry.credentialImpact.kind) {
    case 'managed-exclusive':
      return `删除 provider 条目和 ${entry.modelCount} 个模型，并删除 secrets.json 中托管的 API key`
    case 'managed-shared':
      return `删除 provider 条目和 ${entry.modelCount} 个模型；API key 仍被 ${entry.credentialImpact.sharedWith.join('、')} 使用，将保留`
    case 'environment':
      return `删除 provider 条目和 ${entry.modelCount} 个模型；环境变量 ${entry.credentialImpact.variable} 不会修改`
    case 'inline-legacy':
      return `删除 provider 条目和 ${entry.modelCount} 个模型；配置中的旧鉴权信息随配置删除`
    case 'none':
      return `只删除 provider 条目和 ${entry.modelCount} 个模型`
  }
}

export function buildConfirmTitle(entry: DisconnectEntry): string {
  const dangling = entry.defaultModelDangling
    ? '\n⚠ 全局默认模型指向此组——删除时将一并清除'
    : ''
  return `断开「${entry.name}」？${buildDisconnectImpactText(entry)}，不可撤销。${dangling}`
}

export interface PostDeleteRuntimeOutcome {
  needed: boolean
  switched: boolean
  targetModel?: string
  error?: string
}

export interface PostDeleteMessage {
  text: string
  isError: boolean
}

export function buildPostDeleteMessage(
  target: string,
  removal: { modelCount: number; secretNote: string },
  runtime: PostDeleteRuntimeOutcome,
): PostDeleteMessage {
  const base = `已断开 ${target}（${removal.modelCount} 个模型）${removal.secretNote}`
  if (!runtime.needed) return { text: base, isError: false }
  if (runtime.switched) {
    return {
      text: `${base}；当前会话已切换到 ${runtime.targetModel ?? '默认模型'}`,
      isError: false,
    }
  }
  return {
    text: `${base}，但当前会话切换失败：${runtime.error ?? '未知原因'}。请运行 /model 选择可用模型。`,
    isError: true,
  }
}

export interface RetargetEntry {
  name: string
  modelCount: number
  baseUrl: string
}

/** 改设新默认的候选：除当前默认外的 userSaved provider（出厂预设一般无 key，不设默认）。 */
export function buildRetargetEntries(
  providers: Record<string, ProviderConfig>,
  currentDefault: string,
): RetargetEntry[] {
  return Object.entries(providers)
    .filter(([name, p]) => name !== currentDefault && p.userSaved && p.models.length > 0)
    .map(([name, p]) => ({ name, modelCount: p.models.length, baseUrl: p.baseUrl }))
}

export function toRetargetChoiceEntries(entries: RetargetEntry[]): ChoiceEntry[] {
  return entries.map(e => ({
    id: e.name,
    label: e.name,
    description: `${e.modelCount} 个模型 · ${hostOf(e.baseUrl)}`,
  }))
}

export function buildRetargetTitle(currentDefault: string): string {
  return `「${currentDefault}」是当前默认 provider，不可直接删除。\n请先选择新的默认 provider——改设后返回列表即可删除原默认。`
}
