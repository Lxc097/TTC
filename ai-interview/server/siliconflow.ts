/** Server-only SiliconFlow adapter. Never import this module into browser code. */
export interface SiliconFlowConfig {
  baseUrl: string
  model: string
  apiKey: string
  asrModel?: string
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatCompletion {
  choices?: Array<{ message?: { content?: string | null } }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

export const SILICONFLOW_ASR_MODEL = 'FunAudioLLM/SenseVoiceSmall'

export class SiliconFlowError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'SiliconFlowError'
  }
}

export function getSiliconFlowConfig(): SiliconFlowConfig {
  return {
    baseUrl: process.env.SILICONFLOW_BASE_URL?.trim() || 'https://api.siliconflow.cn/v1',
    model: process.env.SILICONFLOW_MODEL?.trim() || 'deepseek-ai/DeepSeek-V4-Pro',
    apiKey: process.env.SILICONFLOW_API_KEY?.trim() || '',
    asrModel: process.env.SILICONFLOW_ASR_MODEL?.trim() || SILICONFLOW_ASR_MODEL,
  }
}

function endpointUrl(baseUrl: string, endpoint: string): string {
  const url = new URL(baseUrl)
  if (url.pathname.replace(/\/+$/, '').split('/').at(-1) !== 'v1') {
    throw new Error('SILICONFLOW_BASE_URL 必须以 /v1 结尾。')
  }
  return url.toString().replace(/\/+$/, '') + '/' + endpoint
}

function safeDetail(payload: unknown, apiKey: string): string {
  const object = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null
  const error = object?.error
  const value = typeof payload === 'string' ? payload
    : typeof error === 'string' ? error
      : error && typeof error === 'object' ? (error as Record<string, unknown>).message
        : object?.message
  if (typeof value !== 'string') return ''
  return value.replaceAll(apiKey, '[密钥已隐藏]')
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, '[密钥已隐藏]')
    .replace(/<[^>]*>/g, ' ').replace(/[\r\n]+/g, ' ').trim().slice(0, 400)
}

function statusMessage(status: number): string {
  switch (status) {
    case 401: return '硅基流动认证失败（401）：密钥无效或已过期'
    case 404: return '硅基流动模型不存在或已下线（404）：请核对模型 ID'
    case 429: return '硅基流动 TPM 限流（429）：请稍后重试'
    case 503: return '硅基流动模型过载（503）：请稍后重试'
    default: return '硅基流动请求失败（HTTP ' + status + '）'
  }
}

/** One OpenAI-compatible chat completion request. No retries or hidden extra calls. */
export async function createChatCompletion(
  config: SiliconFlowConfig,
  messages: ChatMessage[],
  maxTokens: number,
): Promise<ChatCompletion> {
  if (!config.apiKey) throw new Error('SILICONFLOW_API_KEY 未设置。')
  const response = await fetch(endpointUrl(config.baseUrl, 'chat/completions'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.apiKey },
    body: JSON.stringify({ model: config.model, messages, max_tokens: maxTokens, stream: false }),
    signal: AbortSignal.timeout(30_000),
  })
  const raw = await response.text()
  let payload: unknown
  try { payload = JSON.parse(raw) as unknown }
  catch { payload = raw.slice(0, 5_000) }
  if (!response.ok) {
    const detail = safeDetail(payload, config.apiKey)
    throw new SiliconFlowError(response.status, statusMessage(response.status) + (detail ? '；上游信息：' + detail : '。'))
  }
  if (!payload || typeof payload !== 'object') throw new Error('硅基流动返回了无效的 JSON。')
  return payload as ChatCompletion
}

/** One server-side ASR request. The browser never receives the API key. */
export async function createAudioTranscription(
  config: SiliconFlowConfig, audio: Uint8Array, mimeType: string,
): Promise<string> {
  if (!config.apiKey) throw new Error('SILICONFLOW_API_KEY 未设置。')
  const extension: Record<string, string> = {
    'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a',
    'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
  }
  const filename = 'answer.' + (extension[mimeType] || 'webm')
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType }), filename)
  form.append('model', config.asrModel || SILICONFLOW_ASR_MODEL)
  const response = await fetch(endpointUrl(config.baseUrl, 'audio/transcriptions'), {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + config.apiKey },
    body: form,
    signal: AbortSignal.timeout(60_000),
  })
  const raw = await response.text()
  let payload: unknown
  try { payload = JSON.parse(raw) as unknown }
  catch { payload = raw.slice(0, 5_000) }
  if (!response.ok) {
    const detail = safeDetail(payload, config.apiKey)
    throw new SiliconFlowError(response.status, statusMessage(response.status) + (detail ? '；上游信息：' + detail : '。'))
  }
  if (!payload || typeof payload !== 'object' || typeof (payload as { text?: unknown }).text !== 'string') {
    throw new Error('硅基流动返回了无效的转录结果。')
  }
  return (payload as { text: string }).text.trim().slice(0, 5_000)
}
