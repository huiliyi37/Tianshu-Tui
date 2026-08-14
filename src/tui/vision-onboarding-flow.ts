/**
 * Pure state machine for configuring the optional image-recognition bridge.
 * The engine executes returned server request descriptors; this flow never
 * reads credentials from disk, sends network traffic, or writes configuration.
 */

export interface VisionCandidate {
  id: string
  label?: string
  knownVision: boolean
}

export interface VisionOnboardingView {
  kind: 'input' | 'choice' | 'busy'
  title: string
  subtitle?: string
  stepLabel?: string
  masked?: boolean
  placeholder?: string
  options?: Array<{ id: string; label: string; description?: string }>
}

export type VisionOnboardingRequest =
  | { kind: 'discover'; body: { baseUrl: string; providerName?: string; apiKey?: string; apiKeyEnv?: string } }
  | { kind: 'onboard'; body: { baseUrl: string; providerName: string; modelId: string; apiKey?: string; apiKeyEnv?: string } }

export type VisionOnboardingResult =
  | { kind: 'next'; view: VisionOnboardingView }
  | { kind: 'request'; request: VisionOnboardingRequest }
  | { kind: 'error'; message: string; view: VisionOnboardingView }
  | { kind: 'done'; summary: string }

type Phase = 'base-url' | 'provider-name' | 'credential-kind' | 'credential' | 'discovering' | 'candidate' | 'onboarding' | 'success'
type CredentialKind = 'apiKey' | 'apiKeyEnv'

export class VisionOnboardingFlow {
  private phase: Phase = 'base-url'
  private baseUrl?: string
  private providerName?: string
  private credentialKind: CredentialKind = 'apiKey'
  private credential?: string
  private candidates: VisionCandidate[] = []
  private selectedModelId?: string

  view(): VisionOnboardingView {
    switch (this.phase) {
      case 'base-url': return { kind: 'input', title: '配置识图桥', subtitle: '输入视觉服务 endpoint；不会改变主模型服务商', stepLabel: '步骤 1 / 5', placeholder: 'https://api.example.com/v1' }
      case 'provider-name': return { kind: 'input', title: '配置识图桥', subtitle: '为这个专用视觉服务命名', stepLabel: '步骤 2 / 5', placeholder: 'vision-custom' }
      case 'credential-kind': return { kind: 'choice', title: '配置识图桥', subtitle: '选择凭证来源', stepLabel: '步骤 3 / 5', options: [
        { id: 'apiKey', label: '粘贴 API Key', description: '仅保存到 secrets.json，配置文件不保存明文' },
        { id: 'apiKeyEnv', label: '环境变量名', description: '服务端进程读取变量值；只保存变量名' },
      ] }
      case 'credential': return { kind: 'input', title: '配置识图桥', subtitle: this.credentialKind === 'apiKey' ? '输入 API Key' : '输入服务端进程可见的环境变量名', stepLabel: '步骤 4 / 5', masked: this.credentialKind === 'apiKey', placeholder: this.credentialKind === 'apiKey' ? 'sk-...' : 'VISION_API_KEY' }
      case 'discovering': return { kind: 'busy', title: '配置识图桥', subtitle: '正在从服务端发现可用模型...' }
      case 'candidate': return { kind: 'choice', title: '配置识图桥', subtitle: '只可选择服务端刚刚发现的模型；随后将发送一张测试图片验证', stepLabel: '步骤 5 / 5', options: this.candidates.map(candidate => ({ id: candidate.id, label: candidate.id, ...(candidate.label ? { description: candidate.label } : {}) })) }
      case 'onboarding': return { kind: 'busy', title: '配置识图桥', subtitle: '正在验证图片识别并保存桥接配置...' }
      case 'success': return { kind: 'busy', title: '识图桥已配置', subtitle: `${this.providerName}:${this.selectedModelId}` }
    }
  }

  submit(value: string): VisionOnboardingResult {
    const input = value.trim()
    if (this.phase === 'base-url') {
      if (!/^https?:\/\/\S+$/i.test(input)) return this.error('请输入有效的 http(s) endpoint')
      this.baseUrl = input
      this.phase = 'provider-name'
      return this.next()
    }
    if (this.phase === 'provider-name') {
      if (!input) return this.error('provider 名称不能为空')
      this.providerName = input
      this.phase = 'credential-kind'
      return this.next()
    }
    if (this.phase === 'credential') {
      if (!input) return this.error(this.credentialKind === 'apiKey' ? 'API Key 不能为空' : '环境变量名不能为空')
      this.credential = input
      this.phase = 'discovering'
      return { kind: 'request', request: { kind: 'discover', body: this.discoveryBody() } }
    }
    return this.error('当前步骤不接受文本输入')
  }

  choose(id: string): VisionOnboardingResult {
    if (this.phase === 'credential-kind') {
      if (id !== 'apiKey' && id !== 'apiKeyEnv') return this.error('未知凭证来源')
      this.credentialKind = id
      this.phase = 'credential'
      return this.next()
    }
    if (this.phase === 'candidate') {
      if (!this.candidates.some(candidate => candidate.id === id)) return this.error('只能选择服务端发现的模型')
      this.selectedModelId = id
      this.phase = 'onboarding'
      return { kind: 'request', request: { kind: 'onboard', body: { ...this.discoveryBody(), providerName: this.providerName!, modelId: id } } }
    }
    return this.error('当前步骤不接受选择')
  }

  applyDiscovery(candidates: VisionCandidate[]): VisionOnboardingResult {
    if (this.phase !== 'discovering') return this.error('没有进行中的模型发现请求')
    if (candidates.length === 0) return this.error('服务端没有返回可用模型')
    this.candidates = candidates.map(candidate => ({ ...candidate }))
    this.phase = 'candidate'
    return this.next()
  }

  requestFailed(message: string): VisionOnboardingResult {
    if (this.phase === 'discovering') this.phase = 'credential'
    else if (this.phase === 'onboarding') this.phase = 'candidate'
    return this.error(message)
  }

  applyOnboardSuccess(): VisionOnboardingResult {
    if (this.phase !== 'onboarding') return this.error('没有进行中的验证请求')
    this.phase = 'success'
    return { kind: 'done', summary: `识图桥已保存：${this.providerName}:${this.selectedModelId}` }
  }

  private discoveryBody(): { baseUrl: string; providerName: string; apiKey?: string; apiKeyEnv?: string } {
    return {
      baseUrl: this.baseUrl!,
      providerName: this.providerName!,
      ...(this.credentialKind === 'apiKey' ? { apiKey: this.credential! } : { apiKeyEnv: this.credential! }),
    }
  }

  private next(): VisionOnboardingResult { return { kind: 'next', view: this.view() } }
  private error(message: string): VisionOnboardingResult { return { kind: 'error', message, view: this.view() } }
}
