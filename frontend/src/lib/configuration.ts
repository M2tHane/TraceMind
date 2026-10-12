export type ModelProtocol = 'openai_chat' | 'openai_responses' | 'anthropic'
export type RerankProtocol = 'dashscope' | 'standard'

export interface PublicModelSnapshot {
  id: string
  name: string
  model: string
  protocol: ModelProtocol
  base_url?: string
  max_tokens?: number
  timeout_seconds?: number
  json_mode?: boolean
}
export interface ModelProfile extends PublicModelSnapshot {
  base_url: string
  api_key_set: boolean
  is_default: boolean
  enabled: boolean
  max_tokens: number
  timeout_seconds: number
  json_mode: boolean
  updated_at: string
}
export interface ModelProfileInput {
  name: string
  model: string
  protocol: ModelProtocol
  base_url: string
  api_key?: string
  is_default: boolean
  enabled: boolean
  max_tokens: number
  timeout_seconds: number
  json_mode: boolean
}
export interface ServiceSettingsPatch {
  embedding?: { model?: string; base_url?: string; api_key?: string; dimensions?: number }
  rerank?: { model?: string; base_url?: string; api_key?: string; protocol?: RerankProtocol }
  mineru?: { base_url?: string }
  milvus?: { uri?: string; collection?: string }
}
export interface ConnectionTest {
  success: boolean
  detail: string
  latency_ms: number
  usage?: { total_tokens: number }
  model?: string
  protocol?: ModelProtocol
  preview?: string
}

// Empty inputs retain saved secrets; only the explicit clear control sends ''.
export function secretPatch(value: string, clear: boolean): { api_key?: string } {
  return clear ? { api_key: '' } : value.trim() ? { api_key: value.trim() } : {}
}
export const MODEL_PROTOCOLS: { value: ModelProtocol; label: string }[] = [
  { value: 'openai_chat', label: 'OpenAI Chat Completions' },
  { value: 'openai_responses', label: 'OpenAI Responses' },
  { value: 'anthropic', label: 'Anthropic Messages' },
]
